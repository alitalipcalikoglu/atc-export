# Completion e-mails

Pass `notifyEmail` when creating an export. When the export succeeds the service sends one e-mail through atc-notify's built-in **`generic`** template (no extra template to install):

```
Idempotency-Key: atc-export:exp_mv7nhnir3b3cab534a3d9f1e:1
```

```json
{
  "channel": "email", "template": "generic", "to": ["ops@example.com"],
  "data": { "locale": "en", "appName": "atc-web", "subject": "Your atc-auth export is ready", "title": "Export ready",
            "paragraphs": ["The CSV export of atc-auth (exp_mv7n...) finished with 1842 rows (412 KB).", "Download it from the console. Export files are deleted automatically after the retention period."] }
}
```

The mail never contains the download URL: it is short-lived and the file is private. The reader opens the console (or calls `download`). `EXPORT_APP_NAME` sets `appName`.

`notification` on the job shows `sent` or `failed`; a failed e-mail never fails the export. Failed and cancelled exports send no mail. Configure:

```
NOTIFY_URL=http://10.0.0.1:3001
NOTIFY_API_KEY=<the export key from NOTIFY_API_KEYS>
```
