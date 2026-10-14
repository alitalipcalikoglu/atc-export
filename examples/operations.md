# Operations

```bash
curl -s $EXPORT/health        # {"status":"ok"}
curl -s $EXPORT/ready         # {"status":"ok","worker":"running"}  database ping, cached 10 s
curl -s $EXPORT/v1/info       # capabilities include source:<id> per configured source
ecurl $EXPORT/v1/stats        # queued, running, last24h { succeeded, failed, cancelled, rows, bytes }, storedBytes, bySource
ecurl $EXPORT/metrics
```

```
export_jobs{status="queued"} 1
export_jobs_finished_24h{outcome="failed"} 0
export_bytes_24h 5832110
export_stored_bytes 12938112
export_worker_events_total{event="retried"} 2
export_worker_in_flight 1
```

## Running

```bash
cp .env.example .env        # EXPORT_API_KEYS, MEDIA_URL/MEDIA_API_KEY, the sources you want
npm ci --omit=dev
pm2 start ecosystem.config.cjs
```

atc-media must accept the files: add `text/csv,application/x-ndjson` to its `ALLOWED_TYPES` and keep its `MAX_UPLOAD_BYTES` at or above `EXPORT_MAX_BYTES`.

Docker:

```bash
docker build -t atc-export .
docker run -d -p 3014:3014 -v export-data:/data --env-file .env atc-export
```

## Backups

State is the SQLite file at `DB_PATH` (job list and progress). The files themselves live in atc-media. `sqlite3 data/export.db "VACUUM INTO 'backup.db'"` takes an online copy.

## Pitfalls

- One process per database file (`instances: 1`).
- Exports read through the sources' public list APIs and count against their rate limits; `WORKER_CONCURRENCY` bounds the load.
