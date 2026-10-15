# Scheduled exports

The export service has no scheduler of its own: atc-scheduler calls `POST /v1/exports` on a cron. Give the scheduler an export key with the `write` role and name it in the scheduler's `TARGET_KEYS` as `atc-export` (the stack does both).

## Nightly CSV of failed logins

```bash
curl -X POST "$SCHEDULER/v1/jobs" -H "Authorization: Bearer $SCHED_KEY" -H 'content-type: application/json' -d '{
  "name": "export.failed-logins.nightly",
  "schedule": { "cron": "0 2 * * *", "timezone": "Europe/Istanbul" },
  "target": {
    "url": "http://export.internal:3014/v1/exports",
    "method": "POST",
    "body": { "source": "atc-audit", "format": "csv", "filters": { "actionPrefix": "atc-auth.login", "outcome": "failure" }, "notifyEmail": "security@example.com" }
  },
  "targetKey": "atc-export",
  "retry": { "max": 3, "backoffSec": 60 }
}'
```

Every night at 02:00 Istanbul time the scheduler posts the body; the export service answers `202 { job }` at once and builds the file in the background. The scheduler run succeeds when the job is accepted; the export's own retries and resume (see [worker.md](worker.md)) take it from there. With `notifyEmail` the recipient gets a mail with a download link when the file is ready.

## Weekly dead letters of a queue

```json
{
  "name": "export.dead-letters.weekly",
  "schedule": { "cron": "0 6 * * 1" },
  "target": { "url": "http://export.internal:3014/v1/exports", "method": "POST",
              "body": { "source": "atc-queue", "format": "ndjson", "filters": { "queue": "emails", "state": "dead" } } },
  "targetKey": "atc-export"
}
```

## Time windows

Filters are fixed in the job body, so a nightly export of "yesterday" cannot compute its own `from`/`to`. Either export a rolling set the source already narrows (dead letters, failed payments) and let retention drop old files, or run a small script on the schedule that computes the dates and calls `POST /v1/exports` itself.

## Picking up the file

- `GET /v1/exports?status=succeeded&source=atc-audit` lists the finished jobs; `GET /v1/exports/:id/download` returns a short-lived signed URL.
- Files are kept `EXPORT_RETENTION_DAYS` (7) and then deleted with their job: copy them elsewhere if you need them longer.

## Pitfalls

- A scheduler retry after a timeout can create a second job for the same night. Both finish; keep the newer one or add a `name`-based check in the script that calls the API.
- The scheduler's target settings must allow the export host (`TARGET_ALLOW_HTTP`, `TARGET_ALLOW_PRIVATE`, `TARGET_ALLOWED_HOSTS` for internal addresses).
- Large nightly exports need `SPOOL_DIR` space and an atc-media upload limit of at least `EXPORT_MAX_BYTES` for the export key.
