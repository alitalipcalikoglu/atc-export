/** @typedef {import('../types.js').JobRow} JobRow */

/** Response shapes. */
export class Views {
  /** @param {number|null} t */
  static iso(t) {
    return t === null || t === undefined ? null : new Date(Number(t)).toISOString();
  }

  /** @param {JobRow} j @param {number} retentionDays */
  static job(j, retentionDays) {
    return {
      id: j.id, source: j.source, format: j.format, filters: JSON.parse(j.filters), notifyEmail: j.notify_email,
      status: j.status, attempts: Number(j.attempts), maxAttempts: Number(j.max_attempts), nextRunAt: Views.iso(j.next_run_at), cancelRequested: j.cancel_requested === 1,
      progress: { rows: Number(j.rows), bytes: Number(j.bytes) },
      file: j.file_id ? { name: j.file_name } : null,
      error: j.error_code ? { code: j.error_code, message: j.error } : null,
      notification: j.notify_email ? (j.notify_status ?? (j.status === 'succeeded' ? 'pending' : null)) : null,
      createdBy: j.created_by, createdAt: Views.iso(j.created_at), startedAt: Views.iso(j.started_at), finishedAt: Views.iso(j.finished_at), updatedAt: Views.iso(j.updated_at),
      expiresAt: j.finished_at ? Views.iso(Number(j.finished_at) + retentionDays * 86_400_000) : null,
    };
  }
}
