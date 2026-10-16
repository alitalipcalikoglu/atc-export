import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';
import { ExportError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/** Bearer API-key authentication with read/write/admin roles. Thin wrapper over service-core's `ApiKeyAuth`. */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys);
  }

  /** Fastify `onRequest` hook. */
  get hook() {
    return this.core.hook;
  }

  /** `admin` does everything and is the only role that may export personal data (sources marked `personal`). */
  static GRANTS = Object.freeze({ read: ['read', 'readwrite', 'admin'], write: ['write', 'readwrite', 'admin'], admin: ['admin'] });

  /** @param {'read'|'write'|'admin'} need */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      grants: ApiKeyAuth.GRANTS,
      roleOf: (request) => /** @type {any} */ (request).apiKey?.role,
      makeError: (n) => new ExportError('FORBIDDEN', `this API key has no ${n} access`),
    });
  }
}
