/**
 * Shared JSDoc typedefs for the export service. No runtime exports.
 */

/** @typedef {'read'|'write'|'readwrite'} KeyRole */
/** @typedef {{ id: string, secret: string, role: KeyRole }} ApiKey */
/** @typedef {{ url: string, apiKey: string }} Upstream */
/** @typedef {'csv'|'ndjson'} Format */
/** @typedef {'queued'|'running'|'succeeded'|'failed'|'cancelled'} JobStatus */

/**
 * @typedef {object} WorkerOptions
 * @property {number} concurrency
 * @property {number} pollMs
 * @property {number} leaseMs
 * @property {number} heartbeatMs
 * @property {number} drainMs
 * @property {number} maxAttempts         Job runs before a transient failure becomes final.
 * @property {number} requestRetries      Retries per upstream request on transient errors.
 * @property {number} upstreamTimeoutMs   Per source request.
 * @property {number} uploadTimeoutMs     Whole upload of one export.
 */

/**
 * @typedef {object} Limits
 * @property {number} maxRows
 * @property {number} maxBytes
 * @property {number} retentionDays
 * @property {number} downloadTtlSec
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {Upstream|null} audit   Audit service to forward events to; null = off.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {ApiKey[]} apiKeys
 * @property {string[]} actorKeys   Key ids whose `X-Actor` header names the acting person.
 * @property {number} rateLimitMax
 * @property {Upstream} media        Where export files are stored.
 * @property {Upstream|null} notify  Optional completion e-mails.
 * @property {string} appName        Shown in completion e-mails.
 * @property {Record<string, Upstream>} sources  Configured source services by id.
 * @property {WorkerOptions} worker
 * @property {Limits} limits
 */

/**
 * @typedef {object} JobRow
 * @property {string} id
 * @property {string} source
 * @property {Format} format
 * @property {string} filters        JSON object.
 * @property {string|null} notify_email
 * @property {JobStatus} status
 * @property {number} attempts
 * @property {number} max_attempts
 * @property {number|null} next_run_at
 * @property {string|null} owner_token
 * @property {number|null} lease_until
 * @property {number} cancel_requested
 * @property {number} rows
 * @property {number} bytes
 * @property {string|null} file_id
 * @property {string|null} file_name
 * @property {string|null} error_code
 * @property {string|null} error
 * @property {string|null} notify_status  'sent' | 'failed' | null
 * @property {string} created_by
 * @property {number} created_at
 * @property {number|null} started_at
 * @property {number|null} finished_at
 * @property {number} updated_at
 */

/**
 * One source of rows: describes its filters and pages through the owning service.
 * @typedef {object} SourceAdapter
 * @property {string} id
 * @property {string} label
 * @property {Record<string, FilterSpec>} filters
 * @property {string[]} columns                CSV header, in order.
 * @property {(filters: Record<string, string>, signal: AbortSignal) => AsyncIterable<Record<string, unknown>>} rows
 */

/**
 * @typedef {object} FilterSpec
 * @property {'string'} type
 * @property {string} description
 * @property {boolean} [required]
 * @property {string[]} [enum]
 * @property {string} [pattern]
 * @property {number} [maxLength]
 * @property {'date-time'|'email'} [format]
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */
/** @typedef {{ info: Function, warn: Function, error: Function }} MinimalLogger */

export {};
