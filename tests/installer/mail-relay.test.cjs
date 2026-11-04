'use strict';
// Public Apps Script HTTP handler and operator CLI; no network or actual Google account.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '../../installer/mail-relay/Code.gs');
const issuer = path.resolve(__dirname, '../../installer/mail-relay/owner.cjs');
const key = 'ab'.repeat(32); // Test-only signing material, never a Gmail password.
const start = Date.UTC(2026, 9, 28, 12);
function signed(claims = { id: 'installation-one', exp: Math.floor(start / 1000) + 7 * 86400 }) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', key).update(body).digest('base64url');
}
function harness() {
  const values = new Map([['RELAY_SIGNING_KEY', key]]), outbox = [], logs = [];
  let now = start, available = 100, failDelivery = false, busy = false;
  const props = {
    getProperty: name => values.get(name) ?? null,
    setProperty: (name, value) => { values.set(name, value); return props; },
    setProperties: entries => { for (const [name, value] of Object.entries(entries)) values.set(name, value); return props; },
    getProperties: () => Object.fromEntries(values),
    deleteProperty: name => { values.delete(name); return props; },
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    Date: Clock,
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => !busy, releaseLock() {} }) },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeHmacSha256Signature: (text, secret) => [...crypto.createHmac('sha256', secret).update(text).digest()],
      computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      base64DecodeWebSafe: value => [...Buffer.from(value, 'base64url')],
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    },
    MailApp: {
      getRemainingDailyQuota: () => available,
      sendEmail: message => { if (failDelivery) throw Error('SENSITIVE_PROVIDER_RESPONSE'); outbox.push(message); available--; },
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ setMimeType() { return this; }, text }) },
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  let sequence = 0;
  function request(message = { type: 'verification', to: 'demo@example.com', code: '123456' }, extra = {}) {
    const body = { version: 1, token: signed(), requestId: 'request-' + String(++sequence).padStart(8, '0'), language: 'es', message, ...extra };
    return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  }
  return { request, outbox, values, logs, snapshot: () => JSON.stringify([...values]),
    advance: ms => { now += ms; }, quota: n => { available = n; }, fail: () => { failDelivery = true; }, busy: () => { busy = true; } };
}

test('unauthorized, expired and revoked requests leave storage/counters and mail unchanged', () => {
  for (const token of ['bad', signed().slice(0, -1) + (signed().endsWith('a') ? 'b' : 'a'), signed({ id: 'installation-one', exp: 1 }), signed({ id: 'installation-one', exp: 0 })]) {
    const h = harness(), before = h.snapshot();
    assert.deepEqual(h.request(undefined, { token }), { ok: false, code: 'unauthorized' });
    assert.equal(h.snapshot(), before); assert.equal(h.outbox.length, 0);
  }
  const h = harness(); h.values.set('REVOKED_INSTALLATIONS', '["installation-one"]');
  const before = h.snapshot(); assert.equal(h.request().code, 'unauthorized'); assert.equal(h.snapshot(), before);
});

test('only fixed single-recipient verification/recovery messages are accepted', () => {
  const h = harness();
  for (const message of [
    { type: 'newsletter', to: 'demo@example.com', code: '123456' },
    { type: 'verification', to: 'one@example.com,two@example.com', code: '123456' },
    { type: 'verification', to: 'demo@example.com\r\nBcc: other@example.com', code: '123456' },
    { type: 'verification', to: 'demo@example.com', code: '<script>' },
    { type: 'verification', to: 'demo@example.com', code: '123456', subject: 'arbitrary' },
    { type: 'recovery', to: 'demo@example.com', token: 'has spaces and arbitrary prose' },
  ]) {
    const before = h.snapshot(); assert.equal(h.request(message).code, 'invalid_request'); assert.equal(h.snapshot(), before);
  }
  assert.equal(h.outbox.length, 0);
  assert.deepEqual(h.request(), { ok: true, code: 'accepted' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.outbox[0])), { to: 'demo@example.com', subject: 'AccountExpress — Confirmación de registro', body: 'Tu código de verificación de AccountExpress es: 123456', name: 'AccountExpress' });
  h.advance(61000);
  assert.equal(h.request({ type: 'recovery', to: 'demo@example.com', token: 'a'.repeat(64) }, { language: 'en' }).ok, true);
  assert.equal(h.outbox[1].subject, 'AccountExpress — Account recovery');
  assert.match(h.outbox[1].body, /a{64}/);
  assert.equal(h.logs.length, 0); assert.ok(!JSON.stringify(h.outbox).includes(key));
});

test('idempotent requests never send twice and reject changed content for the same ID', () => {
  const h = harness(), extra = { requestId: 'same-request-00001' };
  assert.equal(h.request(undefined, extra).ok, true);
  const before = h.snapshot(); assert.equal(h.request(undefined, extra).ok, true);
  assert.equal(h.snapshot(), before); assert.equal(h.outbox.length, 1);
  assert.equal(h.request({ type: 'verification', to: 'demo@example.com', code: '654321' }, extra).code, 'request_conflict');
  assert.equal(h.snapshot(), before); assert.equal(h.outbox.length, 1);
});

test('cooldown and per-installation daily cap reject without changing stored state', () => {
  const h = harness(); assert.equal(h.request().ok, true);
  let before = h.snapshot(); assert.equal(h.request().code, 'rate_limited'); assert.equal(h.snapshot(), before);
  h.advance(61000); assert.equal(h.request().ok, true);
  h.advance(61000); assert.equal(h.request().ok, true);
  h.advance(61000); before = h.snapshot(); assert.equal(h.request().code, 'rate_limited'); assert.equal(h.snapshot(), before);
  assert.equal(h.outbox.length, 3);
  h.advance(86400000); assert.equal(h.request().ok, true);
});

test('recipient quota applies across installations and owner quota fails closed', () => {
  const h = harness();
  for (let n = 0; n < 3; n++) {
    assert.equal(h.request(undefined, { token: signed({ id: 'installation-' + n, exp: Math.floor(start / 1000) + 86400 }) }).ok, true);
    h.advance(61000);
  }
  let before = h.snapshot();
  assert.equal(h.request(undefined, { token: signed({ id: 'installation-four', exp: Math.floor(start / 1000) + 86400 }) }).code, 'rate_limited');
  assert.equal(h.snapshot(), before);
  const q = harness(); q.quota(0); before = q.snapshot();
  assert.equal(q.request().code, 'quota_exhausted'); assert.equal(q.snapshot(), before); assert.equal(q.outbox.length, 0);
  const g = harness(); g.values.set('GLOBAL_DAILY_LIMIT', '1'); assert.equal(g.request().ok, true); g.advance(61000); before = g.snapshot();
  assert.equal(g.request({ type: 'verification', to: 'other@example.com', code: '123456' }).code, 'quota_exhausted');
  assert.equal(g.snapshot(), before); assert.equal(g.outbox.length, 1);
});

test('delivery exceptions return sanitized failure, never a successful send', () => {
  const h = harness(); h.fail();
  assert.deepEqual(h.request(undefined, { requestId: 'failed-request-001' }), { ok: false, code: 'delivery_failed' });
  const before = h.snapshot();
  assert.equal(h.request(undefined, { requestId: 'failed-request-001' }).code, 'delivery_failed');
  assert.equal(h.snapshot(), before); assert.equal(h.outbox.length, 0); assert.equal(h.logs.length, 0);
  assert.ok(!h.snapshot().includes('123456')); assert.ok(!h.snapshot().includes('SENSITIVE_PROVIDER_RESPONSE'));
});

test('lock contention and invalid configuration fail closed without state mutation', () => {
  const h = harness(); h.busy(); const before = h.snapshot();
  assert.equal(h.request().code, 'busy'); assert.equal(h.snapshot(), before); assert.equal(h.outbox.length, 0);
  for (const [name, value] of [['RELAY_SIGNING_KEY', ''], ['GLOBAL_DAILY_LIMIT', '9999'], ['REVOKED_INSTALLATIONS', '{broken']]) {
    const c = harness(); c.values.set(name, value); const saved = c.snapshot();
    assert.equal(c.request().ok, false); assert.equal(c.snapshot(), saved); assert.equal(c.outbox.length, 0);
  }
});

test('operator CLI issues a limited credential without copying the signing key or overwriting files', () => {
  const temporary = fs.mkdtempSync(path.join(__dirname, '.relay-test-'));
  const invoke = args => spawnSync(process.execPath, [issuer, ...args], { encoding: 'utf8', timeout: 5000 });
  try {
    const keyFile = path.join(temporary, 'signing-key.txt'), output = path.join(temporary, 'installation.json');
    fs.writeFileSync(keyFile, key);
    const args = ['issue', '--key-file', keyFile, '--installation-id', 'installation-one', '--expires', '2030-01-01', '--relay-url', 'https://script.google.com/macros/s/TEST_DEPLOYMENT_123456789/exec', '--output', output];
    const result = invoke(args); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    const credential = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(credential.installationId, 'installation-one'); assert.ok(credential.token); assert.ok(!JSON.stringify(credential).includes(key));
    assert.ok(!result.stdout.includes(credential.token)); assert.ok(!result.stdout.includes(key));
    const h = harness(); assert.equal(h.request(undefined, { token: credential.token }).ok, true);
    const previous = fs.readFileSync(output, 'utf8'); const rejected = invoke(args);
    assert.equal(rejected.status, 1); assert.equal(fs.readFileSync(output, 'utf8'), previous);
    const bad = invoke(args.map(a => a === credential.relayUrl ? 'http://localhost/exec' : a));
    assert.equal(bad.status, 1); assert.equal(fs.readFileSync(output, 'utf8'), previous);
    assert.ok(!rejected.stderr.includes(key));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
