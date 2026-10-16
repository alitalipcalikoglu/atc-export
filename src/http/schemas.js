import { Ids } from '@atc-web/atc-service-core/ids';

/** JSON Schemas for the HTTP surface. Per-source filters are validated by the source adapter. */
export class Schemas {
  static id = { type: 'string', pattern: Ids.pattern('exp') };
  static source = { type: 'string', pattern: '^atc-[a-z][a-z0-9-]{0,30}$' };
  static status = { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] };

  static create = {
    type: 'object', additionalProperties: false, required: ['source', 'format'],
    properties: {
      source: Schemas.source,
      format: { type: 'string', enum: ['csv', 'ndjson'] },
      filters: { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', maxLength: 254 } },
      notifyEmail: { type: 'string', format: 'email', maxLength: 254 },
    },
  };
  static idParams = { type: 'object', properties: { id: Schemas.id }, required: ['id'] };
  static listQuery = {
    type: 'object', additionalProperties: false,
    properties: { status: Schemas.status, source: Schemas.source, limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' }, cursor: Schemas.id },
  };
}
