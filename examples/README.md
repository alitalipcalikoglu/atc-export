# export examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `EXPORT_API_KEYS`. Base URL below is `http://localhost:3014`.

| Example | Shows |
|---|---|
| [Starting an export](creating-exports.md) | Source, format, filters, the job you get back, what can be rejected |
| [Sources and filters](sources.md) | What each source exports, its filters and columns, how to enable a source |
| [CSV and NDJSON output](formats.md) | Quoting, the formula-injection guard, nested values, empty exports |
| [Progress, cancel and retry](progress-cancel-retry.md) | Job states, polling progress, cancelling a running export, retrying a failed one |
| [Downloading the file](downloads.md) | Short-lived signed URLs, why the file is private, deleting a job |
| [Completion e-mails](notifications.md) | `notifyEmail`, the notify template used, what the mail says |
| [Worker, failures and recovery](worker.md) | Leases, heartbeats, transient vs permanent errors, restarts, shutdown |
| [Retention](retention.md) | How long jobs and files are kept |
| [API keys and roles](keys-and-roles.md) | Read, write, readwrite |
| [Operations](operations.md) | Health, readiness, metrics, stats, PM2, Docker, backups |
| [Audit events](audit-events.md) | Which actions are forwarded to the audit service |

Set up once for the examples:

```bash
export EXPORT=http://localhost:3014
export KEY=<a readwrite secret from EXPORT_API_KEYS>
alias ecurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```
