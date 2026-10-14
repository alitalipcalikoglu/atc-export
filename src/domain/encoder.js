/** Turns rows into CSV (RFC 4180, formula-injection guarded) or NDJSON lines. */
export class Encoder {
  /** Cells starting with these are prefixed with `'` so spreadsheets never evaluate them as formulas. */
  static FORMULA = /^[=+\-@\t\r]/;
  // eslint-disable-next-line no-control-regex
  static CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

  /** @param {import('../types.js').Format} format @param {string[]} columns */
  constructor(format, columns) {
    this.format = format;
    this.columns = columns;
  }

  /** First chunk of the file (CSV header line, nothing for NDJSON). */
  header() {
    return this.format === 'csv' ? `${this.columns.map((c) => Encoder.cell(c)).join(',')}\r\n` : '';
  }

  /** @param {Record<string, unknown>} row */
  line(row) {
    if (this.format === 'ndjson') return `${JSON.stringify(row)}\n`;
    return `${this.columns.map((c) => Encoder.cell(row[c])).join(',')}\r\n`;
  }

  /**
   * One CSV cell. Strings are injection-guarded; numbers and booleans are written as is (a negative
   * number is data, not a formula); arrays and objects become JSON. Control characters other than
   * tab, CR and LF are dropped.
   * @param {unknown} value
   */
  static cell(value) {
    if (value === null || value === undefined) return '';
    /** @type {string} */
    let s;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') s = String(value);
    else if (typeof value === 'string') s = Encoder.FORMULA.test(value) ? `'${value}` : value;
    else s = JSON.stringify(value);
    s = s.replace(Encoder.CONTROL, '');
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s;
  }
}
