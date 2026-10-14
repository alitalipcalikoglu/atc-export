# Audit events

Set both variables to forward events to the audit service (repository `atc-audit`); leave both empty to keep the service silent:

```
AUDIT_URL=http://10.0.0.5:3005
AUDIT_API_KEY=<the export key from AUDIT_API_KEYS, role write>
```

Events are buffered in memory (up to 5 000), flushed every 2 seconds in batches, retried with backoff and idempotent ids. A request is never slowed down or failed by auditing.

## Actions

One event per completed request, `outcome: "success"` for 2xx, `"denied"` when the key's role refused it (403). Validation errors are not events. Target: `{ "type": "export", "id": "<id>" }`.

| Action | Request | `meta` |
|---|---|---|
| `atc-export.export.create` | `POST /v1/exports` | `source`, `format`, `filters`, `notify` (whether an e-mail was asked for; never the address) |
| `atc-export.export.cancel` | `POST /v1/exports/:id/cancel` | `status` after the request |
| `atc-export.export.retry` | `POST /v1/exports/:id/retry` | |
| `atc-export.export.download` | `GET /v1/exports/:id/download` | |
| `atc-export.export.delete` | `DELETE /v1/exports/:id` | |

Exported data never appears in events. Query the audit service by `source=atc-export` or `actionPrefix=atc-export.`.
