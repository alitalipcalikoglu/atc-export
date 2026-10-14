import { createServer } from 'node:http';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { ExportService } from '../src/domain/export-service.js';
import { MediaClient } from '../src/net/media-client.js';
import { Notifier } from '../src/net/notifier.js';
import { ServiceHttp } from '../src/net/service-http.js';
import { SourceRegistry } from '../src/sources/registry.js';
import { JobStore } from '../src/store/job-store.js';
import { Worker } from '../src/worker.js';

export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);
export const UP_KEY = 'u'.repeat(40);
export const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return silent; }, level: 'silent' };

/**
 * One fake upstream playing every service the exporter talks to. `state` is inspectable and
 * tweakable per test: users/links/events data, failure injection, stored uploads, mails.
 */
export async function fakeUpstream() {
  const state = {
    /** @type {any[]} */ users: Array.from({ length: 7 }, (_, i) => ({ id: `u${i + 1}`, email: `user${i + 1}@example.com`, name: i === 0 ? '=HYPERLINK("x")' : `User, "${i + 1}"`, status: 'active', emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })),
    events: Array.from({ length: 3 }, (_, i) => ({ seq: i + 1, id: `e${i + 1}`, at: '2026-01-01T00:00:00.000Z', source: 'atc-auth', action: 'atc-auth.login', outcome: 'success', actor: { type: 'user', id: `u${i}` }, target: null, ip: '1.2.3.4', meta: { n: i } })),
    /** @type {any[]} */ keys: [{ key: 'nav.home', description: 'Home', placeholders: [], values: { en: 'Home', 'tr-CY': 'Ana sayfa' }, mismatched: [], updatedAt: '2026-01-01T00:00:00.000Z' }, { key: 'cart', description: '', placeholders: ['count'], values: { en: '{count} items' }, mismatched: [], updatedAt: '2026-01-01T00:00:00.000Z' }],
    /** @type {Map<string, { name: string, body: string }>} */ files: new Map(),
    /** @type {string[]} */ deleted: [],
    /** @type {any[]} */ mails: [],
    /** @type {{ method: string, url: string, auth: string|undefined }[]} */ seen: [],
    failUsers: 0,          // next N /v1/users calls answer 503
    usersStatus: 0,        // when set, every /v1/users call answers this status
    slowMs: 0,             // delay per /v1/users page
    uploadStatus: 0,       // when set, PUT /v1/files answers this status
    mailStatus: 0,
    nextFile: 1,
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    state.seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    const json = (/** @type {number} */ s, /** @type {unknown} */ b) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(b));
    const p = url.pathname;
    if (p === '/v1/users') {
      if (state.usersStatus) return json(state.usersStatus, { error: { code: 'X', message: 'nope' } });
      if (state.failUsers > 0) { state.failUsers--; return json(503, { error: { code: 'DOWN', message: 'down' } }); }
      const limit = Number(url.searchParams.get('limit'));
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const items = state.users.slice(start, start + Math.min(limit, 3));
      const next = start + items.length < state.users.length ? String(start + items.length) : null;
      return setTimeout(() => json(200, { items, nextCursor: next }), state.slowMs);
    }
    if (p === '/v1/events/export') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const lines = state.events.map((e) => `${JSON.stringify(e)}\n`).join('');
      // Split mid-line to prove the line reassembly.
      res.write(lines.slice(0, 17));
      return setTimeout(() => res.end(lines.slice(17)), 5);
    }
    if (p === '/v1/namespaces/web/keys') return json(200, { items: url.searchParams.get('missing') ? state.keys.filter((k) => !k.values['tr-CY']) : state.keys, nextCursor: null });
    if (p === '/v1/files' && req.method === 'PUT') {
      const chunks = /** @type {Buffer[]} */ ([]);
      req.on('data', (c) => chunks.push(c));
      req.on('error', () => {});
      req.on('end', () => {
        if (state.uploadStatus) return json(state.uploadStatus, { error: { code: 'UNSUPPORTED_TYPE', message: 'no' } });
        const id = `f${state.nextFile++}`;
        const body = Buffer.concat(chunks).toString();
        state.files.set(id, { name: String(url.searchParams.get('name')), body });
        json(201, { file: { id, name: url.searchParams.get('name'), size: Buffer.byteLength(body) } });
      });
      return;
    }
    const urls = /^\/v1\/files\/([^/]+)\/urls$/.exec(p);
    if (urls) return state.files.has(urls[1]) ? json(200, { urls: { original: { url: `http://media.test/files/${urls[1]}/original?sig=x`, expiresAt: '2030-01-01T00:00:00.000Z' } } }) : json(404, { error: { code: 'NOT_FOUND', message: 'no file' } });
    const del = /^\/v1\/files\/([^/]+)$/.exec(p);
    if (del && req.method === 'DELETE') { state.deleted.push(del[1]); if (!state.files.delete(del[1])) return json(404, { error: { code: 'NOT_FOUND', message: 'gone' } }); return res.writeHead(204).end(); }
    if (p === '/v1/messages') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { if (state.mailStatus) return json(state.mailStatus, {}); state.mails.push(JSON.parse(b)); json(202, { id: 'm1' }); });
      return;
    }
    json(404, { error: { code: 'NOT_FOUND', message: p } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { state, url, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r(undefined)); }) };
}

/** @param {string} url @param {Record<string, string>} [overrides] */
export function testEnv(url, overrides = {}) {
  return {
    PORT: '0', LOG_LEVEL: 'silent', DB_PATH: ':memory:',
    EXPORT_API_KEYS: `console:${RW_KEY},dashboard:${READ_KEY}:read,ops:${WRITE_KEY}:write`,
    MEDIA_URL: url, MEDIA_API_KEY: UP_KEY, NOTIFY_URL: url, NOTIFY_API_KEY: UP_KEY,
    SOURCE_AUTH_URL: url, SOURCE_AUTH_API_KEY: UP_KEY, SOURCE_AUDIT_URL: url, SOURCE_AUDIT_API_KEY: UP_KEY,
    SOURCE_CONTENT_URL: url, SOURCE_CONTENT_API_KEY: UP_KEY,
    HEARTBEAT_MS: '1000', LEASE_MS: '5000', POLL_MS: '50', REQUEST_RETRIES: '2',
    ...overrides,
  };
}

/** Wired domain over an in-memory database. @param {string} url @param {Record<string, string>} [overrides] @param {{ now?: () => number }} [o] */
export function testSystem(url, overrides, { now = Date.now } = {}) {
  const config = Config.fromEnv(testEnv(url, overrides));
  const db = new Database(':memory:');
  const jobs = new JobStore(db);
  const nosleep = async () => {};
  const http = (/** @type {string} */ id, /** @type {import('../src/types.js').Upstream} */ upstream) => new ServiceHttp({ id, upstream, timeoutMs: config.worker.upstreamTimeoutMs, retries: config.worker.requestRetries, sleep: nosleep });
  const sources = SourceRegistry.fromConfig(config.sources, { timeoutMs: config.worker.upstreamTimeoutMs, retries: config.worker.requestRetries, sleep: nosleep });
  const media = new MediaClient(http('atc-media', config.media));
  const notifier = new Notifier(config.notify ? http('atc-notify', config.notify) : null, config.appName);
  const service = new ExportService({ jobs, sources, media, notifier, options: config.worker, limits: config.limits, now });
  const worker = new Worker({ jobs, sources, media, notifier, log: silent, options: config.worker, limits: config.limits, now });
  return { config, db, jobs, sources, media, notifier, service, worker };
}
