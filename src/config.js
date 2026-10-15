import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/atc-service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */
/** @typedef {import('./types.js').Upstream} Upstream */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  /** Source id -> env prefix of its `<PREFIX>_URL` / `<PREFIX>_API_KEY` pair. */
  static SOURCES = /** @type {const} */ ({ 'atc-audit': 'SOURCE_AUDIT', 'atc-auth': 'SOURCE_AUTH', 'atc-shortlink': 'SOURCE_SHORTLINK', 'atc-flags': 'SOURCE_FLAGS', 'atc-media': 'SOURCE_MEDIA', 'atc-content': 'SOURCE_CONTENT', 'atc-payments': 'SOURCE_PAYMENTS', 'atc-payments-ledger': 'SOURCE_PAYMENTS', 'atc-status': 'SOURCE_STATUS', 'atc-status-alerts': 'SOURCE_STATUS', 'atc-queue': 'SOURCE_QUEUE', 'atc-scheduler': 'SOURCE_SCHEDULER', 'atc-webhook-out': 'SOURCE_WEBHOOK_OUT', 'atc-notify': 'SOURCE_NOTIFY', 'atc-notify-suppressions': 'SOURCE_NOTIFY' });

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.actorKeys = v.actorKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.media = v.media;
    this.notify = v.notify;
    this.appName = v.appName;
    this.sources = Object.freeze({ ...v.sources });
    this.worker = Object.freeze({ ...v.worker });
    this.limits = Object.freeze({ ...v.limits });
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    const media = Config.#upstream(r, 'MEDIA', true);
    /** @type {Record<string, Upstream>} */
    const sources = {};
    for (const [id, prefix] of Object.entries(Config.SOURCES)) {
      const u = Config.#upstream(r, prefix, false);
      if (u) sources[id] = u;
    }
    const leaseMs = r.integer('LEASE_MS', 60_000, { min: 5_000 });
    const heartbeatMs = r.integer('HEARTBEAT_MS', 15_000, { min: 1_000 });
    if (heartbeatMs * 2 > leaseMs) throw new ConfigError('HEARTBEAT_MS must be at most half of LEASE_MS');

    const apiKeys = Config.#parseApiKeys(r.required('EXPORT_API_KEYS'));
    return new Config({
      port: r.integer('PORT', 3014, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/export.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys,
      actorKeys: Config.#actorKeys(r, apiKeys),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
      media: /** @type {Upstream} */ (media),
      notify: Config.#upstream(r, 'NOTIFY', false),
      appName: r.optional('EXPORT_APP_NAME') || 'atc-web',
      sources,
      worker: {
        concurrency: r.integer('WORKER_CONCURRENCY', 2, { min: 1, max: 32 }),
        pollMs: r.integer('POLL_MS', 1_000, { min: 50 }),
        leaseMs,
        heartbeatMs,
        drainMs: r.integer('DRAIN_MS', 10_000, { min: 0, max: 25_000 }),
        maxAttempts: r.integer('MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
        requestRetries: r.integer('REQUEST_RETRIES', 3, { min: 0, max: 10 }),
        upstreamTimeoutMs: r.integer('UPSTREAM_TIMEOUT_MS', 15_000, { min: 500 }),
        uploadTimeoutMs: r.integer('UPLOAD_TIMEOUT_MS', 600_000, { min: 5_000 }),
        spoolDir: r.optional('SPOOL_DIR') || './data/spool',
      },
      limits: {
        maxRows: r.integer('EXPORT_MAX_ROWS', 1_000_000, { min: 1 }),
        maxBytes: r.integer('EXPORT_MAX_BYTES', 268_435_456, { min: 1_024 }),
        retentionDays: r.integer('EXPORT_RETENTION_DAYS', 7, { min: 1 }),
        downloadTtlSec: r.integer('DOWNLOAD_TTL_SEC', 300, { min: 30, max: 86_400 }),
      },
    });
  }

  /**
   * `<PREFIX>_URL` + `<PREFIX>_API_KEY`, both or neither.
   * @param {EnvReader} r
   * @param {string} prefix
   * @param {boolean} required
   * @returns {Upstream|null}
   */
  static #upstream(r, prefix, required) {
    const url = r.optional(`${prefix}_URL`).replace(/\/+$/, '');
    const apiKey = r.optional(`${prefix}_API_KEY`);
    if (!url && !apiKey) {
      if (required) throw new ConfigError(`${prefix}_URL and ${prefix}_API_KEY are required`);
      return null;
    }
    if (!url || !apiKey) throw new ConfigError(`${prefix}_URL and ${prefix}_API_KEY must be set together`);
    if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) throw new ConfigError(`${prefix}_URL must be an absolute http(s) URL`);
    if (apiKey.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`${prefix}_API_KEY must be at least ${Config.MIN_SECRET_LENGTH} characters`);
    return { url, apiKey };
  }

  /**
   * `ACTOR_KEYS`: ids of keys allowed to name the acting person in `X-Actor` (the console).
   * @param {EnvReader} r @param {ApiKey[]} apiKeys
   */
  static #actorKeys(r, apiKeys) {
    const ids = r.optional('ACTOR_KEYS').split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) if (!apiKeys.some((k) => k.id === id)) throw new ConfigError(`ACTOR_KEYS names "${id}", which is not a key id in the API keys`);
    return ids;
  }

  /**
   * Parse `id:secret[:role]`. Role defaults to `readwrite`.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'EXPORT_API_KEYS', { roles: ['read', 'write', 'readwrite'], minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read, write or readwrite' })
      .map(({ id, secret, role }) => ({ id, secret, role: /** @type {KeyRole} */ (role) }));
  }
}
