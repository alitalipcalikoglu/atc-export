import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakeUpstream, testSystem } from './helpers.js';

/** @type {Awaited<ReturnType<typeof fakeUpstream>>} */ let up;
before(async () => { up = await fakeUpstream(); });
after(() => up.close());

test('worker: CSV export streamed into a private media file, progress, e-mail, download, delete', async () => {
  const { service, worker, jobs } = testSystem(up.url);
  const j = service.create({ source: 'atc-auth', format: 'csv', notifyEmail: 'ops@example.com' }, 'console');
  await worker.tick();
  const done = /** @type {any} */ (jobs.get(j.id));
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.rows, 7);
  const file = up.state.files.get(done.file_id);
  assert.ok(file);
  assert.match(file.name, /^auth-export-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}\.csv$/);
  assert.equal(done.bytes, Buffer.byteLength(file.body));
  const lines = file.body.split('\r\n');
  assert.equal(lines[0], 'id,email,name,status,emailVerified,emailVerifiedAt,lockedUntil,passwordChangedAt,createdAt,updatedAt');
  assert.match(lines[1], /^u1,user1@example.com,"'=HYPERLINK\(""x""\)",active,true,,,,/, 'formula guarded and quoted');
  assert.match(lines[2], /^u2,user2@example.com,"User, ""2""",/);
  assert.equal(lines.length, 9, 'header + 7 rows + trailing empty');
  const put = up.state.seen.find((s) => s.method === 'PUT');
  assert.match(String(put?.url), /^\/v1\/files\?visibility=private&name=/);
  assert.equal(up.state.mails.length, 1);
  assert.deepEqual([up.state.mails[0].template, up.state.mails[0].to, up.state.mails[0].idempotencyKey], ['generic', ['ops@example.com'], `atc-export:${j.id}:1`]);
  assert.equal(/** @type {any} */ (jobs.get(j.id)).notify_status, 'sent');
  const dl = await service.download(j.id);
  assert.deepEqual(dl, { url: `http://media.test/files/${done.file_id}/original?sig=x`, expiresAt: '2030-01-01T00:00:00.000Z' });
  assert.ok(up.state.seen.some((s) => s.url === `/v1/files/${done.file_id}/urls?ttl=300`));
  await service.delete(j.id);
  assert.equal(jobs.get(j.id), undefined);
  assert.equal(up.state.files.has(done.file_id), false, 'media file removed with the job');
});

test('worker: NDJSON, empty NDJSON has no file, caps fail the export, failed mail keeps success', async () => {
  const { service, worker, jobs } = testSystem(up.url, { EXPORT_MAX_ROWS: '5' });
  const audit = service.create({ source: 'atc-audit', format: 'ndjson' }, 'x');
  await worker.tick();
  const a = /** @type {any} */ (jobs.get(audit.id));
  assert.equal(a.status, 'succeeded');
  assert.deepEqual(up.state.files.get(a.file_id)?.body.trim().split('\n').map((l) => JSON.parse(l).seq), [1, 2, 3]);
  const empty = service.create({ source: 'atc-content', format: 'ndjson', filters: { namespace: 'web', locale: 'en' } }, 'x');
  const before = up.state.files.size;
  up.state.keys = up.state.keys.map((k) => ({ ...k, values: { ...k.values, 'tr-CY': 'x' } }));
  const emptyTr = service.create({ source: 'atc-content', format: 'ndjson', filters: { namespace: 'web', locale: 'tr-CY', missing: 'true' } }, 'x');
  await worker.tick();
  assert.equal(/** @type {any} */ (jobs.get(emptyTr.id)).status, 'succeeded');
  assert.equal(/** @type {any} */ (jobs.get(emptyTr.id)).file_id, null);
  assert.equal(up.state.files.size, before + 1, 'only the non-empty content export uploaded');
  assert.equal(/** @type {any} */ (jobs.get(empty.id)).rows, 2);
  const big = service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  await worker.tick();
  const b = /** @type {any} */ (jobs.get(big.id));
  assert.deepEqual([b.status, b.error_code, b.attempts], ['failed', 'TOO_MANY_ROWS', 1], 'caps are not retried');
  const tiny = testSystem(up.url, { EXPORT_MAX_BYTES: '1024' });
  up.state.users.push(...Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, email: `x${i}@example.com`, name: 'n'.repeat(40) })));
  const t = tiny.service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  await tiny.worker.tick();
  assert.equal(/** @type {any} */ (tiny.jobs.get(t.id)).error_code, 'TOO_LARGE');
  up.state.users.splice(7);
  up.state.mailStatus = 500;
  const m = tiny.service.create({ source: 'atc-auth', format: 'csv', notifyEmail: 'a@b.co' }, 'x');
  await tiny.worker.tick();
  assert.deepEqual([/** @type {any} */ (tiny.jobs.get(m.id)).status, /** @type {any} */ (tiny.jobs.get(m.id)).notify_status], ['succeeded', 'failed']);
  up.state.mailStatus = 0;
});

test('worker: transient failures retry with backoff, permanent ones fail, retry() starts over', async () => {
  let now = 1_800_000_000_000;
  const { service, worker, jobs } = testSystem(up.url, { MAX_ATTEMPTS: '2' }, { now: () => now });
  const j = service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  up.state.failUsers = 99;
  await worker.tick();
  let r = /** @type {any} */ (jobs.get(j.id));
  assert.deepEqual([r.status, r.attempts, r.error_code, r.next_run_at - now], ['queued', 1, 'UPSTREAM_ERROR', 30_000]);
  await worker.tick();
  assert.equal(/** @type {any} */ (jobs.get(j.id)).attempts, 1, 'not due yet');
  now += 30_000;
  await worker.tick();
  r = /** @type {any} */ (jobs.get(j.id));
  assert.deepEqual([r.status, r.attempts], ['failed', 2]);
  up.state.failUsers = 0;
  up.state.uploadStatus = 415;
  const k = service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  await worker.tick();
  assert.deepEqual([/** @type {any} */ (jobs.get(k.id)).status, /** @type {any} */ (jobs.get(k.id)).error_code], ['failed', 'MEDIA_ERROR'], '4xx from media is permanent');
  up.state.uploadStatus = 0;
  service.retry(j.id);
  await worker.tick();
  r = /** @type {any} */ (jobs.get(j.id));
  assert.deepEqual([r.status, r.attempts, r.rows, r.error_code], ['succeeded', 1, 7, null]);
});

test('worker: cancel mid-run stops the stream and records cancelled; nothing is stored', async () => {
  const { service, worker, jobs } = testSystem(up.url, { HEARTBEAT_MS: '1000' });
  up.state.slowMs = 400;
  const j = service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  const files = up.state.files.size;
  const run = worker.tick();
  await sleep(150);
  assert.equal(/** @type {any} */ (jobs.get(j.id)).status, 'running');
  service.cancel(j.id);
  await run;
  up.state.slowMs = 0;
  const r = /** @type {any} */ (jobs.get(j.id));
  assert.equal(r.status, 'cancelled');
  assert.equal(r.file_id, null);
  assert.equal(up.state.files.size, files, 'aborted upload stored nothing');
});

test('worker: crash recovery requeues interrupted jobs, exhausted ones fail; stale owners are fenced', async () => {
  const sys = testSystem(up.url, { MAX_ATTEMPTS: '2' });
  const a = sys.service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  const b = sys.service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  const now = Date.now();
  const [ca] = sys.jobs.claim(now, 1, 5000);
  sys.jobs.requeue(ca.id, /** @type {string} */ (ca.owner_token), now, { code: 'X', message: 'x' }, now);
  const [ca2, cb] = sys.jobs.claim(now, 2, 5000);
  assert.deepEqual([ca2.id, ca2.attempts, cb.id], [a.id, 2, b.id]);
  // Process "crashes" here; a new worker starts against the same database.
  const recovered = sys.worker.recover();
  assert.deepEqual(recovered.map((x) => [x.id, x.outcome]).sort(), [[a.id, 'failed'], [b.id, 'queued']].sort());
  assert.equal(sys.jobs.succeed(cb.id, /** @type {string} */ (cb.owner_token), { rows: 1, bytes: 1, fileId: 'f', fileName: 'n' }, now), false, 'old owner can no longer write');
  await sys.worker.tick();
  assert.equal(/** @type {any} */ (sys.jobs.get(b.id)).status, 'succeeded');
  // Expired lease while "running" (hung worker) is reclaimed in the loop.
  const c = sys.service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  const [cc] = sys.jobs.claim(now, 1, 1);
  assert.equal(cc.id, c.id);
  assert.deepEqual(sys.jobs.reclaimExpired(now + 10, 'lease expired'), [{ id: c.id, outcome: 'queued' }]);
});

test('worker: shutdown hands running jobs back without counting the attempt', async () => {
  const sys = testSystem(up.url, { POLL_MS: '50' });
  up.state.slowMs = 300;
  const j = sys.service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  sys.worker.start();
  await sleep(120);
  assert.equal(/** @type {any} */ (sys.jobs.get(j.id)).status, 'running');
  await sys.worker.stop();
  up.state.slowMs = 0;
  const r = /** @type {any} */ (sys.jobs.get(j.id));
  assert.deepEqual([r.status, r.attempts, r.owner_token], ['queued', 0, null]);
});

test('retention: finished jobs and their files are purged after EXPORT_RETENTION_DAYS', async () => {
  let now = 1_900_000_000_000;
  const sys = testSystem(up.url, { EXPORT_RETENTION_DAYS: '7' }, { now: () => now });
  sys.worker.lastMaintenance = now;
  const old = sys.service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  await sys.worker.tick();
  const fileId = /** @type {string} */ (/** @type {any} */ (sys.jobs.get(old.id)).file_id);
  now += 8 * 86_400_000;
  const fresh = sys.service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  sys.worker.lastMaintenance = now;
  await sys.worker.tick();
  const queued = sys.service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  // The queued job and the fresh one stay; the 8-day-old one goes with its file.
  sys.worker.lastMaintenance = now; // keep the loop's own hourly purge out of this test
  await sys.worker.purge(now);
  assert.equal(sys.jobs.get(old.id), undefined);
  assert.ok(sys.jobs.get(fresh.id));
  assert.ok(sys.jobs.get(queued.id));
  assert.equal(up.state.files.has(fileId), false);
  assert.ok(up.state.deleted.includes(fileId));
});

test('worker: a transient failure mid-run resumes from the last page instead of starting over', async () => {
  let now = 1_800_000_000_000;
  const { service, worker, jobs, config } = testSystem(up.url, { REQUEST_RETRIES: '0' }, { now: () => now });
  const j = service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  up.state.failCursor = '6';
  await worker.tick();
  let r = /** @type {any} */ (jobs.get(j.id));
  assert.deepEqual([r.status, r.checkpoint_rows, r.checkpoint_cursor], ['queued', 6, '6'], 'two pages of three are checkpointed');
  const spool = join(config.worker.spoolDir, `${j.id}.csv`);
  assert.equal(existsSync(spool), true);
  up.state.failCursor = '';
  up.state.seen = [];
  now += 30_000;
  await worker.tick();
  r = /** @type {any} */ (jobs.get(j.id));
  assert.equal(r.status, 'succeeded', r.error);
  assert.equal(r.rows, 7);
  const userCalls = up.state.seen.filter((x) => x.url.startsWith('/v1/users'));
  assert.deepEqual(userCalls.map((x) => new URL(x.url, 'http://x').searchParams.get('cursor')), ['6'], 'only the missing page was read');
  const body = /** @type {any} */ (up.state.files.get(r.file_id)).body;
  assert.equal(body.split('\r\n').length, 9, 'header + 7 rows, nothing duplicated');
  assert.deepEqual(body.split('\r\n').slice(1, 8).map((/** @type {string} */ l) => l.split(',')[0]), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
  assert.equal(existsSync(spool), false, 'spool removed after success');
  assert.equal(r.checkpoint_bytes, null);
  assert.equal(worker.counters.resumed, 1);
});

test('worker: a missing spool file restarts the export; purge removes orphan spool files', async () => {
  let now = 1_800_000_000_000;
  const { service, worker, jobs, config } = testSystem(up.url, { REQUEST_RETRIES: '0' }, { now: () => now });
  const j = service.create({ source: 'atc-auth', format: 'csv' }, 'x');
  up.state.failCursor = '3';
  await worker.tick();
  assert.equal(/** @type {any} */ (jobs.get(j.id)).checkpoint_rows, 3);
  for (const f of readdirSync(config.worker.spoolDir)) writeFileSync(join(config.worker.spoolDir, f), ''); // shorter than the checkpoint
  up.state.failCursor = '';
  now += 30_000;
  await worker.tick();
  const r = /** @type {any} */ (jobs.get(j.id));
  assert.deepEqual([r.status, r.rows], ['succeeded', 7]);
  assert.equal(worker.counters.resumed, 0);
  writeFileSync(join(config.worker.spoolDir, 'gone.csv'), 'x');
  await worker.purge(now);
  assert.deepEqual(readdirSync(config.worker.spoolDir), []);
});
