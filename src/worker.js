import { setTimeout as sleep } from 'node:timers/promises';
import { Encoder } from './domain/encoder.js';
import { ExportError } from './domain/errors.js';

/** @typedef {import('./types.js').JobRow} JobRow */
/** @typedef {import('./types.js').MinimalLogger} MinimalLogger */
/** @typedef {'shutdown'|'cancel'|'lease'} StopReason */

/**
 * Background loop: claims due export jobs up to the concurrency limit, pages through the source,
 * encodes rows and streams them into a private media file, then records the outcome. A heartbeat
 * renews each job's lease and picks up cancel requests while it runs. Leases that expire (a crash
 * or a hung worker) are reclaimed; transient upstream failures are retried with backoff; finished
 * jobs and their files are deleted after the retention window.
 *
 * Lease ownership follows atc-webhook-out: `claim()` hands out an `owner_token` + `lease_until`,
 * the heartbeat renews it, and every finishing write is fenced on that token.
 */
export class Worker {
  static MAINTENANCE_INTERVAL_MS = 3_600_000;
  static CHUNK_BYTES = 64 * 1024;
  static CANCEL_CHECK_ROWS = 500;

  /**
   * @param {object} deps
   * @param {import('./store/job-store.js').JobStore} deps.jobs
   * @param {import('./sources/registry.js').SourceRegistry} deps.sources
   * @param {import('./net/media-client.js').MediaClient} deps.media
   * @param {import('./net/notifier.js').Notifier} deps.notifier
   * @param {MinimalLogger} deps.log
   * @param {import('./types.js').WorkerOptions} deps.options
   * @param {import('./types.js').Limits} deps.limits
   * @param {() => number} [deps.now]
   */
  constructor({ jobs, sources, media, notifier, log, options, limits, now = Date.now }) {
    this.jobs = jobs;
    this.sources = sources;
    this.media = media;
    this.notifier = notifier;
    this.log = log;
    this.options = options;
    this.limits = limits;
    this.now = now;
    this.running = false;
    this.claiming = true;
    /** @type {Promise<void>|null} */
    this.loop = null;
    this.abort = new AbortController();
    /** @type {Map<string, { controller: AbortController, done: Promise<void> }>} */
    this.inFlight = new Map();
    this.lastMaintenance = 0;
    this.counters = { succeeded: 0, failed: 0, retried: 0, cancelled: 0, purged: 0, rows: 0, bytes: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.claiming = true;
    this.abort = new AbortController();
    this.recover();
    this.loop = this.#run();
    this.log.info({ concurrency: this.options.concurrency, pollMs: this.options.pollMs, leaseMs: this.options.leaseMs }, 'worker started');
  }

  /**
   * Stop claiming, hand running jobs back to the queue (their attempt is not counted, their partial
   * upload is discarded by media) and wait for them, bounded by `drainMs`.
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.claiming = false;
    this.abort.abort();
    await this.loop;
    for (const f of this.inFlight.values()) f.controller.abort('shutdown');
    const drainAbort = new AbortController();
    const outcome = await Promise.race([
      Promise.allSettled([...this.inFlight.values()].map((f) => f.done)).then(() => 'drained'),
      sleep(this.options.drainMs, undefined, { signal: drainAbort.signal }).then(() => 'timed-out').catch(() => 'timed-out'),
    ]);
    drainAbort.abort();
    if (outcome === 'timed-out') this.log.error({ inFlight: this.inFlight.size }, 'drain timed out; their leases expire and they are recovered on next start');
    this.loop = null;
    this.log.info('worker stopped');
  }

  /** At startup every `running` job belongs to a previous life of this single-process service. */
  recover() {
    const r = this.jobs.reclaimExpired(this.now(), 'interrupted by restart', Number.MAX_SAFE_INTEGER);
    if (r.length) this.log.warn({ n: r.length }, 'recovered export jobs interrupted by a previous process');
    return r;
  }

  /** One pass, awaiting the jobs it started (tests). @param {number} [now] */
  async tick(now = this.now()) {
    this.#pass(now);
    await Promise.allSettled([...this.inFlight.values()].map((f) => f.done));
  }

  /** @param {number} now */
  #pass(now) {
    const reclaimed = this.jobs.reclaimExpired(now, 'lease expired');
    if (reclaimed.length) this.log.warn({ jobs: reclaimed }, 'reclaimed export jobs with an expired lease');
    if (now - this.lastMaintenance >= Worker.MAINTENANCE_INTERVAL_MS) { this.lastMaintenance = now; void this.purge(now); }
    if (!this.claiming) return;
    for (const job of this.jobs.claim(now, this.options.concurrency - this.inFlight.size, this.options.leaseMs)) {
      const controller = new AbortController();
      const done = this.#execute(job, controller).finally(() => this.inFlight.delete(job.id));
      this.inFlight.set(job.id, { controller, done });
    }
  }

  async #run() {
    while (this.running) {
      try { this.#pass(this.now()); } catch (err) { this.log.error({ err }, 'worker pass failed'); }
      try { await sleep(this.options.pollMs, undefined, { signal: this.abort.signal }); } catch { /* stopping */ }
    }
  }

  /** @param {number} attempts */
  static retryDelayMs(attempts) {
    return Math.min(600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  }

  /**
   * @param {JobRow} job
   * @param {AbortController} controller
   */
  async #execute(job, controller) {
    const token = /** @type {string} */ (job.owner_token);
    const signal = controller.signal;
    const progress = { rows: 0, bytes: 0 };
    /** @type {unknown} */ let streamError = null;
    const beat = () => {
      if (signal.aborted) return;
      const now = this.now();
      if (!this.jobs.heartbeat(job.id, token, now + this.options.leaseMs, progress.rows, progress.bytes, now)) controller.abort('lease');
      else if (this.jobs.cancelRequested(job.id)) controller.abort('cancel');
    };
    const timer = setInterval(beat, this.options.heartbeatMs);
    timer.unref();
    try {
      const source = this.sources.get(job.source);
      const filters = /** @type {Record<string, string>} */ (JSON.parse(job.filters));
      const encoder = new Encoder(job.format, source.columns);
      const it = source.rows(filters, signal)[Symbol.asyncIterator]();
      const first = await it.next();
      if (first.done && job.format === 'ndjson') {
        this.#finish(job, token, () => this.jobs.succeed(job.id, token, { rows: 0, bytes: 0, fileId: null, fileName: null }, this.now()), 'succeeded', progress);
        return;
      }
      const limits = this.limits;
      const self = this;
      /** @returns {AsyncGenerator<Uint8Array>} */
      async function* body() {
        try {
          let buf = encoder.header();
          /** @param {Record<string, unknown>} row */
          const add = (row) => {
            if (++progress.rows > limits.maxRows) throw new ExportError('TOO_MANY_ROWS', `export exceeds EXPORT_MAX_ROWS (${limits.maxRows}); narrow the filters`);
            buf += encoder.line(row);
          };
          if (!first.done) add(first.value);
          for (;;) {
            if (Buffer.byteLength(buf) >= Worker.CHUNK_BYTES) { yield self.#chunk(buf, progress, limits); buf = ''; }
            if (progress.rows % Worker.CANCEL_CHECK_ROWS === 0) beat();
            signal.throwIfAborted();
            const next = await it.next();
            if (next.done) break;
            add(next.value);
          }
          if (buf) yield self.#chunk(buf, progress, limits);
        } catch (err) {
          streamError = err;
          throw err;
        }
      }
      const fileName = `${job.source.replace(/^atc-/, '')}-export-${new Date(job.created_at).toISOString().slice(0, 10)}-${job.id.slice(-6)}.${job.format}`;
      const file = await this.media.upload(body(), fileName, signal, this.options.uploadTimeoutMs);
      const result = { rows: progress.rows, bytes: progress.bytes, fileId: file.id, fileName: file.name };
      if (!this.#finish(job, token, () => this.jobs.succeed(job.id, token, result, this.now()), 'succeeded', progress)) {
        // Lease lost after the upload: the new owner will produce its own file, this one is an orphan.
        await this.media.delete(file.id).catch((err) => this.log.warn({ err, fileId: file.id }, 'orphan export file not deleted'));
        return;
      }
      if (job.notify_email && this.notifier.enabled) {
        try { await this.notifier.exportReady(job, result); this.jobs.setNotify(job.id, 'sent', this.now()); }
        catch (err) { this.jobs.setNotify(job.id, 'failed', this.now()); this.log.warn({ err, job: job.id }, 'export notification failed'); }
      }
    } catch (rawErr) {
      const reason = /** @type {StopReason|undefined} */ (signal.aborted ? signal.reason : undefined);
      const err = streamError ?? rawErr;
      const now = this.now();
      if (reason === 'shutdown') { this.jobs.release(job.id, token, now); return; }
      if (reason === 'lease') { this.log.warn({ job: job.id }, 'lease lost; another worker owns this export now'); return; }
      if (reason === 'cancel') { this.#finish(job, token, () => this.jobs.cancelled(job.id, token, progress, now), 'cancelled', progress); return; }
      const e = err instanceof ExportError ? err : new ExportError('UPSTREAM_ERROR', err instanceof Error ? err.message : String(err), { transient: true });
      if (e.transient && job.attempts < job.max_attempts) {
        this.jobs.requeue(job.id, token, now + Worker.retryDelayMs(job.attempts), { code: e.code, message: e.message }, now);
        this.counters.retried++;
        this.log.warn({ job: job.id, attempt: job.attempts, code: e.code, err: e.message }, 'export failed transiently; retrying later');
        return;
      }
      this.#finish(job, token, () => this.jobs.fail(job.id, token, { rows: progress.rows, bytes: progress.bytes, code: e.code, message: e.message }, now), 'failed', progress);
      this.log.warn({ job: job.id, code: e.code, err: e.message }, 'export failed');
    } finally {
      clearInterval(timer);
    }
  }

  /** @param {string} s @param {{ rows: number, bytes: number }} progress @param {import('./types.js').Limits} limits */
  #chunk(s, progress, limits) {
    const b = Buffer.from(s, 'utf8');
    progress.bytes += b.length;
    if (progress.bytes > limits.maxBytes) throw new ExportError('TOO_LARGE', `export exceeds EXPORT_MAX_BYTES (${limits.maxBytes} bytes); narrow the filters`);
    return b;
  }

  /**
   * @param {JobRow} job @param {string} _token @param {() => boolean} write
   * @param {'succeeded'|'failed'|'cancelled'} outcome @param {{ rows: number, bytes: number }} progress
   */
  #finish(job, _token, write, outcome, progress) {
    const ok = write();
    if (!ok) { this.log.warn({ job: job.id, outcome }, 'lease lost before the outcome was recorded'); return false; }
    this.counters[outcome]++;
    if (outcome === 'succeeded') { this.counters.rows += progress.rows; this.counters.bytes += progress.bytes; }
    return true;
  }

  /**
   * Retention: finished jobs older than the window, file first, then the row. A file that cannot be
   * deleted now keeps its row for the next run.
   * @param {number} [now]
   */
  async purge(now = this.now()) {
    let purged = 0;
    try {
      for (const job of this.jobs.purgeable(now - this.limits.retentionDays * 86_400_000, 500)) {
        try {
          if (job.file_id) await this.media.delete(job.file_id);
          if (this.jobs.delete(job.id)) purged++;
        } catch (err) {
          this.log.warn({ err, job: job.id }, 'retention: export file not deleted yet');
        }
      }
      if (purged) this.log.info({ purged }, 'retention removed export jobs');
      this.counters.purged += purged;
    } catch (err) {
      this.log.error({ err }, 'retention failed');
    }
    return purged;
  }
}
