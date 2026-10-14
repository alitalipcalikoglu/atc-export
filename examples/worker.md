# Worker, failures and recovery

The worker runs in the service process. Every `POLL_MS` it claims due jobs up to `WORKER_CONCURRENCY` (2). A claim gives the job a random owner token and a lease (`LEASE_MS`, 60 s); a heartbeat every `HEARTBEAT_MS` renews it, saves progress and checks for a cancel request. Every write that finishes a job is fenced on that token, so a worker that lost its lease can no longer change the job.

## Errors

| Kind | Examples | What happens |
|---|---|---|
| Transient per request | network error, timeout, 408, 429, 5xx | Retried `REQUEST_RETRIES` (3) times with backoff (250 ms, 500 ms, 1 s ...) |
| Transient per run | still failing after those retries; media 5xx during upload | Job back to `queued` with `nextRunAt` (30 s, 60 s, 120 s ... up to 10 min) until `MAX_ATTEMPTS` (3) |
| Permanent | 4xx from the source or media, `TOO_MANY_ROWS`, `TOO_LARGE`, bad filter at run time | `failed` at once |

A rerun starts the export from the beginning and uploads a fresh file; nothing partial is ever kept.

## Crash and restart

On start every `running` job left behind by a previous process is queued again (or failed when its attempts are used up, `error.code: "INTERRUPTED"`). While running, any job whose lease expired (a hung worker) is reclaimed the same way.

## Shutdown

`SIGTERM`: the worker stops claiming, aborts running exports and hands them back to the queue without counting the attempt, waiting at most `DRAIN_MS` (10 s); then HTTP drains and the database closes. PM2's `kill_timeout` (35 s) is above the internal 30 s force exit.
