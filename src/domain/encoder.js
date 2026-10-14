/** Turns rows into CSV (RFC 4180, formula-injection guarded) or NDJSON lines. */
export class Encoder {
  /**
   * String cells matching this are prefixed with `'` so spreadsheets never evaluate them: a
   * formula sign after optional leading whitespace, or a leading tab/CR. Tested on the cleaned
   * string, so a control character cannot hide the sign.
   */
  static FORMULA = /^(\s*[=+\-@]|[\t\r])/;
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
   * One CSV cell. Control characters other than tab, CR and LF are dropped first, then strings
   * are injection-guarded. Policy: numbers and booleans stay as they are (a negative number such as
   * -5 is data, not a formula; it never came from a string), so only string values are guarded.
   * Arrays and objects become JSON, cleaned and guarded like strings.
   * @param {unknown} value
   */
  static cell(value) {
    if (value === null || value === undefined) return '';
    /** @type {string} */
    let s;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') s = String(value);
    else {
      s = (typeof value === 'string' ? value : JSON.stringify(value)).replace(Encoder.CONTROL, '');
      if (Encoder.FORMULA.test(s)) s = `'${s}`;
    }
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replaceAll('"', '""')}"` : s;
  }
}
