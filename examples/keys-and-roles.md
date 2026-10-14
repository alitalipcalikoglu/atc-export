# API keys and roles

`EXPORT_API_KEYS=id:secret[:role]`, comma separated; secrets at least 32 characters (`openssl rand -hex 32`). The id is recorded as `createdBy` and as the audit actor.

| Role | Can |
|---|---|
| `read` | sources, list, get, download URL, stats, metrics |
| `write` | create, cancel, retry, delete |
| `readwrite` (default) | both |

```
EXPORT_API_KEYS=atc-console:<64 hex>,reporting:<64 hex>:read,nightly-job:<64 hex>:write
```

A `read` key can fetch download URLs, so it can read every exported row: treat it like access to the source data itself. The service's own keys for the sources (`SOURCE_*_API_KEY`) should be `read` keys there.

## Acting person (`X-Actor`)

A key listed in `ACTOR_KEYS` may say who is behind a call:

```
ACTOR_KEYS=atc-console
```

```bash
curl -s -H "Authorization: Bearer $CONSOLE_KEY" -H "X-Actor: ayse.k" ...
```

Records created by that call carry `ayse.k` (in `createdBy`, `updatedBy`) instead of `atc-console`. The value must match `[A-Za-z0-9][A-Za-z0-9._@-]{0,63}`; anything else, and the header from any key not in the list, is ignored and the key id is recorded. Audit events keep the key as the actor. The console sends the signed-in admin's username.
