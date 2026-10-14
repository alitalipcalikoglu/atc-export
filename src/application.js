import { Config } from './config.js';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { Lifecycle } from '@atc-web/atc-service-core/lifecycle';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Database } from './db.js';
import { ExportService } from './domain/export-service.js';
import { ExportApi } from './http/export-api.js';
import { MediaClient } from './net/media-client.js';
import { Notifier } from './net/notifier.js';
import { ServiceHttp } from './net/service-http.js';
import { SourceRegistry } from './sources/registry.js';
import { JobStore } from './store/job-store.js';
import { Worker } from './worker.js';

/** Composition root: wires configuration, storage, domain, HTTP and the worker, and owns the process lifecycle. */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.version = readServiceVersion(import.meta.url);
    this.audit = new AuditClient({ target: config.audit });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.jobs = new JobStore(this.db);
    const w = config.worker;
    const http = (/** @type {string} */ id, /** @type {import('./types.js').Upstream} */ upstream) => new ServiceHttp({ id, upstream, timeoutMs: w.upstreamTimeoutMs, retries: w.requestRetries });
    this.sources = SourceRegistry.fromConfig(config.sources, { timeoutMs: w.upstreamTimeoutMs, retries: w.requestRetries });
    this.media = new MediaClient(http('atc-media', config.media));
    this.notifier = new Notifier(config.notify ? http('atc-notify', config.notify) : null, config.appName);
    this.service = new ExportService({ jobs: this.jobs, sources: this.sources, media: this.media, notifier: this.notifier, options: w, limits: config.limits });
    /** @type {Worker|null} */
    this.worker = null;
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    // The worker logs through Fastify's logger, so the app is built first with a placeholder worker reference.
    const worker = new Worker({ jobs: this.jobs, sources: this.sources, media: this.media, notifier: this.notifier, log: console, options: config.worker, limits: config.limits });
    this.worker = worker;
    const api = new ExportApi({ config, audit: this.audit, service: this.service, jobs: this.jobs, sources: this.sources, worker, db: this.db, version: this.version });
    const app = await api.build();
    this.app = app;
    worker.log = app.log.child({ component: 'worker' });
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => this.worker?.stop(),
        () => this.app?.close(),
        () => this.audit.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, sources: Object.keys(config.sources), notify: config.notify !== null }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    worker.start();
    if (process.send) process.send('ready'); // PM2 wait_ready
  }
}
