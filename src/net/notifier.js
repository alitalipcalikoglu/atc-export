/**
 * Completion e-mail through atc-notify's `generic` template. Idempotent per job attempt, so a
 * retried send never mails twice. Never carries the download URL (it is short-lived and
 * private); the mail points the reader at the console.
 */
export class Notifier {
  /**
   * @param {import('./service-http.js').ServiceHttp|null} http
   * @param {string} appName
   */
  constructor(http, appName) {
    this.http = http;
    this.appName = appName;
  }

  get enabled() {
    return this.http !== null;
  }

  /**
   * @param {import('../types.js').JobRow} job
   * @param {{ rows: number, bytes: number, fileName: string|null }} result
   */
  async exportReady(job, result) {
    if (!this.http || !job.notify_email) return;
    const size = result.bytes >= 1_048_576 ? `${(result.bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(result.bytes / 1024))} KB`;
    await this.http.request('POST', '/v1/messages', {
      signal: AbortSignal.timeout(this.http.timeoutMs),
      body: {
        channel: 'email',
        template: 'generic',
        to: [job.notify_email],
        idempotencyKey: `atc-export:${job.id}:${job.attempts}`,
        data: {
          locale: 'en',
          appName: this.appName,
          subject: `Your ${job.source} export is ready`,
          title: 'Export ready',
          paragraphs: [
            `The ${job.format.toUpperCase()} export of ${job.source} (${job.id}) finished with ${result.rows} rows (${size}).`,
            'Download it from the console. Export files are deleted automatically after the retention period.',
          ],
        },
      },
    });
  }
}
