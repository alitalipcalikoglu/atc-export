import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    this.counters = { succeeded: 0, failed: 0, retried: 0, cancelled: 0, purged: 0, rows: 0, bytes: 0, resumed: 0 };
  }

  /** Create the spool directory; call once before {@link start}. */
  async prepare() {
    await mkdir(this.options.spoolDir, { recursive: true, mode: 0o700 });
    return this;
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

  /** Spool file of a job. @param {JobRow} job */
  spoolPath(job) {
    return join(this.options.spoolDir, `${job.id}.${job.format}`);
  }

  /**
   * Pages the source into a local spool file, checkpointing after every page, then streams the file
   * to media. A rerun (transient failure, restart, lost lease) truncates the spool to the last
   * checkpoint and continues from the saved cursor instead of reading the source from the start.
   * @param {JobRow} job
   * @param {AbortController} controller
   */
  async #execute(job, controller) {
    const token = /** @type {string} */ (job.owner_token);
    const signal = controller.signal;
    const progress = { rows: 0, bytes: 0 };
    const path = this.spoolPath(job);
    const beat = () => {
      if (signal.aborted) return;
      const now = this.now();
      if (!this.jobs.heartbeat(job.id, token, now + this.options.leaseMs, progress.rows, progress.bytes, now)) controller.abort('lease');
      else if (this.jobs.cancelRequested(job.id)) controller.abort('cancel');
    };
    const timer = setInterval(beat, this.options.heartbeatMs);
    timer.unref();
    const cleanup = async () => { this.jobs.clearCheckpoint(job.id); await rm(path, { force: true }).catch(() => {}); };
    try {
      const source = this.sources.get(job.source);
      const filters = /** @type {Record<string, string>} */ (JSON.parse(job.filters));
      const encoder = new Encoder(job.format, source.columns);
      /** @type {string|null} */ let cursor = null;
      let spooled = false;
      if (job.checkpoint_bytes !== null && source.resumable && await Worker.#truncate(path, Number(job.checkpoint_bytes))) {
        progress.rows = Number(job.checkpoint_rows);
        progress.bytes = Number(job.checkpoint_bytes);
        cursor = job.checkpoint_cursor;
        spooled = cursor === null;
        this.counters.resumed++;
        this.log.info({ job: job.id, rows: progress.rows, bytes: progress.bytes }, 'export resumed from its checkpoint');
      } else {
        const header = Buffer.from(encoder.header(), 'utf8');
        await writeFile(path, header, { mode: 0o600 });
        progress.bytes = header.length;
      }
      const fh = await open(path, 'a');
      try {
        /** @param {Record<string, unknown>[]} rows */
        const append = async (rows) => {
          let text = '';
          for (const row of rows) {
            if (++progress.rows > this.limits.maxRows) throw new ExportError('TOO_MANY_ROWS', `export exceeds EXPORT_MAX_ROWS (${this.limits.maxRows}); narrow the filters`);
            text += encoder.line(row);
          }
          const b = Buffer.from(text, 'utf8');
          if (progress.bytes + b.length > this.limits.maxBytes) throw new ExportError('TOO_LARGE', `export exceeds EXPORT_MAX_BYTES (${this.limits.maxBytes} bytes); narrow the filters`);
          await fh.write(b);
          progress.bytes += b.length;
        };
        if (!spooled && source.resumable) {
          for await (const page of source.pages(filters, signal, cursor)) {
            await append(page.items);
            await fh.datasync();
            if (!this.jobs.checkpoint(job.id, token, { cursor: page.next, rows: progress.rows, bytes: progress.bytes }, this.now())) controller.abort('lease');
            beat();
            signal.throwIfAborted();
          }
        } else if (!spooled) {
          /** @type {Record<string, unknown>[]} */ let batch = [];
          for await (const row of source.rows(filters, signal)) {
            batch.push(row);
            if (batch.length >= Worker.CANCEL_CHECK_ROWS) { await append(batch); batch = []; beat(); signal.throwIfAborted(); }
          }
          if (batch.length) await append(batch);
        }
      } finally {
        await fh.close();
      }
      signal.throwIfAborted();
      if (progress.rows === 0 && job.format === 'ndjson') {
        if (this.#finish(job, token, () => this.jobs.succeed(job.id, token, { rows: 0, bytes: 0, fileId: null, fileName: null }, this.now()), 'succeeded', progress)) await cleanup();
        return;
      }
      const fileName = `${job.source.replace(/^atc-/, '')}-export-${new Date(job.created_at).toISOString().slice(0, 10)}-${job.id.slice(-6)}.${job.format}`;
      const stream = /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (createReadStream(path, { highWaterMark: Worker.CHUNK_BYTES })));
      const file = await this.media.upload(stream, fileName, signal, this.options.uploadTimeoutMs);
      const result = { rows: progress.rows, bytes: progress.bytes, fileId: file.id, fileName: file.name };
      if (!this.#finish(job, token, () => this.jobs.succeed(job.id, token, result, this.now()), 'succeeded', progress)) {
        // Lease lost after the upload: the new owner will produce its own file, this one is an orphan.
        await this.media.delete(file.id).catch((err) => this.log.warn({ err, fileId: file.id }, 'orphan export file not deleted'));
        return;
      }
      await cleanup();
      if (job.notify_email && this.notifier.enabled) {
        try { await this.notifier.exportReady(job, result); this.jobs.setNotify(job.id, 'sent', this.now()); }
        catch (err) { this.jobs.setNotify(job.id, 'failed', this.now()); this.log.warn({ err, job: job.id }, 'export notification failed'); }
      }
    } catch (err) {
      const reason = /** @type {StopReason|undefined} */ (signal.aborted ? signal.reason : undefined);
      const now = this.now();
      // Shutdown, a lost lease and a transient failure keep the spool and checkpoint: the next run resumes.
      if (reason === 'shutdown') { this.jobs.release(job.id, token, now); return; }
      if (reason === 'lease') { this.log.warn({ job: job.id }, 'lease lost; another worker owns this export now'); return; }
      if (reason === 'cancel') { if (this.#finish(job, token, () => this.jobs.cancelled(job.id, token, progress, now), 'cancelled', progress)) await cleanup(); return; }
      const e = err instanceof ExportError ? err : new ExportError('UPSTREAM_ERROR', err instanceof Error ? err.message : String(err), { transient: true });
      if (e.transient && job.attempts < job.max_attempts) {
        this.jobs.requeue(job.id, token, now + Worker.retryDelayMs(job.attempts), { code: e.code, message: e.message }, now);
        this.counters.retried++;
        this.log.warn({ job: job.id, attempt: job.attempts, code: e.code, err: e.message }, 'export failed transiently; retrying later');
        return;
      }
      if (this.#finish(job, token, () => this.jobs.fail(job.id, token, { rows: progress.rows, bytes: progress.bytes, code: e.code, message: e.message }, now), 'failed', progress)) await cleanup();
      this.log.warn({ job: job.id, code: e.code, err: e.message }, 'export failed');
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Cut a spool file back to its checkpoint. False when the file is missing or shorter (another
   * disk, or wiped): the export then starts over.
   * @param {string} path @param {number} bytes
   */
  static async #truncate(path, bytes) {
    try {
      if ((await stat(path)).size < bytes) return false;
      await truncate(path, bytes);
      return true;
    } catch {
      return false;
    }
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
      // Spool files of jobs that are no longer queued or running (deleted rows, crashes between steps).
      const active = this.jobs.activeIds();
      for (const name of await readdir(this.options.spoolDir).catch(() => /** @type {string[]} */ ([]))) {
        if (!active.has(name.replace(/\.(csv|ndjson)$/, ''))) await rm(join(this.options.spoolDir, name), { force: true }).catch(() => {});
      }
      this.counters.purged += purged;
    } catch (err) {
      this.log.error({ err }, 'retention failed');
    }
    return purged;
  }
}
