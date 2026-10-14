import { ExportError } from '../domain/errors.js';
import { ServiceHttp } from './service-http.js';

/** Export files live in atc-media as private files: streamed upload, signed download URL, delete. */
export class MediaClient {
  /** @param {ServiceHttp} http */
  constructor(http) {
    this.http = http;
  }

  /**
   * Stream `body` into a new private file. Never retried: the body cannot be replayed; a failed
   * upload leaves nothing behind on the media side (it discards the temp file).
   * @param {AsyncIterable<Uint8Array>} body
   * @param {string} name
   * @param {AbortSignal} signal
   * @param {number} timeoutMs
   * @returns {Promise<{ id: string, name: string, size: number }>}
   */
  async upload(body, name, signal, timeoutMs) {
    let res;
    try {
      res = await this.http.fetch(`${this.http.upstream.url}/v1/files?visibility=private&name=${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${this.http.upstream.apiKey}`, 'content-type': 'application/octet-stream' },
        body: /** @type {any} */ (body), // Node fetch streams an async iterable body chunk by chunk
        // @ts-ignore -- Node's fetch needs duplex for a streamed request body.
        duplex: 'half',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ExportError('MEDIA_ERROR', `atc-media upload failed: ${err instanceof Error ? err.message : String(err)}`, { transient: true });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let message = `atc-media responded ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error?.message) message = `atc-media: ${j.error.message}`; } catch { /* not JSON */ }
      throw new ExportError('MEDIA_ERROR', message, { transient: ServiceHttp.transient(res.status), details: { status: res.status } });
    }
    const file = JSON.parse(text).file;
    return { id: String(file.id), name: String(file.name), size: Number(file.size) };
  }

  /**
   * Fresh signed URL for the original.
   * @param {string} id @param {number} ttlSec
   * @returns {Promise<{ url: string, expiresAt: string|null }>}
   */
  async url(id, ttlSec) {
    const res = await this.http.request('POST', `/v1/files/${encodeURIComponent(id)}/urls?ttl=${ttlSec}`, { signal: AbortSignal.timeout(this.http.timeoutMs) }).catch((err) => { throw MediaClient.#wrap(err); });
    const original = (await res.json()).urls.original;
    return { url: String(original.url), expiresAt: original.expiresAt ?? null };
  }

  /** Delete the file; an already missing file counts as deleted. @param {string} id */
  async delete(id) {
    try {
      await this.http.request('DELETE', `/v1/files/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(this.http.timeoutMs) });
    } catch (err) {
      if (err instanceof ExportError && /** @type {any} */ (err.details)?.status === 404) return;
      throw MediaClient.#wrap(err);
    }
  }

  /** @param {unknown} err */
  static #wrap(err) {
    if (err instanceof ExportError) return new ExportError('MEDIA_ERROR', err.message, { transient: err.transient, details: err.details });
    return new ExportError('MEDIA_ERROR', `atc-media: ${err instanceof Error ? err.message : String(err)}`, { transient: true });
  }
}
