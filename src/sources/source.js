import { ExportError } from '../domain/errors.js';

/** @typedef {import('../types.js').FilterSpec} FilterSpec */
/** @typedef {import('../net/service-http.js').ServiceHttp} ServiceHttp */

/**
 * Base for source adapters: filter validation and cursor paging over a `{ items, nextCursor }`
 * list endpoint. Subclasses declare `filters`, `columns`, the list path and `record(item)`.
 */
export class Source {
  /** @param {ServiceHttp} http */
  constructor(http) {
    this.http = http;
  }

  /** @returns {string} */ get id() { throw new Error('abstract'); }
  /** @returns {string} */ get label() { throw new Error('abstract'); }
  /** @returns {Record<string, FilterSpec>} */ get filters() { return {}; }
  /** @returns {string[]} */ get columns() { throw new Error('abstract'); }
  /** Page size the owning service accepts. */ get pageSize() { return 100; }

  /**
   * Validate and normalise caller filters against {@link filters}. Unknown names are rejected.
   * @param {unknown} raw
   * @returns {Record<string, string>}
   */
  validate(raw) {
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new ExportError('INVALID_FILTER', 'filters must be an object');
    /** @type {Record<string, string>} */
    const out = {};
    const given = /** @type {Record<string, unknown>} */ (raw ?? {});
    for (const name of Object.keys(given)) if (!(name in this.filters)) throw new ExportError('INVALID_FILTER', `${this.id} has no filter "${name}"`, { details: { allowed: Object.keys(this.filters) } });
    for (const [name, spec] of Object.entries(this.filters)) {
      const v = given[name];
      if (v === undefined || v === null || v === '') {
        if (spec.required) throw new ExportError('INVALID_FILTER', `filter "${name}" is required for ${this.id}`);
        continue;
      }
      if (typeof v !== 'string') throw new ExportError('INVALID_FILTER', `filter "${name}" must be a string`);
      if (v.length > (spec.maxLength ?? 200)) throw new ExportError('INVALID_FILTER', `filter "${name}" is too long`);
      if (spec.enum && !spec.enum.includes(v)) throw new ExportError('INVALID_FILTER', `filter "${name}" must be one of ${spec.enum.join(', ')}`);
      if (spec.pattern && !new RegExp(spec.pattern).test(v)) throw new ExportError('INVALID_FILTER', `filter "${name}" has an invalid format`);
      if (spec.format === 'date-time' && Number.isNaN(Date.parse(v))) throw new ExportError('INVALID_FILTER', `filter "${name}" must be an ISO date-time`);
      if (spec.format === 'email' && !/^[^\s@]+@[^\s@]+$/.test(v)) throw new ExportError('INVALID_FILTER', `filter "${name}" must be an e-mail address`);
      out[name] = this.normalise(name, v);
    }
    return out;
  }

  /** @param {string} _name @param {string} value */
  normalise(_name, value) {
    return value;
  }

  /** @param {Record<string, string>} _filters @returns {string} */
  listPath(_filters) {
    throw new Error('abstract');
  }

  /** @param {Record<string, unknown>} item @param {Record<string, string>} _filters @returns {Record<string, unknown>} */
  record(item, _filters) {
    return item;
  }

  /**
   * Pages through the list endpoint with its cursor until it runs out.
   * @param {Record<string, string>} filters
   * @param {AbortSignal} signal
   * @returns {AsyncGenerator<Record<string, unknown>>}
   */
  async *rows(filters, signal) {
    /** @type {string|null} */
    let cursor = null;
    const seen = new Set();
    do {
      const sep = this.listPath(filters).includes('?') ? '&' : '?';
      const page = /** @type {{ items: Record<string, unknown>[], nextCursor: string|null }} */ (await this.http.json(`${this.listPath(filters)}${sep}limit=${this.pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal));
      for (const item of page.items) yield this.record(item, filters);
      cursor = page.nextCursor ?? null;
      // A cursor that repeats would loop forever; treat it as an upstream fault.
      if (cursor !== null && seen.has(cursor)) throw new ExportError('UPSTREAM_ERROR', `${this.id} returned a repeating cursor`);
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
  }

  /** @param {Record<string, string>} q */
  static query(q) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }
}
