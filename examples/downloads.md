# Downloading the file

```bash
ecurl $EXPORT/v1/exports/exp_0mv7nhnir3b3cab534a3d/download
```

```json
{ "url": "https://media.example.com/files/f_8c1.../original?exp=1791968700&sig=...", "expiresAt": "2026-10-14T09:05:00.000Z" }
```

The file is a **private** atc-media file; the URL is signed by media and valid for `DOWNLOAD_TTL_SEC` (300 s by default). Fetch a new URL whenever you need one; every download URL request is an audit event (`atc-export.export.download`). Media serves export files as attachments, never inline.

## Deleting

```bash
ecurl -X DELETE $EXPORT/v1/exports/exp_0mv7nhnir3b3cab534a3d     # 204
```

The media file is deleted first, then the job. A running job must be cancelled first (`409 INVALID_STATE`). When media cannot be reached the delete fails with `502 MEDIA_ERROR` and the job stays, so no file is ever orphaned silently.

## Pitfalls

- `409 NO_FILE`: the job did not succeed, or it was an NDJSON export with no rows.
- The URL works for anyone who has it until it expires. Do not paste it into tickets; share the job id instead.
