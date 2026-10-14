import { randomBytes, randomUUID } from 'node:crypto';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').JobRow} JobRow */

/**
 * Persistence and state transitions of export jobs. Every write a worker makes while it holds a
 * job is fenced on the `owner_token` it got from {@link claim}: once the lease has moved on (a
 * crash recovery or another process), a stale worker can no longer change the row.
 */
export class JobStore {
  static COLUMNS = 'id, source, format, filters, notify_email, status, attempts, max_attempts, next_run_at, owner_token, lease_until, cancel_requested, rows, bytes, file_id, file_name, error_code, error, notify_status, created_by, created_at, started_at, finished_at, updated_at';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const C = JobStore.COLUMNS;
    const fenced = "WHERE id = ? AND owner_token = ? AND status = 'running'";
    this.stmt = {
      insert: db.prepare('INSERT INTO jobs (id, source, format, filters, notify_email, status, max_attempts, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, \'queued\', ?, ?, ?, ?)'),
      get: db.prepare(`SELECT ${C} FROM jobs WHERE id = ?`),
      due: db.prepare(`SELECT id FROM jobs WHERE status = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY id LIMIT ?`),
      start: db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, owner_token = ?, lease_until = ?, started_at = ?, next_run_at = NULL, rows = 0, bytes = 0, updated_at = ? WHERE id = ? AND status = 'queued'"),
      heartbeat: db.prepare(`UPDATE jobs SET lease_until = ?, rows = ?, bytes = ?, updated_at = ? ${fenced}`),
      cancelFlag: db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?'),
      succeed: db.prepare(`UPDATE jobs SET status = 'succeeded', rows = ?, bytes = ?, file_id = ?, file_name = ?, error_code = NULL, error = NULL, owner_token = NULL, lease_until = NULL, finished_at = ?, updated_at = ? ${fenced}`),
      fail: db.prepare(`UPDATE jobs SET status = 'failed', rows = ?, bytes = ?, error_code = ?, error = ?, owner_token = NULL, lease_until = NULL, finished_at = ?, updated_at = ? ${fenced}`),
      cancelled: db.prepare(`UPDATE jobs SET status = 'cancelled', rows = ?, bytes = ?, owner_token = NULL, lease_until = NULL, finished_at = ?, updated_at = ? ${fenced}`),
      requeue: db.prepare(`UPDATE jobs SET status = 'queued', next_run_at = ?, error_code = ?, error = ?, owner_token = NULL, lease_until = NULL, updated_at = ? ${fenced}`),
      release: db.prepare(`UPDATE jobs SET status = 'queued', attempts = MAX(attempts - 1, 0), next_run_at = NULL, owner_token = NULL, lease_until = NULL, updated_at = ? ${fenced}`),
      expired: db.prepare("SELECT id, attempts, max_attempts FROM jobs WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)"),
      expireToQueue: db.prepare("UPDATE jobs SET status = 'queued', next_run_at = ?, error_code = 'INTERRUPTED', error = ?, owner_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'"),
      expireToFail: db.prepare("UPDATE jobs SET status = 'failed', error_code = 'INTERRUPTED', error = ?, owner_token = NULL, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'"),
      cancelQueued: db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'"),
      requestCancel: db.prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'running'"),
      retry: db.prepare("UPDATE jobs SET status = 'queued', attempts = 0, next_run_at = NULL, cancel_requested = 0, rows = 0, bytes = 0, file_id = NULL, file_name = NULL, error_code = NULL, error = NULL, notify_status = NULL, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'cancelled')"),
      delete: db.prepare("DELETE FROM jobs WHERE id = ? AND status <> 'running'"),
      notify: db.prepare('UPDATE jobs SET notify_status = ?, updated_at = ? WHERE id = ?'),
      purgeable: db.prepare(`SELECT ${C} FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ? AND status IN ('succeeded', 'failed', 'cancelled') ORDER BY finished_at LIMIT ?`),
      counts: db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'),
      recent: db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(rows), 0) AS rows FROM jobs WHERE finished_at >= ? AND status IN ('succeeded', 'failed', 'cancelled') GROUP BY status"),
      bySource: db.prepare('SELECT source, status, COUNT(*) AS n FROM jobs GROUP BY source, status'),
      storedBytes: db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM jobs WHERE status = 'succeeded' AND file_id IS NOT NULL"),
    };
  }

  /** Time-ordered id: lexical order is creation order, so it doubles as the list cursor. @param {number} now */
  static newId(now) {
    return `exp_${now.toString(36).padStart(9, '0')}${randomBytes(6).toString('hex')}`;
  }

  /**
   * @param {{ source: string, format: string, filters: Record<string, string>, notifyEmail: string|null, maxAttempts: number, createdBy: string }} j
   * @param {number} now
   * @returns {JobRow}
   */
  insert(j, now) {
    const id = JobStore.newId(now);
    this.stmt.insert.run(id, j.source, j.format, JSON.stringify(j.filters), j.notifyEmail, j.maxAttempts, j.createdBy, now, now);
    return /** @type {JobRow} */ (this.get(id));
  }

  /** @param {string} id @returns {JobRow|undefined} */
  get(id) {
    return /** @type {JobRow|undefined} */ (this.stmt.get.get(id));
  }

  /**
   * Newest first.
   * @param {{ status?: string, source?: string, before?: string, limit: number }} q
   * @returns {JobRow[]}
   */
  list({ status, source, before, limit }) {
    const where = [];
    /** @type {(string|number)[]} */
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (source) { where.push('source = ?'); args.push(source); }
    if (before) { where.push('id < ?'); args.push(before); }
    args.push(limit);
    return /** @type {JobRow[]} */ (this.db.prepare(`SELECT ${JobStore.COLUMNS} FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args));
  }

  /**
   * Move up to `limit` due jobs to `running`, each with a fresh lease. One transaction, so two loops
   * never claim the same job.
   * @param {number} now @param {number} limit @param {number} leaseMs
   * @returns {JobRow[]}
   */
  claim(now, limit, leaseMs) {
    if (limit <= 0) return [];
    return this.db.transaction(() => {
      const ids = /** @type {{ id: string }[]} */ (this.stmt.due.all(now, limit));
      /** @type {JobRow[]} */
      const out = [];
      for (const { id } of ids) {
        if (Number(this.stmt.start.run(randomUUID(), now + leaseMs, now, now, id).changes) === 1) out.push(/** @type {JobRow} */ (this.get(id)));
      }
      return out;
    });
  }

  /** Renew the lease and record progress. False when the lease is gone. @param {string} id @param {string} token @param {number} leaseUntil @param {number} rows @param {number} bytes @param {number} now */
  heartbeat(id, token, leaseUntil, rows, bytes, now) {
    return Number(this.stmt.heartbeat.run(leaseUntil, rows, bytes, now, id, token).changes) === 1;
  }

  /** @param {string} id */
  cancelRequested(id) {
    const r = /** @type {{ cancel_requested: number }|undefined} */ (this.stmt.cancelFlag.get(id));
    return r?.cancel_requested === 1;
  }

  /** @param {string} id @param {string} token @param {{ rows: number, bytes: number, fileId: string|null, fileName: string|null }} r @param {number} now */
  succeed(id, token, r, now) {
    return Number(this.stmt.succeed.run(r.rows, r.bytes, r.fileId, r.fileName, now, now, id, token).changes) === 1;
  }

  /** @param {string} id @param {string} token @param {{ rows: number, bytes: number, code: string, message: string }} r @param {number} now */
  fail(id, token, r, now) {
    return Number(this.stmt.fail.run(r.rows, r.bytes, r.code, r.message.slice(0, 1000), now, now, id, token).changes) === 1;
  }

  /** @param {string} id @param {string} token @param {{ rows: number, bytes: number }} r @param {number} now */
  cancelled(id, token, r, now) {
    return Number(this.stmt.cancelled.run(r.rows, r.bytes, now, now, id, token).changes) === 1;
  }

  /** Transient failure: queue another attempt at `nextRunAt`. @param {string} id @param {string} token @param {number} nextRunAt @param {{ code: string, message: string }} e @param {number} now */
  requeue(id, token, nextRunAt, e, now) {
    return Number(this.stmt.requeue.run(nextRunAt, e.code, e.message.slice(0, 1000), now, id, token).changes) === 1;
  }

  /** Shutdown: hand the job back without counting the attempt. @param {string} id @param {string} token @param {number} now */
  release(id, token, now) {
    return Number(this.stmt.release.run(now, id, token).changes) === 1;
  }

  /**
   * Jobs whose lease expired (a crashed or hung worker): queued again while attempts remain,
   * failed otherwise. Returns what happened to each. `cutoff` defaults to `now`; startup recovery
   * passes `Infinity`-like to take every running job.
   * @param {number} now @param {string} reason @param {number} [cutoff]
   */
  reclaimExpired(now, reason, cutoff = now) {
    return this.db.transaction(() => {
      const rows = /** @type {{ id: string, attempts: number, max_attempts: number }[]} */ (this.stmt.expired.all(cutoff));
      return rows.map((r) => {
        if (r.attempts >= r.max_attempts) { this.stmt.expireToFail.run(reason, now, now, r.id); return { id: r.id, outcome: 'failed' }; }
        this.stmt.expireToQueue.run(now, reason, now, r.id);
        return { id: r.id, outcome: 'queued' };
      });
    });
  }

  /** @param {string} id @param {number} now */
  cancelQueued(id, now) {
    return Number(this.stmt.cancelQueued.run(now, now, id).changes) === 1;
  }

  /** @param {string} id @param {number} now */
  requestCancel(id, now) {
    return Number(this.stmt.requestCancel.run(now, id).changes) === 1;
  }

  /** @param {string} id @param {number} now */
  retry(id, now) {
    return Number(this.stmt.retry.run(now, id).changes) === 1;
  }

  /** @param {string} id */
  delete(id) {
    return Number(this.stmt.delete.run(id).changes) === 1;
  }

  /** @param {string} id @param {'sent'|'failed'} status @param {number} now */
  setNotify(id, status, now) {
    this.stmt.notify.run(status, now, id);
  }

  /** @param {number} before @param {number} limit @returns {JobRow[]} */
  purgeable(before, limit) {
    return /** @type {JobRow[]} */ (this.stmt.purgeable.all(before, limit));
  }

  /** @param {number} since */
  stats(since) {
    const counts = Object.fromEntries(/** @type {{ status: string, n: number }[]} */ (this.stmt.counts.all()).map((r) => [r.status, Number(r.n)]));
    const recent = Object.fromEntries(/** @type {{ status: string, n: number, bytes: number, rows: number }[]} */ (this.stmt.recent.all(since)).map((r) => [r.status, { n: Number(r.n), bytes: Number(r.bytes), rows: Number(r.rows) }]));
    /** @type {Record<string, Record<string, number>>} */
    const bySource = {};
    for (const r of /** @type {{ source: string, status: string, n: number }[]} */ (this.stmt.bySource.all())) (bySource[r.source] ??= {})[r.status] = Number(r.n);
    return { counts, recent, bySource, storedBytes: Number(/** @type {{ bytes: number }} */ (this.stmt.storedBytes.get()).bytes) };
  }
}
