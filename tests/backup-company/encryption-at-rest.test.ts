import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryRows, queryNullMetadata } from './helpers';

const state = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const parent = path.join(process.cwd(), 'tests/backup-company/.scratch');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'at-rest-'));
  return { root, rows: {} as Record<string, any[]>, sqlNulls: {} as Record<string, boolean>, inTransaction: false, transaction: vi.fn() };
});
vi.mock('@/lib/config/paths', () => ({
  BACKUP_DIR: path.join(state.root, 'backups'),
  RUNTIME_FILES: { companyConfig: path.join(state.root, 'company-config.json') },
}));
const database = vi.hoisted(() => new Proxy({}, {
  get: (_, model: string) => model === '$transaction' ? state.transaction : model === '$queryRaw' ? async (query: any) => {
    if (!state.inTransaction) throw new Error('Metadata read outside snapshot');
    return queryNullMetadata(state.rows, query, state.sqlNulls);
  } : {
    findMany: vi.fn(async (query: any) => {
      if (!state.inTransaction) throw new Error('Database read outside snapshot');
      return queryRows(state.rows, model, query);
    }),
    findUnique: vi.fn(async (query: any) => {
      if (!state.inTransaction) throw new Error('Database read outside snapshot');
      return queryRows(state.rows, model, query)[0] ?? null;
    }),
  },
}));
vi.mock('@/lib/db', () => ({ db: database, withCompanyBackupTransaction: (callback: any, options: any) => state.transaction(callback, options) }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(() => { throw new Error('auth must not run'); }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { createBackup, getBackupFile, listBackups, deleteBackup } from '@/lib/backup';
import { decrypt } from '@/lib/crypto';
import { parseSnapshot, SEAL_KEY_DERIVATION } from '@/lib/backup-format';

const dir = path.join(state.root, 'backups');
const config = path.join(state.root, 'company-config.json');
const secret = 'company-backup-at-rest-test-secret';
const previousSecret = process.env.SESSION_SECRET;

function files() { return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; }
function body(result: Awaited<ReturnType<typeof createBackup>>) {
  return JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'));
}
/** The sealed ciphertext as written inside the at-rest envelope. */
function sealedCiphertext(filename: string): string {
  const onDisk = fs.readFileSync(path.join(dir, filename), 'utf8');
  const sealed = onDisk.match(/"ciphertext"\s*:\s*"([^"]+)"/);
  if (!sealed) throw new Error('no ciphertext in at-rest envelope');
  return sealed[1];
}

beforeAll(() => {
  // The company-backup runner starts without ambient .env values on purpose.
  process.env.SESSION_SECRET = secret;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
  fs.rmSync(state.root, { recursive: true, force: true });
});
beforeEach(() => {
  vi.restoreAllMocks();
  process.env.SESSION_SECRET = secret;
  for (const name of fs.readdirSync(state.root)) fs.rmSync(path.join(state.root, name), { recursive: true, force: true });
  state.sqlNulls = {};
  state.rows = {
    company: [{ id: 'tenant', legalName: 'Ñandú 日本 🦜', taxId: null }],
    entityContext: [{ id: 'ctx', companyId: 'tenant', pattern: 'Árbol' }],
    detectionConfig: [{ companyId: 'tenant', threshold: 0.75 }],
    companyModuleEntitlement: [{ id: 'entitlement', companyId: 'tenant', moduleKey: 'accounting', enabled: true }],
    csvLayoutProfile: [{ id: 'csv', companyId: 'tenant', fingerprint: 'utf8' }],
    ruleApplyRecord: [{ id: 'apply', companyId: 'tenant', userId: 'actor' }],
    auditLog: [{ id: 'audit', companyId: 'tenant', userId: 'actor' }],
    pendingApproval: [{ id: 'pending', companyId: 'tenant', payload: { label: 'é' } }],
    user: [{ id: 'actor', email: 'actor@example.invalid', platformRole: 'user', passwordHash: 'fixture-only-do-not-export' }],
    systemConfig: [{ id: 'global', key: 'global-setting', value: 'must-not-export' }],
    bankStatement: [{ id: 'statement', companyId: 'tenant' }],
    bankTransaction: [{ id: 'transaction', statementId: 'statement', journalEntryId: 'entry', journalLineId: 'line', ruleApplyRecordId: 'apply' }],
    journalEntry: [{ id: 'entry', companyId: 'tenant', ruleApplyRecordId: 'apply' }],
    journalLine: [{ id: 'line', entryId: 'entry', glAccountId: 'gl', debit: '10.01' }],
    glAccount: [{ id: 'gl', companyId: 'tenant', balance: '10.01' }],
  };
  state.inTransaction = false;
  state.transaction.mockReset().mockImplementation(async (callback: any) => {
    state.inTransaction = true;
    try { return await callback(database); }
    finally { state.inTransaction = false; }
  });
  fs.writeFileSync(config, JSON.stringify({ companies: { tenant: { currency: 'ARS', periodType: 'monthly' } } }));
});

describe('company backup encryption at rest', () => {
  it('publishes new backups sealed with a self-describing envelope and keeps the manifest index as plain metadata', async () => {
    const saved = await createBackup('tenant');
    const onDisk = fs.readFileSync(path.join(dir, saved.filename)).toString('utf8');

    // No plaintext JSON, no PII, no ledger rows on disk.
    expect(onDisk.startsWith('{')).toBe(false);
    expect(onDisk).not.toContain('legalName');
    expect(onDisk).not.toContain('actor@example.invalid');
    expect(onDisk).not.toContain('journalLines');
    expect(onDisk).not.toContain('Ñandú 日本 🦜');
    // Self-describing: the reader can tell sealed from legacy without guessing.
    expect(onDisk).toMatch(/AES-?256-GCM/);
    expect(onDisk).toMatch(/ENCRYPTED/i);

    // The manifest index is metadata only and stays readable JSON.
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(index.backups.map((row: any) => row.filename)).toContain(saved.filename);
    expect(listBackups('tenant')[0].filename).toBe(saved.filename);
  });

  it('roundtrips the exact written JSON through the sealed envelope using the shared AES-GCM scheme', async () => {
    const saved = await createBackup('tenant');
    const original = Buffer.from(saved.data, 'base64').toString('utf8');

    expect(getBackupFile(saved.filename)).toEqual({ data: original, size: Buffer.byteLength(original) });
    expect(getBackupFile(saved.filename)?.data).toBe(original);
    // Same key derivation and payload shape as src/lib/crypto.ts: the sealed
    // ciphertext is decryptable by the shared primitives.
    expect(await decrypt(sealedCiphertext(saved.filename))).toBe(original);
    // Two snapshots of identical content must not reuse an IV.
    const second = await createBackup('tenant');
    expect(sealedCiphertext(second.filename)).not.toBe(sealedCiphertext(saved.filename));
  });

  it('keeps legacy plaintext files readable with no migration', async () => {
    const legacy = body(await createBackup('tenant'));
    legacy.manifest.version = '1.1.0';
    delete legacy.manifest.integrity;
    const legacyText = JSON.stringify(legacy, null, 2);
    fs.writeFileSync(path.join(dir, 'legacy-plain.json'), legacyText);

    expect(getBackupFile('legacy-plain.json')).toEqual({ data: legacyText, size: Buffer.byteLength(legacyText) });
    expect(listBackups('tenant').map(row => row.filename)).toContain('legacy-plain.json');
    expect(deleteBackup('legacy-plain.json', 'tenant')).toEqual({ status: 'deleted' });
    expect(files()).not.toContain('legacy-plain.json');
  });

  it('detects tampering with the sealed ciphertext instead of returning corrupted data', async () => {
    const saved = await createBackup('tenant');
    const file = path.join(dir, saved.filename);
    const onDisk = fs.readFileSync(file, 'utf8');
    const [ivHex, encoded] = sealedCiphertext(saved.filename).split(':');
    const bytes = Buffer.from(encoded, 'base64');
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    fs.writeFileSync(file, onDisk.replace(`"ciphertext":"${ivHex}:${encoded}"`, `"ciphertext":"${ivHex}:${bytes.toString('base64')}"`));

    expect(() => getBackupFile(saved.filename)).toThrow(/decrypt/i);
    expect(() => listBackups('tenant')).toThrow(/decrypt/i);
  });

  it('refuses to publish plaintext when no SESSION_SECRET is available', async () => {
    delete process.env.SESSION_SECRET;
    const before = files();
    await expect(createBackup('tenant')).rejects.toThrow('SESSION_SECRET environment variable is required');
    expect(files()).toEqual(before);
    for (const name of files()) expect(fs.readFileSync(path.join(dir, name), 'utf8')).not.toContain('legalName');
  });
});

/**
 * S6 (Wave 5) — the snapshot integrity seal: READ-legacy / WRITE-new.
 *
 * The seal used to be a plain SHA-256 digest, which detects corruption but not
 * forgery: anyone able to write a backup file can recompute it. New seals are
 * HMAC-SHA256 under a key derived from SESSION_SECRET with the same
 * domain-separated derivation as the crypto v2 envelope
 * (PBKDF2-SHA256 + HKDF-SHA256, info `accountexpress:crypto:v2:hmac`).
 * Legacy seals keep validating; nothing is re-sealed.
 */
describe('company backup integrity seal (S6)', () => {
  /** Canonical seal payload of a written snapshot text. */
  function sealPayload(text: string): string {
    const snapshot = JSON.parse(text);
    const { integrity: _integrity, ...manifest } = snapshot.manifest;
    return JSON.stringify({ manifest, data: snapshot.data });
  }

  /** Independent re-derivation: same two steps as src/lib/crypto.ts, sync. */
  function derivedSealKey(secret: string): Buffer {
    const base = crypto.pbkdf2Sync(secret, 'crypto-key-salt', 100_000, 32, 'sha256');
    return Buffer.from(crypto.hkdfSync('sha256', base, 'crypto-key-salt', 'accountexpress:crypto:v2:hmac', 32));
  }

  it('writes a keyed HMAC seal that is not the forgeable plain digest', async () => {
    const saved = await createBackup('tenant');
    const text = getBackupFile(saved.filename)!.data;
    const integrity = JSON.parse(text).manifest.integrity;

    expect(integrity.algorithm).toBe('hmac-sha256');
    expect(integrity.authenticated).toBe(true);
    expect(integrity.keyDerivation).toBe(SEAL_KEY_DERIVATION);
    expect(integrity.encoding).toBe('utf8');
    expect(integrity.scope).toBe('JSON.stringify({manifest-without-integrity,data})');
    // New seals validate through the real read path.
    expect(parseSnapshot(text).manifest.integrity!.digest).toBe(integrity.digest);

    const payload = sealPayload(text);
    const plain = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    const rawSecretMac = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    expect(integrity.digest).not.toBe(plain);
    // The key is DERIVED: it is neither the plain hash nor an HMAC of the raw
    // SESSION_SECRET.
    expect(integrity.digest).not.toBe(rawSecretMac);
    // And it is exactly the domain-separated derivation, independently redone.
    expect(integrity.digest).toBe(
      crypto.createHmac('sha256', derivedSealKey(secret)).update(payload, 'utf8').digest('hex'),
    );
  });

  it('keeps validating legacy plain-SHA-256 seals without re-sealing the file', async () => {
    const saved = await createBackup('tenant');
    const parsed = JSON.parse(getBackupFile(saved.filename)!.data);
    delete parsed.manifest.integrity;
    parsed.manifest.integrity = {
      algorithm: 'sha256',
      encoding: 'utf8',
      scope: 'JSON.stringify({manifest-without-integrity,data})',
      authenticated: false,
      digest: crypto.createHash('sha256').update(sealPayload(JSON.stringify(parsed)), 'utf8').digest('hex'),
    };
    const legacyText = JSON.stringify(parsed, null, 2);

    // Read-legacy: a file an older build produced still validates as-is.
    const reopened = parseSnapshot(legacyText);
    expect(reopened.manifest.integrity).toEqual(parsed.manifest.integrity);
    expect(reopened.manifest.integrity!.algorithm).toBe('sha256');
    expect(reopened.manifest.integrity!.authenticated).toBe(false);
  });

  it('rejects a tampered payload under BOTH seal shapes', async () => {
    const saved = await createBackup('tenant');
    const text = getBackupFile(saved.filename)!.data;

    // (a) HMAC seal: altering the data without the key leaves a bad MAC.
    const forged = JSON.parse(text);
    forged.data.glAccounts[0].balance = '999.99';
    expect(() => parseSnapshot(JSON.stringify(forged))).toThrow(/checksum/i);

    // (b) legacy seal: the plain digest no longer matches either.
    const legacy = JSON.parse(text);
    legacy.manifest.integrity = {
      algorithm: 'sha256',
      encoding: 'utf8',
      scope: 'JSON.stringify({manifest-without-integrity,data})',
      authenticated: false,
      digest: crypto.createHash('sha256').update(sealPayload(text), 'utf8').digest('hex'),
    };
    legacy.data.glAccounts[0].balance = '999.99';
    expect(() => parseSnapshot(JSON.stringify(legacy))).toThrow(/checksum/i);

    // (c) a seal cannot lie about its own shape: a keyed digest declared as an
    // unauthenticated plain digest is refused, and vice versa.
    const mismatched = JSON.parse(text);
    mismatched.manifest.integrity = { ...mismatched.manifest.integrity, algorithm: 'sha256', authenticated: false };
    expect(() => parseSnapshot(JSON.stringify(mismatched))).toThrow(/checksum/i);
    const unauthenticated = JSON.parse(text);
    unauthenticated.manifest.integrity = { ...unauthenticated.manifest.integrity, authenticated: false };
    expect(() => parseSnapshot(JSON.stringify(unauthenticated))).toThrow(/checksum/i);
  });
});
