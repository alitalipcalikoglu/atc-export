import { ExportError } from './errors.js';

/** @typedef {import('../types.js').JobRow} JobRow */

/** API-side operations on export jobs. The worker does the exporting. */
export class ExportService {
  static FORMATS = ['csv', 'ndjson'];

  /**
   * @param {object} deps
   * @param {import('../store/job-store.js').JobStore} deps.jobs
   * @param {import('../sources/registry.js').SourceRegistry} deps.sources
   * @param {import('../net/media-client.js').MediaClient} deps.media
   * @param {import('../net/notifier.js').Notifier} deps.notifier
   * @param {import('../types.js').WorkerOptions} deps.options
   * @param {import('../types.js').Limits} deps.limits
   * @param {() => number} [deps.now]
   */
  constructor({ jobs, sources, media, notifier, options, limits, now = Date.now }) {
    this.jobs = jobs;
    this.sources = sources;
    this.media = media;
    this.notifier = notifier;
    this.options = options;
    this.limits = limits;
    this.now = now;
  }

  /** @param {string} id @returns {JobRow} */
  get(id) {
    const j = this.jobs.get(id);
    if (!j) throw new ExportError('EXPORT_NOT_FOUND', `export "${id}" does not exist`);
    return j;
  }

  /**
   * @param {{ source: string, format: 'csv'|'ndjson', filters?: unknown, notifyEmail?: string }} input
   * @param {string} actor
   * @param {import('../types.js').KeyRole} [role]  The caller's role; personal-data sources need `admin`.
   */
  create(input, actor, role = 'admin') {
    const source = this.sources.get(input.source);
    if (source.personal && role !== 'admin') throw new ExportError('FORBIDDEN', `${source.id} holds personal data; exporting it needs an admin key`);
    const filters = source.validate(input.filters);
    if (input.notifyEmail && !this.notifier.enabled) throw new ExportError('NOTIFY_DISABLED', 'completion e-mails need NOTIFY_URL and NOTIFY_API_KEY on the export service');
    return this.jobs.insert({ source: source.id, format: input.format, filters, notifyEmail: input.notifyEmail || null, maxAttempts: this.options.maxAttempts, createdBy: actor }, this.now());
  }

  /** Queued jobs are cancelled at once; a running one stops at its next heartbeat. @param {string} id */
  cancel(id) {
    const j = this.get(id);
    if (j.status === 'queued' && this.jobs.cancelQueued(id, this.now())) return this.get(id);
    if (j.status === 'running' && this.jobs.requestCancel(id, this.now())) return this.get(id);
    throw new ExportError('INVALID_STATE', `a ${j.status} export cannot be cancelled`);
  }

  /** @param {string} id */
  retry(id) {
    const j = this.get(id);
    if (!this.jobs.retry(id, this.now())) throw new ExportError('INVALID_STATE', `only failed or cancelled exports can be retried (this one is ${j.status})`);
    return this.get(id);
  }

  /** Removes the media file first, then the job. A running job must be cancelled first. @param {string} id */
  async delete(id) {
    const j = this.get(id);
    if (j.status === 'running') throw new ExportError('INVALID_STATE', 'cancel the running export before deleting it');
    if (j.file_id) await this.media.delete(j.file_id);
    if (!this.jobs.delete(id)) throw new ExportError('INVALID_STATE', 'the export started running; cancel it first');
  }

  /** Short-lived signed URL of the export file. @param {string} id */
  async download(id) {
    const j = this.get(id);
    if (j.status !== 'succeeded' || !j.file_id) throw new ExportError('NO_FILE', j.status === 'succeeded' ? 'the export had no rows, so there is no file' : `a ${j.status} export has no file`);
    return this.media.url(j.file_id, this.limits.downloadTtlSec);
  }

  /** Queue, running and last-24h outcome counts. */
  stats() {
    const now = this.now();
    const s = this.jobs.stats(now - 86_400_000);
    return {
      queued: s.counts.queued ?? 0,
      running: s.counts.running ?? 0,
      total: Object.values(s.counts).reduce((a, b) => a + b, 0),
      last24h: {
        succeeded: s.recent.succeeded?.n ?? 0,
        failed: s.recent.failed?.n ?? 0,
        cancelled: s.recent.cancelled?.n ?? 0,
        rows: s.recent.succeeded?.rows ?? 0,
        bytes: s.recent.succeeded?.bytes ?? 0,
      },
      storedBytes: s.storedBytes,
      bySource: s.bySource,
      sources: this.sources.list().map((x) => x.id),
      retentionDays: this.limits.retentionDays,
    };
  }
}
