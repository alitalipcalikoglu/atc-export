import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { Idempotency } from '@atc-web/atc-service-core/idempotency';
import { ExportError } from '../domain/errors.js';
import { Actor } from './actor.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';
import { AuditMetrics } from '../audit-metrics.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/** HTTP surface: export jobs (write role to start, cancel, retry, delete; read role to look and download). */
export class ExportApi {
  static READY_CACHE_MS = 10_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/export-service.js').ExportService} deps.service
   * @param {import('../store/job-store.js').JobStore} deps.jobs
   * @param {import('../sources/registry.js').SourceRegistry} deps.sources
   * @param {import('../worker.js').Worker} deps.worker
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('@atc-web/atc-service-core/audit').AuditClient} [deps.audit]
   */
  constructor({ config, audit, service, jobs, sources, worker, db, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.jobs = jobs;
    this.sources = sources;
    this.worker = worker;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    app.setErrorHandler(createErrorHandler(ExportError));
    app.addHook('onSend', new Actor(config.actorKeys).auditHook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    // Opt-in per route (config.idempotent): repeats with the same Idempotency-Key replay the first 2xx answer.
    Idempotency.register(app, { raw: this.db.raw });
    registerProbes(app, () => this.db.ping(), { cacheMs: ExportApi.READY_CACHE_MS, extra: () => ({ worker: this.worker.running ? 'running' : 'stopped' }) });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, {
      service: 'atc-export',
      version: this.version,
      capabilities: ['csv', 'ndjson', 'leased-worker', 'media-storage', ...(config.notify ? ['email-notification'] : []), ...this.sources.list().map((s) => `source:${s.id}`)],
      schemaVersion: this.db.schemaVersion,
    });
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const who = new Actor(this.config.actorKeys);
    const days = this.config.limits.retentionDays;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const write = { preHandler: ApiKeyAuth.require('write') };
    const id = (/** @type {FastifyRequest} */ r) => /** @type {{ id: string }} */ (r.params).id;
    const target = (/** @type {FastifyRequest} */ r) => ({ type: 'export', id: id(r) });
    const view = (/** @type {import('../types.js').JobRow} */ j) => ({ export: Views.job(j, days) });

    api.get('/sources', read, async () => ({ items: this.sources.list(), nextCursor: null }));

    api.post('/exports', { config: { idempotent: true, audit: AuditClient.route('atc-export.export.create', (_r, b) => ({ type: 'export', id: b.export.id }), (_r, b) => ({ source: b.export.source, format: b.export.format, filters: b.export.filters, notify: Boolean(b.export.notifyEmail) })) }, ...write, schema: { body: Schemas.create } }, async (request, reply) => {
      const j = s.create(/** @type {any} */ (request.body), who.of(request));
      reply.header('location', `/v1/exports/${j.id}`);
      return reply.code(202).send(view(j));
    });

    api.get('/exports', { ...read, schema: { querystring: Schemas.listQuery } }, async (request) => {
      const q = /** @type {{ status?: string, source?: string, limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 50;
      const rows = this.jobs.list({ status: q.status, source: q.source, before: q.cursor, limit: limit + 1 });
      const page = rows.slice(0, limit);
      return { items: page.map((j) => Views.job(j, days)), nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null };
    });

    api.get('/exports/:id', { ...read, schema: { params: Schemas.idParams } }, async (request) => view(s.get(id(request))));

    api.post('/exports/:id/cancel', { config: { idempotent: true, audit: AuditClient.route('atc-export.export.cancel', target, (_r, b) => ({ status: b.export.status })) }, ...write, schema: { params: Schemas.idParams } }, async (request) => view(s.cancel(id(request))));

    api.post('/exports/:id/retry', { config: { idempotent: true, audit: AuditClient.route('atc-export.export.retry', target) }, ...write, schema: { params: Schemas.idParams } }, async (request) => view(s.retry(id(request))));

    api.get('/exports/:id/download', { config: { audit: AuditClient.route('atc-export.export.download', target) }, ...read, schema: { params: Schemas.idParams } }, async (request) => s.download(id(request)));

    api.delete('/exports/:id', { config: { audit: AuditClient.route('atc-export.export.delete', target) }, ...write, schema: { params: Schemas.idParams } }, async (request, reply) => {
      await s.delete(id(request));
      return reply.code(204).send();
    });

    api.get('/stats', read, async () => s.stats());
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const st = this.service.stats();
      const c = this.worker.counters;
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      const label = (/** @type {string} */ v) => v.replace(/[\\"\n]/g, '\\$&');
      return [
        '# HELP export_jobs Jobs by status (all kept jobs).',
        '# TYPE export_jobs gauge',
        ...['queued', 'running', 'succeeded', 'failed', 'cancelled'].map((x) => `export_jobs{status="${x}"} ${Object.values(st.bySource).reduce((a, m) => a + (m[x] ?? 0), 0)}`),
        '# HELP export_jobs_finished_24h Jobs finished in the last 24 hours, by outcome.',
        '# TYPE export_jobs_finished_24h gauge',
        `export_jobs_finished_24h{outcome="succeeded"} ${st.last24h.succeeded}`,
        `export_jobs_finished_24h{outcome="failed"} ${st.last24h.failed}`,
        `export_jobs_finished_24h{outcome="cancelled"} ${st.last24h.cancelled}`,
        '# HELP export_bytes_24h Bytes written by exports that succeeded in the last 24 hours.',
        '# TYPE export_bytes_24h gauge',
        `export_bytes_24h ${st.last24h.bytes}`,
        '# HELP export_stored_bytes Bytes of export files currently kept in media.',
        '# TYPE export_stored_bytes gauge',
        `export_stored_bytes ${st.storedBytes}`,
        '# HELP export_jobs_by_source Kept jobs per source.',
        '# TYPE export_jobs_by_source gauge',
        ...Object.entries(st.bySource).map(([src, m]) => `export_jobs_by_source{source="${label(src)}"} ${Object.values(m).reduce((a, b) => a + b, 0)}`),
        '# HELP export_worker_events_total Worker outcomes since start (process-local).',
        '# TYPE export_worker_events_total counter',
        ...['succeeded', 'failed', 'retried', 'resumed', 'cancelled', 'purged'].map((k) => `export_worker_events_total{event="${k}"} ${c[/** @type {keyof typeof c} */ (k)]}`),
        '# HELP export_worker_in_flight Jobs this process is running now.',
        '# TYPE export_worker_in_flight gauge',
        `export_worker_in_flight ${this.worker.inFlight.size}`,
        ...AuditMetrics.lines(this.audit),
        '# HELP export_process_uptime_seconds Process uptime.',
        '# TYPE export_process_uptime_seconds gauge',
        `export_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
