import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE jobs (
      id               TEXT PRIMARY KEY,
      source           TEXT NOT NULL,
      format           TEXT NOT NULL CHECK (format IN ('csv', 'ndjson')),
      filters          TEXT NOT NULL DEFAULT '{}',
      notify_email     TEXT,
      status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      attempts         INTEGER NOT NULL DEFAULT 0,
      max_attempts     INTEGER NOT NULL,
      next_run_at      INTEGER,
      -- Lease: owner_token fences every write a worker makes while it holds the job.
      owner_token      TEXT,
      lease_until      INTEGER,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      rows             INTEGER NOT NULL DEFAULT 0,
      bytes            INTEGER NOT NULL DEFAULT 0,
      file_id          TEXT,
      file_name        TEXT,
      error_code       TEXT,
      error            TEXT,
      notify_status    TEXT,
      created_by       TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      started_at       INTEGER,
      finished_at      INTEGER,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX jobs_due ON jobs (status, next_run_at);
    CREATE INDEX jobs_finished ON jobs (finished_at) WHERE finished_at IS NOT NULL;
    `,
  ];
}
