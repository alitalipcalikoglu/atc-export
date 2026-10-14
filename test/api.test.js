import { AuditClient } from '@atc-web/atc-service-core/audit';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { READ_KEY, RW_KEY, WRITE_KEY, bearer, buildApp, fakeUpstream } from './helpers.js';

const json = (/** @type {import('light-my-request').Response} */ r) => JSON.parse(r.body);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
/** @type {Awaited<ReturnType<typeof fakeUpstream>>} */ let up;
before(async () => { up = await fakeUpstream(); });
after(() => up.close());

test('API: probes, info, openapi, auth and roles', async (t) => {
  const { app } = await buildApp(up.url);
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  assert.deepEqual(json(await app.inject({ url: '/ready' })), { status: 'ok', worker: 'stopped' });
  assert.equal((await app.inject({ url: '/openapi.yaml' })).body, readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  const info = json(await app.inject({ url: '/v1/info' }));
  assert.deepEqual([info.service, info.version, info.apiVersion], ['atc-export', PACKAGE_VERSION, 'v1']);
  assert.deepEqual(info.capabilities, ['csv', 'ndjson', 'leased-worker', 'media-storage', 'email-notification', 'source:atc-audit', 'source:atc-auth', 'source:atc-content']);
  assert.equal((await app.inject({ url: '/v1/exports' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/exports', headers: bearer(WRITE_KEY) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/exports', headers: bearer(READ_KEY), payload: { source: 'atc-auth', format: 'csv' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/metrics', headers: bearer(WRITE_KEY) })).statusCode, 403);
  const sources = json(await app.inject({ url: '/v1/sources', headers: bearer(READ_KEY) }));
  assert.deepEqual(sources.items.map((/** @type {any} */ s) => s.id), ['atc-audit', 'atc-auth', 'atc-content']);
  assert.equal(sources.items.find((/** @type {any} */ s) => s.id === 'atc-content').filters.namespace.required, true);
});

test('API: create, list, get, download, cancel, retry, delete, stats, metrics', async (t) => {
  const { app, worker } = await buildApp(up.url);
  t.after(() => app.close());
  const h = bearer(RW_KEY);
  let res = await app.inject({ method: 'POST', url: '/v1/exports', headers: h, payload: { source: 'atc-auth', format: 'csv', notifyEmail: 'ops@example.com' } });
  assert.equal(res.statusCode, 202, res.body);
  const e = json(res).export;
  assert.equal(res.headers.location, `/v1/exports/${e.id}`);
  assert.deepEqual([e.status, e.source, e.format, e.filters, e.notifyEmail, e.progress, e.file, e.createdBy], ['queued', 'atc-auth', 'csv', {}, 'ops@example.com', { rows: 0, bytes: 0 }, null, 'console']);
  assert.equal(json(await app.inject({ method: 'POST', url: '/v1/exports', headers: h, payload: { source: 'atc-flags', format: 'csv' } })).error.code, 'UNKNOWN_SOURCE');
  assert.equal(json(await app.inject({ method: 'POST', url: '/v1/exports', headers: h, payload: { source: 'atc-content', format: 'csv', filters: { locale: 'en' } } })).error.code, 'INVALID_FILTER');
  assert.equal(json(await app.inject({ method: 'POST', url: '/v1/exports', headers: h, payload: { source: 'atc-auth', format: 'xlsx' } })).error.code, 'VALIDATION_FAILED');
  assert.equal(json(await app.inject({ url: `/v1/exports/${e.id}/download`, headers: h })).error.code, 'NO_FILE');
  await worker.tick();
  res = await app.inject({ url: `/v1/exports/${e.id}`, headers: bearer(READ_KEY) });
  const done = json(res).export;
  assert.deepEqual([done.status, done.progress.rows, done.notification, done.attempts], ['succeeded', 7, 'sent', 1]);
  assert.match(done.file.name, /\.csv$/);
  assert.ok(Date.parse(done.expiresAt) - Date.parse(done.finishedAt) === 7 * 86_400_000);
  res = await app.inject({ url: `/v1/exports/${e.id}/download`, headers: bearer(READ_KEY) });
  assert.match(json(res).url, /^http:\/\/media\.test\/files\/f\d+\/original\?sig=x$/);
  assert.equal(json(await app.inject({ method: 'POST', url: `/v1/exports/${e.id}/cancel`, headers: h })).error.code, 'INVALID_STATE');
  assert.equal(json(await app.inject({ method: 'POST', url: `/v1/exports/${e.id}/retry`, headers: h })).error.code, 'INVALID_STATE');

  res = await app.inject({ method: 'POST', url: '/v1/exports', headers: h, payload: { source: 'atc-audit', format: 'ndjson', filters: { outcome: 'success' } } });
  const q = json(res).export;
  assert.equal(json(await app.inject({ method: 'POST', url: `/v1/exports/${q.id}/cancel`, headers: h })).export.status, 'cancelled');
  assert.equal(json(await app.inject({ method: 'POST', url: `/v1/exports/${q.id}/retry`, headers: h })).export.status, 'queued');
  let list = json(await app.inject({ url: '/v1/exports?limit=1', headers: h }));
  assert.deepEqual([list.items.map((/** @type {any} */ x) => x.id), list.nextCursor], [[q.id], q.id]);
  list = json(await app.inject({ url: `/v1/exports?limit=1&cursor=${list.nextCursor}`, headers: h }));
  assert.deepEqual([list.items.map((/** @type {any} */ x) => x.id), list.nextCursor], [[e.id], null]);
  assert.deepEqual(json(await app.inject({ url: '/v1/exports?status=succeeded', headers: h })).items.map((/** @type {any} */ x) => x.id), [e.id]);
  assert.equal((await app.inject({ url: '/v1/exports?status=done', headers: h })).statusCode, 400);
  assert.equal((await app.inject({ url: '/v1/exports/nope', headers: h })).statusCode, 400);
  assert.equal((await app.inject({ url: `/v1/exports/exp_${'0'.repeat(9)}${'a'.repeat(12)}`, headers: h })).statusCode, 404);

  const st = json(await app.inject({ url: '/v1/stats', headers: h }));
  assert.deepEqual([st.queued, st.running, st.total, st.last24h.succeeded, st.last24h.rows, st.retentionDays], [1, 0, 2, 1, 7, 7]);
  assert.ok(st.last24h.bytes > 0 && st.storedBytes === st.last24h.bytes);
  const m = (await app.inject({ url: '/metrics', headers: bearer(READ_KEY) })).body;
  assert.match(m, /^export_jobs\{status="queued"\} 1$/m);
  assert.match(m, /^export_jobs_finished_24h\{outcome="succeeded"\} 1$/m);
  assert.match(m, /^export_worker_events_total\{event="succeeded"\} 1$/m);

  const fileCount = up.state.files.size;
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/exports/${e.id}`, headers: h })).statusCode, 204);
  assert.equal(up.state.files.size, fileCount - 1, 'file removed from media');
  assert.equal((await app.inject({ url: `/v1/exports/${e.id}`, headers: h })).statusCode, 404);
});

test('API: rate limit per key', async (t) => {
  const { app } = await buildApp(up.url, { RATE_LIMIT_MAX: '2' });
  t.after(() => app.close());
  await app.inject({ url: '/v1/sources', headers: bearer(READ_KEY) });
  await app.inject({ url: '/v1/sources', headers: bearer(READ_KEY) });
  const r = await app.inject({ url: '/v1/sources', headers: bearer(READ_KEY) });
  assert.deepEqual([r.statusCode, json(r).error.code], [429, 'RATE_LIMITED']);
});

test('API: X-Actor names the creator only for ACTOR_KEYS keys', async (t) => {
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: { warn() {}, error() {} }, fetch: async () => new Response('{}', { status: 200 }) });
  const { app } = await buildApp(up.url, { ACTOR_KEYS: 'console' }, { audit });
  t.after(() => app.close());
  let res = await app.inject({ method: 'POST', url: '/v1/exports', headers: { ...bearer(RW_KEY), 'x-actor': 'ayse.k' }, payload: { source: 'atc-auth', format: 'csv' } });
  assert.equal(json(res).export.createdBy, 'ayse.k');
  res = await app.inject({ method: 'POST', url: '/v1/exports', headers: { ...bearer(WRITE_KEY), 'x-actor': 'ayse.k' }, payload: { source: 'atc-auth', format: 'csv' } });
  assert.equal(json(res).export.createdBy, 'ops');
  const [named, plain] = audit.buffer;
  assert.deepEqual([named.actor, /** @type {any} */ (named.meta)?.via], [{ type: 'admin', id: 'ayse.k' }, 'console'], 'audit names the admin, the key stays in meta.via');
  assert.deepEqual([plain.actor?.type, /** @type {any} */ (plain.meta)?.via], ['apikey', undefined]);
});
