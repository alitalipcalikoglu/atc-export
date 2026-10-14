import { ExportError } from '../domain/errors.js';
import { ServiceHttp } from '../net/service-http.js';
import { ADAPTERS } from './adapters.js';

/** @typedef {import('./source.js').Source} Source */

/** The configured sources: only services with a URL and read key in the environment are offered. */
export class SourceRegistry {
  /** @param {Source[]} sources */
  constructor(sources) {
    /** @type {Map<string, Source>} */
    this.byId = new Map(sources.map((s) => [s.id, s]));
  }

  /**
   * @param {Record<string, import('../types.js').Upstream>} configured
   * @param {{ timeoutMs: number, retries: number, fetch?: typeof fetch, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} o
   */
  static fromConfig(configured, o) {
    return new SourceRegistry(Object.entries(configured).map(([id, upstream]) => {
      const Adapter = ADAPTERS[/** @type {keyof typeof ADAPTERS} */ (id)];
      return new Adapter(new ServiceHttp({ id, upstream, ...o }));
    }));
  }

  /** @param {string} id */
  get(id) {
    const s = this.byId.get(id);
    if (!s) throw new ExportError('UNKNOWN_SOURCE', `source "${id}" is not configured`, { details: { available: [...this.byId.keys()] } });
    return s;
  }

  list() {
    return [...this.byId.values()].map((s) => ({ id: s.id, label: s.label, formats: ['csv', 'ndjson'], columns: s.columns, filters: s.filters }));
  }
}
