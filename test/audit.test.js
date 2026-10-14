import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { READ_KEY, RW_KEY, bearer, buildApp, fakeUpstream } from './helpers.js';

const silent = { warn() {}, error() {} };
/** @type {Awaited<ReturnType<typeof fakeUpstream>>} */ let up;
before(async () => { up = await fakeUpstream(); });
after(() => up.close());

test('AuditClient: buffers and is a no-op when off', async () => {
  const c = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('{}', { status: 200 }) });
  assert.equal(c.record({ action: 'x' }), true);
  await c.flush();
  assert.equal(c.buffer.length, 0);
  assert.equal(new AuditClient({ target: null }).record({ action: 'x' }), false);
});

test('API: every write and the download are audit events; denials too; plain reads are not', async (t) => {
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('{}', { status: 200 }) });
  const { app, worker } = await buildApp(up.url, undefined, { audit });
  t.after(() => app.close());
  const h = { ...bearer(RW_KEY), 'user-agent': 'test-agent' };
  const id = JSON.parse((await app.inject({ method: 'POST', url: '/v1/exports', headers: h, payload: { source: 'atc-auth', format: 'csv', filters: { email: 'user1@example.com' } } })).body).export.id;
  await app.inject({ method: 'POST', url: `/v1/exports/${id}/cancel`, headers: h });
  await app.inject({ method: 'POST', url: `/v1/exports/${id}/retry`, headers: h });
  await worker.tick();
  await app.inject({ url: `/v1/exports/${id}/download`, headers: h });
  await app.inject({ method: 'DELETE', url: `/v1/exports/${id}`, headers: h });
  assert.deepEqual(audit.buffer.map((e) => e.action), ['atc-export.export.create', 'atc-export.export.cancel', 'atc-export.export.retry', 'atc-export.export.download', 'atc-export.export.delete']);
  const [create, cancel] = audit.buffer;
  assert.deepEqual([create.outcome, create.actor, create.target, create.userAgent, create.meta], ['success', { type: 'apikey', id: 'console' }, { type: 'export', id }, 'test-agent', { source: 'atc-auth', format: 'csv', filters: { email: 'user1@example.com' }, notify: false }]);
  assert.deepEqual(cancel.meta, { status: 'cancelled' });
  const n = audit.buffer.length;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/exports', headers: bearer(READ_KEY), payload: { source: 'atc-auth', format: 'csv' } })).statusCode, 403);
  assert.deepEqual([audit.buffer.length, audit.buffer.at(-1)?.outcome], [n + 1, 'denied']);
  await app.inject({ url: '/v1/exports', headers: h });
  await app.inject({ method: 'POST', url: '/v1/exports', headers: h, payload: { source: 'nope', format: 'csv' } });
  assert.equal(audit.buffer.length, n + 1);
});
