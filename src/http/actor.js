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
}
