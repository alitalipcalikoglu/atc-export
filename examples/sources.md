# Sources and filters

```bash
ecurl $EXPORT/v1/sources
```

```json
{ "items": [
  { "id": "atc-auth", "label": "Users", "formats": ["csv", "ndjson"],
    "columns": ["id", "email", "name", "status", "emailVerified", "emailVerifiedAt", "lockedUntil", "passwordChangedAt", "createdAt", "updatedAt"],
    "filters": { "email": { "type": "string", "format": "email", "maxLength": 254, "description": "Exact e-mail address." } } }
] }
```

Only sources whose `SOURCE_<NAME>_URL` and `SOURCE_<NAME>_API_KEY` are both set appear. Each source pages through the owning service's own list endpoint with its cursor, using that read key; nothing is copied or cached in between.

| Source | Reads | Filters | Notes |
|---|---|---|---|
| `atc-audit` | `GET /v1/events/export` (streamed NDJSON) | `source`, `actionPrefix`, `outcome`, `actorId`, `targetType`, `targetId`, `from`, `to` | Oldest first; audit's own `EXPORT_MAX_ROWS` (100 000) caps it as well |
| `atc-auth` | `GET /v1/users` | `email` | No password hashes or tokens exist in that API |
| `atc-shortlink` | `GET /v1/links` | `q`, `tag`, `status`, `createdBy` | Click counters as of the export |
| `atc-flags` | `GET /v1/flags` | `q`, `tag`, `kind`, `archived` | `environments` is one JSON column in CSV |
| `atc-media` | `GET /v1/files` | – | Metadata only; never bytes or signed URLs |
| `atc-content` | `GET /v1/namespaces/:ns/keys` | `namespace` (required), `locale` (required), `missing`, `q` | The draft value in that locale; `missing=true` lists untranslated keys |
| `atc-payments` | `GET /v1/payments` | `status` | Contains customer e-mail addresses and metadata; treat the file like the payments themselves |
| `atc-payments-ledger` | `GET /v1/ledger` | – | One row per charge or refund (signed minor units); shares `SOURCE_PAYMENTS_*` with `atc-payments` |
| `atc-status` | `GET /v1/incidents` | `monitor`, `state` | Incidents with cause and duration |
| `atc-status-alerts` | `GET /v1/alerts` | `state` | Operational alerts; shares `SOURCE_STATUS_*` |
| `atc-queue` | `GET /v1/queues/:q/messages` | `queue` (required), `state` | Dead letters unless `state` says otherwise; includes message bodies (application data) |
| `atc-scheduler` | `GET /v1/runs` | `job`, `status` | Newest first; attempt logs are left out |
| `atc-webhook-out` | `GET /v1/deliveries` | `status`, `subscription` | Newest first; response bodies and attempt logs are left out |
| `atc-notify` | `GET /v1/messages` | `status` | **Personal data.** Every sender's recipients (`to`, never the template data): `SOURCE_NOTIFY_API_KEY` must be an `admin` key on notify, and only an `admin` export key may create this export (`403 FORBIDDEN` for `write`/`readwrite`); the listing says `personal: true` |
| `atc-notify-suppressions` | `GET /v1/suppressions` | – | **Personal data.** The suppression list; same two admin keys |

## Scenario: hand untranslated Turkish strings to a translator

```bash
ecurl -X POST $EXPORT/v1/exports -d '{ "source": "atc-content", "format": "csv", "filters": { "namespace": "web", "locale": "tr", "missing": "true" } }'
```

## Enabling a source

```
SOURCE_SHORTLINK_URL=http://10.0.0.6:3006
SOURCE_SHORTLINK_API_KEY=<the export key from SHORTLINK_API_KEYS, role read>
```

Restart the service; `GET /v1/info` lists `source:atc-shortlink` in its capabilities.
