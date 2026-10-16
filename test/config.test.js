import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

const URL_ = 'http://127.0.0.1:9';

test('Config: defaults, roles, configured sources only', () => {
  const c = Config.fromEnv(testEnv(URL_, { PORT: '' }));
  assert.equal(c.port, 3014);
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role]), [['console', 'readwrite'], ['dashboard', 'read'], ['ops', 'write']]);
  assert.deepEqual(Object.keys(c.sources), ['atc-audit', 'atc-auth', 'atc-content']);
  assert.deepEqual(c.limits, { maxRows: 1000000, maxBytes: 268435456, retentionDays: 7, downloadTtlSec: 300 });
  assert.equal(c.worker.concurrency, 2);
  assert.equal(c.appName, 'atc-web');
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.worker) && Object.isFrozen(c.sources));
  assert.equal(Config.fromEnv(testEnv(URL_, { NOTIFY_URL: '', NOTIFY_API_KEY: '' })).notify, null);
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(URL_, o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ EXPORT_API_KEYS: '' }, /EXPORT_API_KEYS is required/);
  bad({ EXPORT_API_KEYS: `a:${'a'.repeat(40)}:owner` }, /read, write, readwrite or admin/);
  bad({ MEDIA_URL: '', MEDIA_API_KEY: '' }, /MEDIA_URL and MEDIA_API_KEY are required/);
  bad({ SOURCE_FLAGS_URL: URL_ }, /SOURCE_FLAGS_URL and SOURCE_FLAGS_API_KEY must be set together/);
  bad({ SOURCE_FLAGS_URL: 'ftp://x', SOURCE_FLAGS_API_KEY: 'k'.repeat(40) }, /absolute http/);
  bad({ NOTIFY_API_KEY: 'short' }, /at least 32/);
  bad({ HEARTBEAT_MS: '4000', LEASE_MS: '6000' }, /at most half/);
  bad({ TLS_KEY_PATH: '/k.pem' }, /must be set together/);
});
