# Progress, cancel and retry

```
queued ──claim──> running ──> succeeded
   │                 │ └────> failed      (permanent error, or attempts used up)
   │                 │ └────> queued      (transient error: nextRunAt set, attempts left)
   └──cancel──> cancelled <──cancel (at the next heartbeat)
failed / cancelled ──retry──> queued (attempts reset)
```

## Following a job

```bash
ecurl $EXPORT/v1/exports/exp_0mv7nhnir3b3cab534a3d
```

```json
{ "export": { "status": "running", "attempts": 1, "progress": { "rows": 41200, "bytes": 5832110 }, "startedAt": "2026-10-14T09:00:01.000Z" } }
```

`progress` is updated with every heartbeat (`HEARTBEAT_MS`, 15 s). When finished: `status`, `finishedAt`, `file.name`, `expiresAt` (when retention removes it) and, for failures, `error.code` and `error.message`.

List and filter:

```bash
ecurl "$EXPORT/v1/exports?status=failed&limit=20"     # newest first; pass nextCursor back as cursor
```

## Scenario: the wrong filter was used, stop it

```bash
ecurl -X POST $EXPORT/v1/exports/exp_0mv7nhnir3b3cab534a3d/cancel
```

A queued job is `cancelled` at once. A running one answers with `cancelRequested: true`; within one heartbeat the worker stops reading, aborts the upload (media keeps nothing) and the job turns `cancelled`. An export that finishes before the heartbeat notices stays `succeeded`.

## Scenario: the source was down overnight

The job shows `failed` with `error.code: "UPSTREAM_ERROR"` after `MAX_ATTEMPTS` runs. Once the source is back:

```bash
ecurl -X POST $EXPORT/v1/exports/exp_0mv7nhnir3b3cab534a3d/retry
```

The job is queued again from scratch: attempts reset, progress and error cleared. Only `failed` and `cancelled` jobs can be retried (`409 INVALID_STATE` otherwise).
