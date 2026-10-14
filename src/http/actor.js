import { AuditClient } from '@atc-web/atc-service-core/audit';

/**
 * Who a write is attributed to. Normally the calling API key's id. A key listed in ACTOR_KEYS
 * (the console) may name the person behind the call in `X-Actor` (`admin`, `ali.k`); the header is
 * ignored for every other key, so a service key can never impersonate someone.
 */
export class Actor {
  static HEADER = 'x-actor';
  static PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

  /** @param {readonly string[]} trustedKeyIds */
  constructor(trustedKeyIds) {
    this.trusted = new Set(trustedKeyIds);
  }

  /** @param {import('fastify').FastifyRequest} request */
  of(request) {
    const key = /** @type {{ id: string }|null|undefined} */ (request.apiKey)?.id;
    if (!key) return 'anonymous';
    const named = request.headers[Actor.HEADER];
    if (typeof named === 'string' && this.trusted.has(key) && Actor.PATTERN.test(named)) return named;
    return key;
  }

  /**
   * The audit `onSend` hook, with the person named in X-Actor (when honored) as the event's actor
   * (`{ type: 'admin', id }`) and the calling key kept as `meta.via`.
   * @param {import('@atc-web/atc-service-core/audit').AuditClient|undefined} client
   * @returns {import('fastify').onSendAsyncHookHandler}
   */
  auditHook(client) {
    const actor = this;
    return async function auditOnSend(request, reply, payload) {
      const key = /** @type {{ id: string }|null|undefined} */ (request.apiKey)?.id;
      const who = actor.of(request);
      if (!client || !key || who === key) return AuditClient.hook(client).call(this, request, reply, payload);
      const named = /** @type {AuditClient} */ (/** @type {unknown} */ ({
        get enabled() { return client.enabled; },
        record: (/** @type {import('@atc-web/atc-service-core/audit').AuditEvent} */ e) => client.record({ ...e, actor: { type: 'admin', id: who }, meta: { ...e.meta, via: key } }),
      }));
      return AuditClient.hook(named).call(this, request, reply, payload);
    };
  }
}
