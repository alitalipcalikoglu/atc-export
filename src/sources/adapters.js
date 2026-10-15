import { ExportError } from '../domain/errors.js';
import { Source } from './source.js';

/** @typedef {import('../types.js').FilterSpec} FilterSpec */

const iso = { type: /** @type {const} */ ('string'), format: /** @type {const} */ ('date-time'), maxLength: 40 };

/** Audit events, read through audit's own streaming export (oldest first, audit's EXPORT_MAX_ROWS applies). */
export class AuditEventsSource extends Source {
  get id() { return 'atc-audit'; }
  get label() { return 'Audit events'; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() {
    return {
      source: { type: 'string', description: 'Emitting service (key id), e.g. atc-auth.', pattern: '^[A-Za-z0-9_-]{1,64}$' },
      actionPrefix: { type: 'string', description: 'Action prefix, e.g. atc-auth.login.', maxLength: 120, pattern: '^[a-z0-9][a-z0-9-]*(\\.[a-z0-9_-]*){0,5}$' },
      outcome: { type: 'string', description: 'Outcome.', enum: ['success', 'failure', 'denied'] },
      actorId: { type: 'string', description: 'Actor id.', maxLength: 128 },
      targetType: { type: 'string', description: 'Target type.', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
      targetId: { type: 'string', description: 'Target id.', maxLength: 128 },
      from: { ...iso, description: 'Inclusive lower bound on event time.' },
      to: { ...iso, description: 'Exclusive upper bound on event time.' },
    };
  }
  get columns() { return ['seq', 'id', 'at', 'source', 'action', 'outcome', 'actorType', 'actorId', 'targetType', 'targetId', 'ip', 'userAgent', 'requestId', 'meta']; }

  /** @param {Record<string, unknown>} e */
  record(e) {
    const actor = /** @type {Record<string, unknown>|null} */ (e.actor ?? null);
    const target = /** @type {Record<string, unknown>|null} */ (e.target ?? null);
    return { seq: e.seq, id: e.id, at: e.at, source: e.source, action: e.action, outcome: e.outcome, actorType: actor?.type ?? null, actorId: actor?.id ?? null, targetType: target?.type ?? null, targetId: target?.id ?? null, ip: e.ip ?? null, userAgent: e.userAgent ?? null, requestId: e.requestId ?? null, meta: e.meta ?? null };
  }

  /**
   * Streams NDJSON line by line; never holds more than one network chunk plus one partial line.
   * @param {Record<string, string>} filters
   * @param {AbortSignal} signal
   */
  async *rows(filters, signal) {
    const res = await this.http.request('GET', `/v1/events/export${Source.query({ ...filters, format: 'ndjson' })}`, { signal });
    if (!res.body) return;
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (res.body))) {
      rest += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl).trim();
        rest = rest.slice(nl + 1);
        if (line) yield this.record(AuditEventsSource.#parse(line));
      }
    }
    rest += decoder.decode();
    if (rest.trim()) yield this.record(AuditEventsSource.#parse(rest.trim()));
  }

  /** @param {string} line */
  static #parse(line) {
    try { return JSON.parse(line); } catch { throw new ExportError('UPSTREAM_ERROR', 'atc-audit sent a malformed export line'); }
  }
}

/** Users of the auth service (no secrets: auth never returns password hashes). */
export class AuthUsersSource extends Source {
  get id() { return 'atc-auth'; }
  get label() { return 'Users'; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() { return { email: { type: 'string', format: 'email', maxLength: 254, description: 'Exact e-mail address.' } }; }
  get columns() { return ['id', 'email', 'name', 'status', 'emailVerified', 'emailVerifiedAt', 'lockedUntil', 'passwordChangedAt', 'createdAt', 'updatedAt']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/users${Source.query({ email: f.email })}`; }
  /** @param {Record<string, unknown>} u */
  record(u) { return Object.fromEntries(this.columns.map((c) => [c, u[c] ?? null])); }
}

/** Short links with their click counters. */
export class ShortlinkLinksSource extends Source {
  get id() { return 'atc-shortlink'; }
  get label() { return 'Short links'; }
  get pageSize() { return 200; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() {
    return {
      q: { type: 'string', maxLength: 200, description: 'Search in code, URL and note.' },
      tag: { type: 'string', maxLength: 40, description: 'Tag.' },
      status: { type: 'string', enum: ['active', 'disabled', 'expired', 'exhausted'], description: 'Status.' },
      createdBy: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Creating API key id.' },
    };
  }
  get columns() { return ['code', 'shortUrl', 'url', 'status', 'enabled', 'permanent', 'clicks', 'maxClicks', 'remainingClicks', 'lastClickAt', 'expiresAt', 'tags', 'note', 'createdBy', 'createdAt', 'updatedAt']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/links${Source.query({ q: f.q, tag: f.tag, status: f.status, createdBy: f.createdBy })}`; }
  /** @param {Record<string, unknown>} l */
  record(l) { return Object.fromEntries(this.columns.map((c) => [c, l[c] ?? null])); }
}

/** Feature flags with their per-environment state. */
export class FlagsSource extends Source {
  get id() { return 'atc-flags'; }
  get label() { return 'Feature flags'; }
  get pageSize() { return 200; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() {
    return {
      q: { type: 'string', maxLength: 120, description: 'Search in key and description.' },
      tag: { type: 'string', maxLength: 40, description: 'Tag.' },
      kind: { type: 'string', enum: ['boolean', 'string', 'number', 'json'], description: 'Value kind.' },
      archived: { type: 'string', enum: ['true', 'false'], description: 'Archived flags instead of active ones.' },
    };
  }
  get columns() { return ['key', 'kind', 'description', 'tags', 'archived', 'environments', 'createdBy', 'createdAt', 'updatedAt']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/flags${Source.query({ q: f.q, tag: f.tag, kind: f.kind, archived: f.archived })}`; }
  /** @param {Record<string, unknown>} x */
  record(x) { return Object.fromEntries(this.columns.map((c) => [c, x[c] ?? null])); }
}

/** File metadata from media (never the bytes, never signed URLs). */
export class MediaFilesSource extends Source {
  get id() { return 'atc-media'; }
  get label() { return 'Media files'; }
  get columns() { return ['id', 'name', 'mime', 'size', 'width', 'height', 'sha256', 'visibility', 'createdAt']; }
  listPath() { return '/v1/files'; }
  /** @param {Record<string, unknown>} f */
  record(f) { return Object.fromEntries(this.columns.map((c) => [c, f[c] ?? null])); }
}

/** Translation keys of one namespace with their value in one locale (the draft). */
export class ContentKeysSource extends Source {
  get id() { return 'atc-content'; }
  get label() { return 'Translation keys'; }
  get pageSize() { return 200; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() {
    return {
      namespace: { type: 'string', required: true, pattern: '^[a-z][a-z0-9-]{0,63}$', description: 'Namespace, e.g. web.' },
      locale: { type: 'string', required: true, maxLength: 35, pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$', description: 'Locale whose value is exported, e.g. tr-CY.' },
      missing: { type: 'string', enum: ['true', 'false'], description: 'Only keys without a value in that locale.' },
      q: { type: 'string', maxLength: 120, description: 'Search in key and description.' },
    };
  }
  get columns() { return ['key', 'description', 'value', 'placeholders', 'mismatched', 'updatedAt']; }

  /** @param {string} name @param {string} value */
  normalise(name, value) {
    if (name !== 'locale') return value;
    try { return Intl.getCanonicalLocales(value)[0]; } catch { throw new ExportError('INVALID_FILTER', 'filter "locale" is not a BCP 47 tag'); }
  }

  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/namespaces/${encodeURIComponent(f.namespace)}/keys${Source.query({ q: f.q, missing: f.missing === 'true' ? f.locale : '' })}`; }

  /** @param {Record<string, unknown>} k @param {Record<string, string>} f */
  record(k, f) {
    const values = /** @type {Record<string, string>} */ (k.values ?? {});
    const mismatched = /** @type {string[]} */ (k.mismatched ?? []);
    return { key: k.key, description: k.description ?? '', value: values[f.locale] ?? null, placeholders: k.placeholders ?? [], mismatched: mismatched.includes(f.locale), updatedAt: k.updatedAt ?? null };
  }
}

/** Payments with their provider state. Contains customer e-mail addresses: the file is as sensitive as the payments themselves. */
export class PaymentsSource extends Source {
  get id() { return 'atc-payments'; }
  get label() { return 'Payments'; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() { return { status: { type: 'string', enum: ['pending', 'processing', 'succeeded', 'canceled', 'partially_refunded', 'refunded'], description: 'Payment status.' } }; }
  get columns() { return ['id', 'status', 'amount', 'currency', 'amountRefunded', 'description', 'customerEmail', 'metadata', 'providerId', 'providerStatus', 'createdBy', 'createdAt', 'updatedAt']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/payments${Source.query({ status: f.status })}`; }
  /** @param {Record<string, any>} p */
  record(p) {
    return {
      id: p.id, status: p.status, amount: p.amount, currency: p.currency, amountRefunded: p.amountRefunded ?? 0, description: p.description ?? '', customerEmail: p.customerEmail ?? null,
      metadata: p.metadata ?? {}, providerId: p.provider?.id ?? null, providerStatus: p.provider?.status ?? null, createdBy: p.createdBy, createdAt: p.createdAt, updatedAt: p.updatedAt,
    };
  }
}

/** The payments ledger: one row per charge or refund, newest first. */
export class PaymentsLedgerSource extends Source {
  get id() { return 'atc-payments-ledger'; }
  get label() { return 'Payments ledger'; }
  get pageSize() { return 200; }
  get columns() { return ['seq', 'paymentId', 'kind', 'amount', 'currency', 'ref', 'at']; }
  listPath() { return '/v1/ledger'; }
  /** @param {Record<string, unknown>} e */
  record(e) { return Object.fromEntries(this.columns.map((c) => [c, e[c] ?? null])); }
}

/** Status incidents. */
export class StatusIncidentsSource extends Source {
  get id() { return 'atc-status'; }
  get label() { return 'Status incidents'; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() {
    return {
      monitor: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: 'Monitor id.' },
      state: { type: 'string', enum: ['open', 'closed'], description: 'Incident state.' },
    };
  }
  get columns() { return ['id', 'monitor', 'state', 'openedAt', 'closedAt', 'durationSec', 'cause', 'lastError', 'failures', 'notifyError']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/incidents${Source.query({ monitor: f.monitor, state: f.state })}`; }
  /** @param {Record<string, unknown>} i */
  record(i) { return Object.fromEntries(this.columns.map((c) => [c, i[c] ?? null])); }
}

/** Operational alerts of the status service. */
export class StatusAlertsSource extends Source {
  get id() { return 'atc-status-alerts'; }
  get label() { return 'Operational alerts'; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() { return { state: { type: 'string', enum: ['open', 'acked'], description: 'Alert state.' } }; }
  get columns() { return ['id', 'type', 'key', 'severity', 'title', 'message', 'count', 'firstAt', 'lastAt', 'state', 'ackedAt', 'ackedBy', 'notifyError']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/alerts${Source.query({ state: f.state })}`; }
  /** @param {Record<string, unknown>} a */
  record(a) { return Object.fromEntries(this.columns.map((c) => [c, a[c] ?? null])); }
}

/** Messages of one queue by state (dead letters by default), with their bodies. Bodies are application data: treat the file accordingly. */
export class QueueMessagesSource extends Source {
  get id() { return 'atc-queue'; }
  get label() { return 'Queue messages'; }
  get pageSize() { return 200; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() {
    return {
      queue: { type: 'string', required: true, pattern: '^[a-z][a-z0-9._-]{0,63}$', description: 'Queue name.' },
      state: { type: 'string', enum: ['ready', 'delayed', 'leased', 'dead'], description: 'Message state; dead letters when omitted.' },
    };
  }
  get columns() { return ['id', 'queue', 'state', 'priority', 'attempts', 'dedupeKey', 'availableAt', 'lastError', 'enqueuedBy', 'enqueuedAt', 'deadAt', 'body']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/queues/${encodeURIComponent(f.queue)}/messages?state=${f.state ?? 'dead'}`; }
  /** @param {Record<string, unknown>} m */
  record(m) { return Object.fromEntries(this.columns.map((c) => [c, m[c] ?? null])); }
}

/** Scheduler runs, newest first. */
export class SchedulerRunsSource extends Source {
  get id() { return 'atc-scheduler'; }
  get label() { return 'Scheduler runs'; }
  get cursorParam() { return 'before'; }
  get nextField() { return 'nextBefore'; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() {
    return {
      job: { type: 'string', maxLength: 80, pattern: '^[a-z0-9]+([.\\-_][a-z0-9]+)*$', description: 'Job name.' },
      status: { type: 'string', enum: ['pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped', 'cancelled'], description: 'Run status.' },
    };
  }
  get columns() { return ['id', 'job', 'trigger', 'status', 'scheduledFor', 'attempt', 'maxAttempts', 'startedAt', 'finishedAt', 'durationMs', 'httpStatus', 'error', 'createdAt']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/runs${Source.query({ job: f.job, status: f.status })}`; }
  /** @param {Record<string, unknown>} r */
  record(r) { return Object.fromEntries(this.columns.map((c) => [c, r[c] ?? null])); }
}

/** Webhook deliveries, newest first. */
export class WebhookDeliveriesSource extends Source {
  get id() { return 'atc-webhook-out'; }
  get label() { return 'Webhook deliveries'; }
  get cursorParam() { return 'before'; }
  get nextField() { return 'nextBefore'; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() {
    return {
      status: { type: 'string', enum: ['pending', 'running', 'retrying', 'succeeded', 'failed', 'cancelled'], description: 'Delivery status.' },
      subscription: { type: 'string', pattern: '^sub_[0-9a-f]{16}$', description: 'Subscription id.' },
    };
  }
  get columns() { return ['id', 'eventId', 'subscriptionId', 'status', 'attempt', 'maxAttempts', 'nextAttemptAt', 'startedAt', 'finishedAt', 'durationMs', 'httpStatus', 'error', 'createdAt']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/deliveries${Source.query({ status: f.status, subscription: f.subscription })}`; }
  /** @param {Record<string, unknown>} d */
  record(d) { return Object.fromEntries(this.columns.map((c) => [c, d[c] ?? null])); }
}

/** Notify messages of every sender (needs an admin key on notify). Template data is never exported: notify does not return it. */
export class NotifyMessagesSource extends Source {
  get id() { return 'atc-notify'; }
  get label() { return 'Notify messages'; }
  /** @returns {Record<string, FilterSpec>} */
  get filters() { return { status: { type: 'string', enum: ['queued', 'processing', 'sent', 'failed'], description: 'Delivery status.' } }; }
  get columns() { return ['id', 'keyId', 'channel', 'status', 'template', 'to', 'attempts', 'lastError', 'providerId', 'createdAt', 'sentAt']; }
  /** @param {Record<string, string>} f */
  listPath(f) { return `/v1/messages${Source.query({ status: f.status })}`; }
  /** @param {Record<string, unknown>} m */
  record(m) { return Object.fromEntries(this.columns.map((c) => [c, c === 'to' && Array.isArray(m.to) ? m.to.join(' ') : m[c] ?? null])); }
}

/** Notify's suppression list (admin key). */
export class NotifySuppressionsSource extends Source {
  get id() { return 'atc-notify-suppressions'; }
  get label() { return 'Suppressed addresses'; }
  get pageSize() { return 200; }
  get columns() { return ['email', 'reason', 'source', 'note', 'createdAt']; }
  listPath() { return '/v1/suppressions'; }
  /** @param {Record<string, unknown>} s */
  record(s) { return Object.fromEntries(this.columns.map((c) => [c, s[c] ?? null])); }
}

/** The adapters this build knows, by source id. */
export const ADAPTERS = /** @type {const} */ ({
  'atc-audit': AuditEventsSource,
  'atc-auth': AuthUsersSource,
  'atc-shortlink': ShortlinkLinksSource,
  'atc-flags': FlagsSource,
  'atc-media': MediaFilesSource,
  'atc-content': ContentKeysSource,
  'atc-payments': PaymentsSource,
  'atc-payments-ledger': PaymentsLedgerSource,
  'atc-status': StatusIncidentsSource,
  'atc-status-alerts': StatusAlertsSource,
  'atc-queue': QueueMessagesSource,
  'atc-scheduler': SchedulerRunsSource,
  'atc-webhook-out': WebhookDeliveriesSource,
  'atc-notify': NotifyMessagesSource,
  'atc-notify-suppressions': NotifySuppressionsSource,
});
