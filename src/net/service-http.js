import { setTimeout as sleep } from 'node:timers/promises';
import { ExportError } from '../domain/errors.js';

/**
 * Calls one platform service with its bearer key. Transient failures (network, timeout, 429, 5xx)
 * are retried with exponential backoff; everything else fails at once.
 */
export class ServiceHttp {
  /**
   * @param {object} o
   * @param {string} o.id               Service id, used in errors.
   * @param {import('../types.js').Upstream} o.upstream
   * @param {number} o.timeoutMs
   * @param {number} o.retries
   * @param {typeof fetch} [o.fetch]
   * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [o.sleep]
   */
  constructor({ id, upstream, timeoutMs, retries, fetch: fetchImpl = fetch, sleep: sleepImpl = (ms, signal) => sleep(ms, undefined, { signal }) }) {
    this.id = id;
    this.upstream = upstream;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
  }

  /** @param {number} status */
  static transient(status) {
    return status === 408 || status === 429 || status >= 500;
  }

  /** @param {number} attempt */
  static backoffMs(attempt) {
    return Math.min(10_000, 250 * 2 ** attempt);
  }

  /**
   * Request with retries. Returns the successful response; the caller consumes its body.
   * @param {string} method
   * @param {string} path
   * @param {{ signal: AbortSignal, body?: unknown, timeoutMs?: number, retry?: boolean }} o
   * @returns {Promise<Response>}
   */
  async request(method, path, { signal, body, timeoutMs = this.timeoutMs, retry = true }) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let res;
      try {
        res = await this.fetch(`${this.upstream.url}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.upstream.apiKey}`, accept: 'application/json, application/x-ndjson', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (err) {
        if (signal.aborted) throw err;
        if (retry && attempt < this.retries) { await this.sleep(ServiceHttp.backoffMs(attempt), signal); continue; }
        throw new ExportError('UPSTREAM_ERROR', `${this.id} unreachable: ${err instanceof Error ? err.message : String(err)}`, { transient: true });
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      if (retry && ServiceHttp.transient(res.status) && attempt < this.retries) { await this.sleep(ServiceHttp.backoffMs(attempt), signal); continue; }
      let message = `${this.id} responded ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error?.message) message = `${this.id}: ${j.error.message}`; } catch { /* not JSON */ }
      throw new ExportError('UPSTREAM_ERROR', message, { transient: ServiceHttp.transient(res.status), details: { service: this.id, status: res.status } });
    }
  }

  /**
   * @template T
   * @param {string} path
   * @param {AbortSignal} signal
   * @returns {Promise<T>}
   */
  async json(path, signal) {
    const res = await this.request('GET', path, { signal });
    return /** @type {T} */ (await res.json());
  }
}
