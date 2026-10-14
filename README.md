# atc-export

Background data exports to files. A job names a source service (audit events, users, short links, feature flags, media files, translation keys), a format (CSV or NDJSON) and filters; a durable worker pages through that service's own list API, encodes the rows (CSV formula-injection guarded) and streams them into a private atc-media file. The file is fetched through a short-lived signed URL, an optional e-mail goes out through atc-notify, and jobs and files are deleted after a retention window. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`, `@atc-web/atc-service-core`. Storage is SQLite via `node:sqlite` (Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # EXPORT_API_KEYS, MEDIA_URL/MEDIA_API_KEY and the sources you want
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-export .
docker run -p 3014:3014 -v atc-export-data:/data --env-file .env atc-export
```

atc-media must accept the files: add `text/csv,application/x-ndjson` to its `ALLOWED_TYPES` (opt-in there) and keep its `MAX_UPLOAD_BYTES` at or above `EXPORT_MAX_BYTES`.

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **Job**: `queued → running → succeeded | failed | cancelled`. Transient failures (network, timeout, 408/429/5xx) send it back to `queued` with a backoff until `MAX_ATTEMPTS`; permanent ones (4xx, caps) fail at once. `retry` queues a failed or cancelled job again from scratch; `cancel` stops a queued job at once and a running one at its next heartbeat.
- **Worker**: in-process, `WORKER_CONCURRENCY` jobs at a time. Each claim carries an owner token and a lease that a heartbeat renews; every finishing write is fenced on the token. Expired leases (crash, hang) are reclaimed; on shutdown running jobs go back to the queue.
- **Output**: streamed in 64 KiB chunks straight into `PUT /v1/files` of atc-media as a private file; nothing is buffered whole and nothing partial is kept.
- **Sources**: only those with `SOURCE_<NAME>_URL` and `SOURCE_<NAME>_API_KEY` are offered (`GET /v1/sources` lists them with their filters and CSV columns).

| Source | Reads | Filters |
|---|---|---|
| `atc-audit` | `GET /v1/events/export` (streamed NDJSON) | `source`, `actionPrefix`, `outcome`, `actorId`, `targetType`, `targetId`, `from`, `to` |
| `atc-auth` | `GET /v1/users` | `email` |
| `atc-shortlink` | `GET /v1/links` | `q`, `tag`, `status`, `createdBy` |
| `atc-flags` | `GET /v1/flags` | `q`, `tag`, `kind`, `archived` |
| `atc-media` | `GET /v1/files` (metadata) | – |
| `atc-content` | `GET /v1/namespaces/:ns/keys` | `namespace`*, `locale`*, `missing`, `q` |

## API

All `/v1/*` routes and `/metrics` need `Authorization: Bearer <secret>`. Full contract: [openapi.yaml](openapi.yaml), also at `GET /openapi.yaml`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness, readiness (DB ping, worker state), identity and capabilities |
| GET | `/metrics` | read | Prometheus text |
| GET | `/v1/sources` | read | Configured sources, filters, columns |
| POST | `/v1/exports` | write | `{ source, format: csv\|ndjson, filters?, notifyEmail? }` → `202` job |
| GET | `/v1/exports` | read | Newest first; `status`, `source`, `limit`, `cursor` |
| GET | `/v1/exports/:id` | read | Job with progress (`rows`, `bytes`), timestamps, error, notification state, `expiresAt` |
| POST | `/v1/exports/:id/cancel` | write | Queued: cancelled at once; running: stops at the next heartbeat |
| POST | `/v1/exports/:id/retry` | write | Failed or cancelled only; starts over |
| GET | `/v1/exports/:id/download` | read | `{ url, expiresAt }` signed media URL, `DOWNLOAD_TTL_SEC` |
| DELETE | `/v1/exports/:id` | write | Deletes the media file, then the job; not while running |
| GET | `/v1/stats` | read | Queued, running, last 24 h (succeeded, failed, cancelled, rows, bytes), stored bytes, per source |

Errors are `{ "error": { "code", "message", "details"? } }`: `UNKNOWN_SOURCE`, `INVALID_FILTER`, `NOTIFY_DISABLED`, `VALIDATION_FAILED` (400); `EXPORT_NOT_FOUND` (404); `INVALID_STATE`, `NO_FILE` (409); `MEDIA_ERROR` (502); `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`. A job's own `error.code` is one of `UPSTREAM_ERROR`, `MEDIA_ERROR`, `TOO_MANY_ROWS`, `TOO_LARGE`, `INTERRUPTED`.

## Examples

Scenario walkthroughs for every feature (requests, responses, pitfalls): [examples/README.md](examples/README.md).

## Configuration

All configuration is environment variables; [.env.example](.env.example) documents each.

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3014`, `0.0.0.0` | Listen address |
| `EXPORT_API_KEYS` | required | `id:secret[:role]`; role `read`, `write`, `readwrite` (default) |
| `ACTOR_KEYS` | empty | Key ids (the console) that may name the acting person in an `X-Actor` header; records show that name instead of the key id. Ignored for every other key |
| `MEDIA_URL`, `MEDIA_API_KEY` | required | Destination media service and its key |
| `SOURCE_<AUDIT\|AUTH\|SHORTLINK\|FLAGS\|MEDIA\|CONTENT>_URL` / `_API_KEY` | empty | Source services (both or neither each), read keys |
| `NOTIFY_URL`, `NOTIFY_API_KEY` | empty | Completion e-mails (both or neither) |
| `EXPORT_APP_NAME` | `atc-web` | Sender application in e-mails |
| `WORKER_CONCURRENCY`, `POLL_MS` | `2`, `1000` | Parallel exports, queue polling |
| `LEASE_MS`, `HEARTBEAT_MS`, `DRAIN_MS` | `60000`, `15000`, `10000` | Lease, heartbeat (≤ half the lease), shutdown hand-back window (≤ 25 s) |
| `MAX_ATTEMPTS`, `REQUEST_RETRIES` | `3`, `3` | Runs per job; retries per source request |
| `UPSTREAM_TIMEOUT_MS`, `UPLOAD_TIMEOUT_MS` | `15000`, `600000` | Per source request; per upload |
| `EXPORT_MAX_ROWS`, `EXPORT_MAX_BYTES` | `100000`, `20971520` | Caps per export |
| `EXPORT_RETENTION_DAYS` | `7` | Finished jobs and files are deleted after this |
| `DOWNLOAD_TTL_SEC` | `300` | Signed URL lifetime |
| `DB_PATH`, `DB_BACKUP_DIR` | `./data/export.db` | SQLite file; pre-migration snapshot directory |
| `BODY_LIMIT`, `RATE_LIMIT_MAX` | `65536`, `600` | Request body, requests per key per minute |
| `TRUST_PROXY`, `TLS_CERT_PATH`, `TLS_KEY_PATH`, `LOG_LEVEL` | | As in every service |
| `AUDIT_URL`, `AUDIT_API_KEY` | empty | Forward audit events (both or neither) |

Invalid configuration stops the process at start with a readable message.

## Security notes

- Export files are private media files; the only way in is a signed URL valid `DOWNLOAD_TTL_SEC`. Every URL request is an audit event.
- A `read` key can fetch download URLs and therefore read every exported row. Give it only to callers allowed to see the source data.
- CSV cells: control characters (except tab, CR, LF) are removed, then string cells starting with `=`, `+`, `-`, `@` (also after leading whitespace) or a tab/CR get a `'` prefix so spreadsheets do not evaluate them. Numbers and booleans are written unchanged.
- Filters are validated per source and sent as query parameters; content's namespace is pattern-checked and URL-encoded.
- The service's source keys should be read-only keys on those services. Completion e-mails never contain the download URL.

## Code layout

```
src/
  index.js, application.js   entry point, composition root and lifecycle
  config.js, db.js, types.js  configuration, schema, typedefs
  worker.js                  claim, lease + heartbeat, encode, stream upload, retries, recovery, retention
  domain/
    export-service.js        create, cancel, retry, delete, download, stats
    encoder.js               CSV (RFC 4180, injection guard) and NDJSON
    errors.js                ExportError codes, statuses, transient flag
  sources/                   Source base (filters, cursor paging), one adapter per service, registry
  net/                       ServiceHttp (retries), MediaClient (streamed upload, URLs, delete), Notifier
  store/job-store.js         jobs and fenced state transitions
  http/                      ExportApi routes, ApiKeyAuth, Schemas, Views
test/                        node:test suites with a fake upstream for every service
examples/, docs/READINESS.md
```

## Out of scope by design

- Spreadsheet formats (XLSX), compression, encryption at rest beyond what media provides.
- Scheduled or recurring exports in the service itself: atc-scheduler calls `POST /v1/exports` (see the scheduler's `examples/internal-services.md`).
- Exporting a service that has no paged list API, or file contents from media.
- Resuming a run mid-file: a rerun starts from the beginning.
- An API/worker process split; the worker always runs in the service process.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request and every download URL request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor (or, for an `ACTOR_KEYS` key sending `X-Actor`, that admin as actor and the key in `meta.via`) and `{ type: "export", id }` as target: `atc-export.export.create` (meta: source, format, filters, whether an e-mail was requested), `atc-export.export.cancel`, `atc-export.export.retry`, `atc-export.export.download`, `atc-export.export.delete`. Exported data and e-mail addresses never appear in events. Details: [examples/audit-events.md](examples/audit-events.md).

## Scaling model

**B — single-node stateful.** One process per SQLite file (`instances: 1`) running the API and the worker. Claims are transactional and fenced; see [docs/READINESS.md](docs/READINESS.md).

## Observability

Request logs with request id and trace context; worker logs under `component: worker`. `/metrics` (jobs by status, last 24 h outcomes and bytes, stored bytes, per source, worker events), `/v1/stats` for dashboards, `/ready` with the worker state. See [docs/READINESS.md](docs/READINESS.md).

Audit forwarding is observable too: `audit_forward_enabled`, `audit_forward_events_total{result="recorded|sent|dropped|failed"}` and `audit_forward_pending`. A rising `dropped`, or a `pending` that does not drain, means audit events are being lost or delayed; alert on it.

## Backup / restore

The SQLite file at `DB_PATH` holds the job list; export files live in atc-media and expire with their jobs. `sqlite3 data/export.db "VACUUM INTO 'backup.db'"` takes an online copy. Restore by stopping the service, replacing the file and starting again; running jobs in the copy are recovered as interrupted. Migrations are not reversible.

## License

MIT, see [LICENSE](LICENSE).
