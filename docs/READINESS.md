# `atc-export` readiness contract

## Purpose
`atc-export` turns platform data into files in the background. A job names a source service, a
format (CSV/NDJSON) and filters; an in-process worker pages through the source's own list API,
encodes rows (CSV formula-injection guarded) and streams them into a private atc-media file. The
file is downloaded through a short-lived signed URL; jobs and files are deleted after
`EXPORT_RETENTION_DAYS`.

## Dependencies
- **atc-media** (`MEDIA_URL` + `MEDIA_API_KEY`, required): destination. Must allow `text/csv` and
  `application/x-ndjson` (`ALLOWED_TYPES`) and `MAX_UPLOAD_BYTES >= EXPORT_MAX_BYTES`. When it is
  down, runs fail transiently and are retried; download and delete answer `502 MEDIA_ERROR`.
- **Sources** (`SOURCE_<NAME>_URL` + `SOURCE_<NAME>_API_KEY`, each optional): atc-audit, atc-auth,
  atc-shortlink, atc-flags, atc-media, atc-content, read keys. Called only by the worker, never in
  the request path.
- **atc-notify** (`NOTIFY_URL` + `NOTIFY_API_KEY`, optional): completion e-mails (`generic`
  template); a failed mail never fails the job.
- **atc-audit** (`AUDIT_URL` + `AUDIT_API_KEY`, optional): forwarding of write/download events,
  buffered and off the request path.

## Persistence
SQLite (`node:sqlite`, WAL, `busy_timeout = 5000`) at `DB_PATH` (`./data/export.db`; Docker
`/data/export.db`). One table `jobs` (id, source, format, filters JSON, notify_email, status,
attempts, max_attempts, next_run_at, owner_token, lease_until, cancel_requested, rows, bytes,
file_id, file_name, error_code, error, notify_status, created_by and timestamps); indexes
`(status, next_run_at)` and `finished_at`. Migrations: ordered blocks tracked by `user_version`,
snapshot with `VACUUM INTO` before upgrading an existing file, no down migrations. Export bytes are
never stored here, only in media.

## Health endpoint
`GET /health` returns `{ status: 'ok' }` without I/O.

## Readiness endpoint
`GET /ready`: `db.ping()` cached 10 s; adds `worker: running|stopped`. Upstream services are not
probed (a source being down must not take this service out of rotation).

## Graceful shutdown
`SIGTERM`/`SIGINT`: worker stops claiming and aborts running exports, handing them back to the
queue without counting the attempt (bounded by `DRAIN_MS`, default 10 s, max 25 s) → HTTP drains →
audit flush → database closes. Force exit at 30 s; PM2 `kill_timeout` 35 s. An aborted upload is
discarded by media.

## Resource limits
`EXPORT_MAX_ROWS` (100 000), `EXPORT_MAX_BYTES` (20 MiB) per export; `WORKER_CONCURRENCY` (2)
parallel exports; output is streamed in 64 KiB chunks (memory per export: one source page plus one
chunk); `BODY_LIMIT` 64 KiB; `RATE_LIMIT_MAX` 600 requests per key per minute; PM2
`max_memory_restart` 300 MB.

## Timeouts
Source request `UPSTREAM_TIMEOUT_MS` (15 s) per attempt; whole upload `UPLOAD_TIMEOUT_MS` (10 min);
media sign/delete and notify use the upstream timeout. Lease `LEASE_MS` (60 s), heartbeat
`HEARTBEAT_MS` (15 s, at most half the lease).

## Retry policy
Per request: `REQUEST_RETRIES` (3) on network errors, timeouts, 408, 429, 5xx, backoff 250 ms
doubling to 10 s. Per run: transient failures requeue the job with `next_run_at` (30 s doubling,
max 10 min) until `MAX_ATTEMPTS` (3); permanent errors (4xx, caps) fail at once. Uploads are not
retried within a run (the stream cannot be replayed); the whole run is. Audit forwarding retries on
its own timer.

## Idempotency
`POST /v1/exports`, cancel and retry honour `Idempotency-Key` (core `Idempotency`, 24 h, per API key
and caller): a repeat replays the first 2xx answer instead of queueing a second job. Without the
header each create queues a job, and cancel, retry and delete are guarded state transitions (`409
INVALID_STATE` when repeated). Completion e-mails send the `Idempotency-Key`
`atc-export:<id>:<attempt>` header to atc-notify. Reruns always produce a new file; a file uploaded by a
worker that lost its lease is deleted.

## Backup
The SQLite file (job metadata). Export files live in media and expire with their jobs; restoring an
old job database can reference files media already deleted (download then fails with
`MEDIA_ERROR`, delete treats a missing file as deleted).

## Restore
Stop, replace `DB_PATH` (remove stale sidecars), start. Running jobs in the restored file are
recovered as interrupted.

## Metrics
`export_jobs{status}`, `export_jobs_finished_24h{outcome}`, `export_bytes_24h`,
`export_stored_bytes`, `export_jobs_by_source{source}` (database); `export_worker_events_total{event}`,
`export_worker_in_flight`, `export_process_uptime_seconds` (process-local).

## Logging
Fastify request logs with request id and trace context, `authorization` redacted; worker logs under
`component: worker` with job id, attempt and error code. Exported data is never logged.

## Tracing
`X-Request-Id` accepted or generated; `traceparent` continued when `TRUST_PROXY=true`. Worker calls
to sources and media start their own requests (no inbound trace to continue).

## Security model
Bearer keys with `read`/`write`/`readwrite`, constant-time comparison. A `read` key can obtain
download URLs, so it reaches every exported row. Files are private in media and only reachable
through signed URLs valid `DOWNLOAD_TTL_SEC`. CSV cells are injection-guarded (control characters
removed, then `=`, `+`, `-`, `@` after optional whitespace, or a leading tab/CR, get a `'` prefix).
Filters are validated per source and passed as query parameters only (no path injection; content's
namespace is pattern-checked and encoded). The service's source keys should be read-only there.

## Scaling model
**B — single-node stateful.** One process per SQLite file (`instances: 1`); the worker is in the
same process. Claims are transactional and fenced, so a second process on the same file would not
double-run a job, but this topology is not shipped or tested.

## Known failure modes
- **Media down**: runs fail transiently and retry; after `MAX_ATTEMPTS` the job fails with
  `MEDIA_ERROR`; retention keeps jobs whose file could not be deleted.
- **Source down or slow**: same retry path; a slow source holds a worker slot up to the timeouts.
- **Media rejects the type** (ALLOWED_TYPES not extended): permanent `MEDIA_ERROR` on every export.
- **Killed without shutdown**: running jobs are recovered on the next start (counted as an attempt).
- **Audit source capped**: audit's own `EXPORT_MAX_ROWS` truncates its export silently at that count.
