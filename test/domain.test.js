import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Encoder } from '../src/domain/encoder.js';
import { ExportError } from '../src/domain/errors.js';
import { ServiceHttp } from '../src/net/service-http.js';
import { fakeUpstream, testSystem } from './helpers.js';

/** @param {string} code */
const fails = (code) => (/** @type {unknown} */ e) => e instanceof ExportError && e.code === code;
/** @type {Awaited<ReturnType<typeof fakeUpstream>>} */ let up;
before(async () => { up = await fakeUpstream(); });
after(() => up.close());

test('Encoder: RFC 4180 quoting, formula-injection guard, types, control characters', () => {
  assert.equal(Encoder.cell('plain'), 'plain');
  assert.equal(Encoder.cell('a,b'), '"a,b"');
  assert.equal(Encoder.cell('say "hi"'), '"say ""hi"""');
  assert.equal(Encoder.cell('two\nlines'), '"two\nlines"');
  assert.equal(Encoder.cell(' padded'), '" padded"');
  for (const s of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx']) assert.equal(Encoder.cell(s).replace(/^"/, '')[0], "'", s);
  assert.equal(Encoder.cell('=1,2'), '"\'=1,2"');
  assert.equal(Encoder.cell(-5), '-5', 'numbers are data, not formulas');
  assert.equal(Encoder.cell(true), 'true');
  assert.equal(Encoder.cell(null), '');
  assert.equal(Encoder.cell(['a', 'b']), '"[""a"",""b""]"');
  assert.equal(Encoder.cell('bell\u0007end'), 'bellend');
  assert.equal(Encoder.cell('\u0001=1+1'), "'=1+1", 'control characters cannot hide a formula');
  assert.equal(Encoder.cell(' =1+1'), "' =1+1", 'leading whitespace before a formula sign');
  assert.equal(Encoder.cell('\t=1'), "'\t=1");
  assert.equal(Encoder.cell('\r@x'), "\"'\r@x\"");
  assert.equal(Encoder.cell('-5'), "'-5", 'a string that looks like a negative number is still a string');
  assert.equal(Encoder.cell({ a: '=1' }), '"{""a"":""=1""}"', 'JSON starts with { so it is never a formula');
  const csv = new Encoder('csv', ['a', 'b']);
  assert.equal(csv.header() + csv.line({ a: 1, b: 'x' }), 'a,b\r\n1,x\r\n');
  const nd = new Encoder('ndjson', ['a']);
  assert.equal(nd.header() + nd.line({ a: '=1', z: { n: 1 } }), '{"a":"=1","z":{"n":1}}\n', 'NDJSON is not guarded: it is not opened by spreadsheets');
});

test('sources: only configured ones, filter validation, cursor paging, NDJSON stream reassembly', async () => {
  const { sources } = testSystem(up.url);
  assert.deepEqual(sources.list().map((s) => s.id), ['atc-audit', 'atc-auth', 'atc-content']);
  assert.throws(() => sources.get('atc-flags'), fails('UNKNOWN_SOURCE'));
  const users = sources.get('atc-auth');
  assert.throws(() => users.validate({ nope: 'x' }), fails('INVALID_FILTER'));
  assert.throws(() => users.validate({ email: 'not-mail' }), fails('INVALID_FILTER'));
  assert.throws(() => users.validate({ email: 3 }), fails('INVALID_FILTER'));
  assert.throws(() => users.validate([]), fails('INVALID_FILTER'));
  assert.deepEqual(users.validate({ email: '' }), {});
  const content = sources.get('atc-content');
  assert.throws(() => content.validate({ locale: 'en' }), fails('INVALID_FILTER'), 'namespace is required');
  assert.deepEqual(content.validate({ namespace: 'web', locale: 'tr-cy' }), { namespace: 'web', locale: 'tr-CY' });
  assert.throws(() => sources.get('atc-audit').validate({ outcome: 'meh' }), fails('INVALID_FILTER'));
  assert.throws(() => sources.get('atc-audit').validate({ from: 'yesterday' }), fails('INVALID_FILTER'));

  const signal = new AbortController().signal;
  const rows = [];
  for await (const r of users.rows({}, signal)) rows.push(r);
  assert.deepEqual(rows.map((r) => r.id), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'], 'three pages followed by cursor');
  assert.ok(up.state.seen.some((s) => s.url === '/v1/users?limit=100&cursor=3'));
  assert.equal(up.state.seen.at(-1)?.auth, `Bearer ${'u'.repeat(40)}`);
  const events = [];
  for await (const r of sources.get('atc-audit').rows({ source: 'atc-auth' }, signal)) events.push(r);
  assert.deepEqual(events.map((e) => [e.seq, e.actorType, e.actorId]), [[1, 'user', 'u0'], [2, 'user', 'u1'], [3, 'user', 'u2']]);
  assert.ok(up.state.seen.some((s) => s.url === '/v1/events/export?source=atc-auth&format=ndjson'));
  const keys = [];
  for await (const r of content.rows({ namespace: 'web', locale: 'tr-CY', missing: 'true' }, signal)) keys.push(r);
  assert.deepEqual(keys, [{ key: 'cart', description: '', value: null, placeholders: ['count'], mismatched: false, updatedAt: '2026-01-01T00:00:00.000Z' }]);
  assert.ok(up.state.seen.some((s) => s.url === '/v1/namespaces/web/keys?missing=tr-CY&limit=200'));
});

test('ServiceHttp: retries transient statuses with backoff, fails fast on 4xx', async () => {
  const { sources } = testSystem(up.url);
  const signal = new AbortController().signal;
  up.state.failUsers = 2;
  const ok = [];
  for await (const r of sources.get('atc-auth').rows({}, signal)) ok.push(r);
  assert.equal(ok.length, 7, 'two 503s absorbed by REQUEST_RETRIES=2');
  up.state.failUsers = 3;
  await assert.rejects(async () => { for await (const _ of sources.get('atc-auth').rows({}, signal)); }, (e) => fails('UPSTREAM_ERROR')(e) && /** @type {ExportError} */ (e).transient);
  up.state.failUsers = 0;
  up.state.usersStatus = 403;
  await assert.rejects(async () => { for await (const _ of sources.get('atc-auth').rows({}, signal)); }, (e) => fails('UPSTREAM_ERROR')(e) && !/** @type {ExportError} */ (e).transient && /nope/.test(/** @type {Error} */ (e).message));
  up.state.usersStatus = 0;
  assert.equal(ServiceHttp.transient(429), true);
  assert.equal(ServiceHttp.transient(404), false);
  assert.equal(ServiceHttp.backoffMs(10), 10_000);
});

test('ExportService: create validation, cancel/retry/delete state rules, download needs a file', async () => {
  const { service, jobs } = testSystem(up.url);
  assert.throws(() => service.create({ source: 'atc-flags', format: 'csv' }, 'x'), fails('UNKNOWN_SOURCE'));
  assert.throws(() => service.create({ source: 'atc-auth', format: 'csv', filters: { x: '1' } }, 'x'), fails('INVALID_FILTER'));
  const j = service.create({ source: 'atc-auth', format: 'csv', notifyEmail: 'ops@example.com' }, 'console');
  assert.match(j.id, /^exp_[0-9a-z]{9}[0-9a-f]{12}$/);
  assert.deepEqual([j.status, j.attempts, j.max_attempts, j.created_by, j.notify_email], ['queued', 0, 3, 'console', 'ops@example.com']);
  assert.throws(() => service.retry(j.id), fails('INVALID_STATE'));
  await assert.rejects(service.download(j.id), fails('NO_FILE'));
  assert.equal(service.cancel(j.id).status, 'cancelled');
  assert.throws(() => service.cancel(j.id), fails('INVALID_STATE'));
  assert.equal(service.retry(j.id).status, 'queued');
  const [claimed] = jobs.claim(Date.now(), 1, 5000);
  assert.equal(claimed.id, j.id);
  await assert.rejects(service.delete(j.id), fails('INVALID_STATE'), 'running export cannot be deleted');
  assert.equal(service.cancel(j.id).cancel_requested, 1, 'running export gets a cancel request');
  assert.throws(() => service.get('exp_nope'), fails('EXPORT_NOT_FOUND'));
  const noMail = testSystem(up.url, { NOTIFY_URL: '', NOTIFY_API_KEY: '' });
  assert.throws(() => noMail.service.create({ source: 'atc-auth', format: 'csv', notifyEmail: 'a@b.co' }, 'x'), fails('NOTIFY_DISABLED'));
  const list = jobs.list({ limit: 10 });
  assert.equal(list.length, 1);
});

test('sources: payments, ledger, queue dead letters, scheduler runs and webhook deliveries share the paging and column rules', async () => {
  const env = { SOURCE_PAYMENTS_URL: up.url, SOURCE_PAYMENTS_API_KEY: 'u'.repeat(40), SOURCE_QUEUE_URL: up.url, SOURCE_QUEUE_API_KEY: 'u'.repeat(40), SOURCE_SCHEDULER_URL: up.url, SOURCE_SCHEDULER_API_KEY: 'u'.repeat(40), SOURCE_STATUS_URL: up.url, SOURCE_STATUS_API_KEY: 'u'.repeat(40), SOURCE_WEBHOOK_OUT_URL: up.url, SOURCE_WEBHOOK_OUT_API_KEY: 'u'.repeat(40) };
  const { sources } = testSystem(up.url, env);
  assert.deepEqual(sources.list().map((s) => s.id).sort(), ['atc-audit', 'atc-auth', 'atc-content', 'atc-payments', 'atc-payments-ledger', 'atc-queue', 'atc-scheduler', 'atc-status', 'atc-status-alerts', 'atc-webhook-out']);
  const signal = new AbortController().signal;
  const collect = async (/** @type {string} */ id, /** @type {Record<string, string>} */ f) => { const s = sources.get(id); const out = []; for await (const r of s.rows(s.validate(f), signal)) out.push(r); return out; };
  const pays = await collect('atc-payments', { status: 'refunded' });
  assert.deepEqual(pays.map((p) => [p.id, p.status, p.providerId, p.customerEmail]), [['pay_1', 'refunded', 'pi_1', 'c1@example.com'], ['pay_2', 'refunded', 'pi_2', 'c2@example.com'], ['pay_3', 'refunded', 'pi_3', 'c3@example.com']]);
  const runs = await collect('atc-scheduler', { job: 'nightly.report', status: 'failed' });
  assert.deepEqual(runs.map((r) => r.id), [5, 4, 3, 2, 1], 'keyset paging with before/nextBefore');
  assert.ok(up.state.seen.some((s) => s.url.startsWith('/v1/runs?job=nightly.report&status=failed&limit=100&before=4')));
  assert.ok(!('attempts' in /** @type {any} */ (runs[0])), 'attempt logs are not part of the columns');
  const dead = await collect('atc-queue', { queue: 'jobs' });
  assert.deepEqual([dead[0].id, dead[0].state, dead[0].body], ['msg_1', 'dead', { to: 'a' }]);
  assert.throws(() => sources.get('atc-queue').validate({}), fails('INVALID_FILTER'), 'queue is required');
  assert.throws(() => sources.get('atc-scheduler').validate({ job: 'Bad Name' }), fails('INVALID_FILTER'));
  assert.throws(() => sources.get('atc-webhook-out').validate({ subscription: 'x' }), fails('INVALID_FILTER'));
});
