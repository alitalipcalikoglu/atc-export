# Starting an export

## Scenario: all suspended users as a spreadsheet

```bash
ecurl -X POST $EXPORT/v1/exports -d '{ "source": "atc-auth", "format": "csv", "notifyEmail": "ops@example.com" }'
```

`202`, with `Location: /v1/exports/<id>`:

```json
{
  "export": {
    "id": "exp_mv7nhnir3b3cab534a3d9f1e",
    "source": "atc-auth", "format": "csv", "filters": {}, "notifyEmail": "ops@example.com",
    "status": "queued", "attempts": 0, "maxAttempts": 3, "nextRunAt": null, "cancelRequested": false,
    "progress": { "rows": 0, "bytes": 0 }, "file": null, "error": null, "notification": null,
    "createdBy": "atc-console", "createdAt": "2026-10-14T09:00:00.000Z", "startedAt": null, "finishedAt": null,
    "expiresAt": null
  }
}
```

The request returns at once; the worker picks the job up within `POLL_MS` (one second by default) and you follow it with `GET /v1/exports/<id>` (see [progress](progress-cancel-retry.md)).

## With filters

```bash
ecurl -X POST $EXPORT/v1/exports -d '{ "source": "atc-audit", "format": "ndjson", "filters": { "actionPrefix": "atc-auth.login", "outcome": "failure", "from": "2026-10-01T00:00:00Z" } }'
```

Filters are strings only, and every name must be one the source lists in `GET /v1/sources` ([sources](sources.md)).

## Pitfalls

- `400 UNKNOWN_SOURCE`: the source is not configured on this instance (`details.available` lists what is).
- `400 INVALID_FILTER`: an unknown filter name, a wrong value (`outcome: "meh"`), a missing required filter (content needs `namespace` and `locale`).
- `400 NOTIFY_DISABLED`: `notifyEmail` was given but the service has no `NOTIFY_URL`/`NOTIFY_API_KEY`.
- Filters are validated when the job is created; the source can still refuse them at run time (for example a namespace that does not exist), which fails the job with the source's own message.
