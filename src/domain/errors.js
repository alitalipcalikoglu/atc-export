/**
 * Domain error with a stable machine-readable code and the HTTP status the API maps it to.
 * `transient` marks upstream failures worth another attempt.
 */
export class ExportError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    EXPORT_NOT_FOUND: 404,
    UNKNOWN_SOURCE: 400,
    INVALID_FILTER: 400,
    NOTIFY_DISABLED: 400,
    INVALID_STATE: 409,
    NO_FILE: 409,
    TOO_MANY_ROWS: 422,
    TOO_LARGE: 422,
    UPSTREAM_ERROR: 502,
    MEDIA_ERROR: 502,
    INVALID_CURSOR: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof ExportError.STATUS} code
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, transient?: boolean }} [o]
   */
  constructor(code, message, { details, transient = false } = {}) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.statusCode = ExportError.STATUS[code];
    this.details = details;
    this.transient = transient;
  }
}
