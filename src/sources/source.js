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
  /** Rows are personal data of people outside the platform (addresses, recipients): only an `admin` export key may export them. */ get personal() { return false; }
  /** @returns {string[]} */ get columns() { throw new Error('abstract'); }
  /** Page size the owning service accepts. */ get pageSize() { return 100; }
  /** Query parameter that carries the cursor, and the response field that holds the next one (every platform list uses `cursor`/`nextCursor`). */
  get cursorParam() { return 'cursor'; }
  get nextField() { return 'nextCursor'; }

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

  /** Whether {@link pages} can start at a saved cursor, so an interrupted export resumes there. */
  get resumable() { return true; }

  /**
   * Pages of the list endpoint from `cursor` (null = the first page) until it runs out. `next` is
   * the cursor of the page after this one, null on the last.
   * @param {Record<string, string>} filters
   * @param {AbortSignal} signal
   * @param {string|null} [cursor]
   * @returns {AsyncGenerator<{ items: Record<string, unknown>[], next: string|null }>}
   */
  async *pages(filters, signal, cursor = null) {
    const seen = new Set();
    do {
      const sep = this.listPath(filters).includes('?') ? '&' : '?';
      const page = /** @type {Record<string, any> & { items: Record<string, unknown>[] }} */ (await this.http.json(`${this.listPath(filters)}${sep}limit=${this.pageSize}${cursor ? `&${this.cursorParam}=${encodeURIComponent(cursor)}` : ''}`, signal));
      /** @type {string|null} */
      const next = page[this.nextField] ?? null;
      // A cursor that repeats would loop forever; treat it as an upstream fault.
      if (next !== null && (seen.has(next) || next === cursor)) throw new ExportError('UPSTREAM_ERROR', `${this.id} returned a repeating cursor`);
      if (next !== null) seen.add(next);
      yield { items: page.items.map((item) => this.record(item, filters)), next };
      cursor = next;
    } while (cursor !== null);
  }

  /**
   * Every row, page after page.
   * @param {Record<string, string>} filters
   * @param {AbortSignal} signal
   * @returns {AsyncGenerator<Record<string, unknown>>}
   */
  async *rows(filters, signal) {
    for await (const page of this.pages(filters, signal)) yield* page.items;
  }

  /** @param {Record<string, string>} q */
  static query(q) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }
}
