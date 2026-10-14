# Retention

Finished jobs (`succeeded`, `failed`, `cancelled`) and their media files are deleted `EXPORT_RETENTION_DAYS` (7) after `finishedAt`; each job shows the moment as `expiresAt`. Queued and running jobs are never removed by retention.

The worker runs retention hourly: for each expired job it deletes the media file, then the job. If media cannot be reached the job is kept and tried again next hour, so a file is never left without a job that points at it.

## Scenario: keep monthly reports longer

Retention is per service, not per job. Download what must be kept and store it elsewhere, or run a separate instance with a longer `EXPORT_RETENTION_DAYS`.
