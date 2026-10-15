# Worker, failures and recovery

The worker runs in the service process. Every `POLL_MS` it claims due jobs up to `WORKER_CONCURRENCY` (2). A claim gives the job a random owner token and a lease (`LEASE_MS`, 60 s); a heartbeat every `HEARTBEAT_MS` renews it, saves progress and checks for a cancel request. Every write that finishes a job is fenced on that token, so a worker that lost its lease can no longer change the job.

## Errors

| Kind | Examples | What happens |
|---|---|---|
| Transient per request | network error, timeout, 408, 429, 5xx | Retried `REQUEST_RETRIES` (3) times with backoff (250 ms, 500 ms, 1 s ...) |
| Transient per run | still failing after those retries; media 5xx during upload | Job back to `queued` with `nextRunAt` (30 s, 60 s, 120 s ... up to 10 min) until `MAX_ATTEMPTS` (3) |
| Permanent | 4xx from the source or media, `TOO_MANY_ROWS`, `TOO_LARGE`, bad filter at run time | `failed` at once |

## Resume

Rows go to a local spool file (`SPOOL_DIR/<job id>.csv`) one source page at a time. After each page the file is synced and the job records a checkpoint: the cursor of the next page, the rows and the bytes so far. When a run is interrupted (a transient failure, a restart, a lost lease) the next run cuts the spool file back to the checkpoint and asks the source only for the pages after it:

```
{"level":30,"job":"exp_…","rows":60000,"bytes":7340032,"msg":"export resumed from its checkpoint"}
```

`/metrics` counts these in `export_worker_events_total{event="resumed"}`. If the spool file is gone or shorter than the checkpoint (another disk, wiped data), the run starts over. `atc-audit` exports are one streamed response without pages, so they always start over. The upload itself is not resumable: a failed upload sends the whole spool file again on the next run.

Media receives only finished files; nothing partial is uploaded. The spool file is deleted when the job succeeds, fails or is cancelled, and the hourly retention pass removes spool files of jobs that no longer exist.

## Crash and restart

On start every `running` job left behind by a previous process is queued again (or failed when its attempts are used up, `error.code: "INTERRUPTED"`). While running, any job whose lease expired (a hung worker) is reclaimed the same way.

## Shutdown

`SIGTERM`: the worker stops claiming, aborts running exports and hands them back to the queue without counting the attempt, waiting at most `DRAIN_MS` (10 s); then HTTP drains and the database closes. PM2's `kill_timeout` (35 s) is above the internal 30 s force exit.
