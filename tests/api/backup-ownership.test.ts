import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { POST as backupPOST } from '../../src/app/api/backup/route';
import { POST as restorePOST } from '../../src/app/api/backup/restore/route';
import { POST as bootstrapRestorePOST } from '../../src/app/api/bootstrap/restore/route';
import { db } from '@/lib/db';
import { BACKUP_DIR } from '@/lib/config/paths';
import { createSession } from '@/lib/sessions';
import { hashPassword } from '@/lib/auth';
import { sealSnapshot } from '@/lib/backup-format';
import { getBackupFile } from '@/lib/backup';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  createTestJournalEntry,
  clearDatabase,
} from '../helpers/factories';

/**
 * S1/S2/S7 — backup ownership credential.
 *
 * A backup file is a complete company. Creating one now requires the
 * administrator to re-enter their password (sudo style) and stores ONLY a
 * scrypt verifier inside the sealed manifest. Every restore path (bootstrap
 * from zero and in-system) must prove that credential before touching
 * anything, so a stolen file is useless. Backups created before the protection
 * (no verifier) are refused with a Spanish message that says so.
 */
const OWNER_PASSWORD = 'Clave.SuperAdmin.2026';
const WRONG_PASSWORD = 'esto-no-es-la-clave';

/** Backups on disk (the catalog index is not a backup). */
function backupFiles(): string[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
}

/** Stable projection for "the rows did not change" assertions (Decimal/Date). */
function rows(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function decode(base64: string): Record<string, any> {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function postBackup(token: string, companyId: string, body: unknown) {
  return backupPOST(
    new NextRequest(`http://localhost/api/backup?companyId=${companyId}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

async function postRestore(token: string, companyId: string, body: unknown) {
  return restorePOST(
    new NextRequest(`http://localhost/api/backup/restore?companyId=${companyId}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

/** Exactly the shape a legacy (pre-ownership) file has: sealed, no verifier. */
function withoutVerifier(payload: Record<string, any>): string {
  delete payload.manifest.ownership;
  sealSnapshot(payload as never);
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

async function createFixture(companyId: string) {
  const gl = await createTestGlAccount({
    companyId,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bankAccount = await createTestBankAccount(companyId, gl.id, 'Test Bank');
  const statement = await createTestBankStatement(companyId, bankAccount.id);
  await createTestBankTransaction(companyId, statement.id, {
    date: '2025-03-15',
    amount: 500.0,
    description: 'Test deposit',
    reference: 'REF-001',
  });
  const entry = await createTestJournalEntry(companyId, {
    date: '2025-03-15',
    description: 'Test entry',
    lines: [
      { glAccountId: gl.id, debit: 500, credit: 0 },
      { glAccountId: gl.id, debit: 0, credit: 500 },
    ],
  });
  await db.$transaction((tx) => appendEntryToJournalChain(tx, { companyId, entryId: entry.id }));
  return { gl, bankAccount, statement, entry };
}

/**
 * The first-install gate is `company.count() === 0` (bootstrap restore answers
 * 409 DB_NOT_EMPTY otherwise). `clearDatabase()` only removes companies that
 * still have a test member, so a company another file left behind without
 * members — or whose delete was blocked by a child row — survives it and makes
 * this suite look like an installed system. The fixture database is disposable:
 * start from an empty installation by removing every company, user, membership,
 * session and dormant identity row before the first test.
 */
async function wipeInstallation() {
  if (!(process.env.DATABASE_URL ?? '').includes('test')) {
    throw new Error('wipeInstallation() REFUSED: DATABASE_URL does not point to a test database');
  }
  // RESTRICT edges first: these children block the cascade from Company/User.
  await db.bankTransaction.deleteMany();
  await db.bankStatement.deleteMany();
  await db.bankAccount.deleteMany();
  await db.journalLine.deleteMany();
  await db.journalEntry.deleteMany();
  await db.reconciliationPeriod.deleteMany();
  await db.ruleApplyRecord.deleteMany();
  // CompanyKnowledge is not cascaded from Company and its children point at it.
  await db.knowledgeAudit.deleteMany();
  await db.pendingApproval.deleteMany();
  await db.companyKnowledge.updateMany({ data: { mergedIntoId: null } });
  await db.companyKnowledge.deleteMany();
  // Everything else that hangs off a company cascades with it.
  await db.company.deleteMany();
  await db.companyMember.deleteMany();
  await db.session.deleteMany();
  await db.user.deleteMany();
  await db.identityPendingRegistration.deleteMany();
  await db.identityChallenge.deleteMany();
  await db.identityRateLimit.deleteMany();
  await db.identitySecurityEvent.deleteMany();
}

beforeAll(async () => {
  await wipeInstallation();
});

describe('backup ownership credential (S1/S2/S7)', () => {
  let user: { id: string };
  let company: { id: string };
  let token: string;

  beforeEach(async () => {
    await clearDatabase();
    // Installation-wide audit residue from other suites cannot be certified by
    // the coordinated restore; only hashed rows are removed (see
    // tests/api/backup-restore.test.ts).
    await db.auditLog.deleteMany({ where: { hash: { not: null } } });
    user = await createTestUser('owner-sro@example.com');
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(OWNER_PASSWORD) } });
    company = await createTestCompany('Secure Restore Corp');
    await createTestCompanyMember(user.id, company.id);
    token = await createSession(user.id);
    await createFixture(company.id);
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('refuses to create a backup without the administrator password and publishes nothing', async () => {
    const files = backupFiles();

    const res = await postBackup(token, company.id, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('BACKUP_PASSWORD_REQUIRED');
    expect(body.error).toContain('contraseña');

    // Fail closed: no file, no catalog entry, no audit row.
    expect(backupFiles()).toEqual(files);
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'BACKUP_CREATED' } })).toBe(0);
  });

  it('refuses a wrong administrator password with INVALID_BACKUP_PASSWORD and publishes nothing', async () => {
    const files = backupFiles();

    const res = await postBackup(token, company.id, { password: WRONG_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_BACKUP_PASSWORD');
    expect(body.error).toContain('contraseña');

    expect(backupFiles()).toEqual(files);
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'BACKUP_CREATED' } })).toBe(0);
  });

  it('embeds the verifier only inside the sealed manifest — never the password, never a plain section', async () => {
    const res = await postBackup(token, company.id, { password: OWNER_PASSWORD });
    expect(res.status).toBe(200);
    const body = await res.json();
    const payload = decode(body.data);

    const ownership = payload.manifest.ownership;
    expect(ownership.kdf).toBe('scrypt');
    expect(ownership.params).toEqual({ N: 2 ** 15, r: 8, p: 1, keyLength: 32 });
    const salt = Buffer.from(ownership.salt, 'base64');
    const hash = Buffer.from(ownership.hash, 'base64');
    expect(salt).toHaveLength(16);
    expect(hash).toHaveLength(32);

    // The verifier really is derived from the administrator's password...
    const derived = crypto.scryptSync(OWNER_PASSWORD, salt, 32, {
      N: ownership.params.N,
      r: ownership.params.r,
      p: ownership.params.p,
      maxmem: 64 * 1024 * 1024,
    });
    expect(derived.equals(hash)).toBe(true);
    // ...and a different password does not reproduce it.
    expect(crypto.scryptSync(WRONG_PASSWORD, salt, 32, {
      N: ownership.params.N,
      r: ownership.params.r,
      p: ownership.params.p,
      maxmem: 64 * 1024 * 1024,
    }).equals(hash)).toBe(false);

    // The password and the verifier live ONLY in the manifest: no data section
    // carries either of them.
    const dataSections = JSON.stringify(payload.data);
    expect(dataSections).not.toContain(OWNER_PASSWORD);
    expect(dataSections).not.toContain(ownership.salt);
    expect(dataSections).not.toContain(ownership.hash);
    expect(dataSections).not.toContain('scrypt');

    // The at-rest file is sealed: the verifier is inside the encrypted envelope.
    const stored = fs.readFileSync(path.join(BACKUP_DIR, body.filename), 'utf8');
    expect(stored.startsWith('{')).toBe(false);
    expect(stored).toContain('AES-256-GCM');
    expect(stored).not.toContain(ownership.salt);
    expect(stored).not.toContain(ownership.hash);
    expect(stored).not.toContain('scrypt');
    expect(stored).not.toContain(OWNER_PASSWORD);
  });

  it('refuses an in-system restore without the ownership credential, before any mutation', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const glBefore = rows(await db.glAccount.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }));
    const files = backupFiles();

    const res = await postRestore(token, company.id, { data: created.data });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_OWNERSHIP');
    expect(body.error).toContain('contraseña');

    expect(rows(await db.glAccount.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }))).toEqual(glBefore);
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'COMPANY_RESTORE_COMMITTED' } })).toBe(0);
    // No safety snapshot was published either: the refusal precedes publication.
    expect(backupFiles()).toEqual(files);
  });

  it('refuses an in-system restore with a wrong credential, before any mutation', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const glBefore = rows(await db.glAccount.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }));
    const files = backupFiles();

    const res = await postRestore(token, company.id, { data: created.data, ownerPassword: WRONG_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_OWNERSHIP');
    expect(body.error).toContain('contraseña');

    expect(rows(await db.glAccount.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }))).toEqual(glBefore);
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'COMPANY_RESTORE_COMMITTED' } })).toBe(0);
    expect(backupFiles()).toEqual(files);
  });

  it('restores end-to-end with the correct credential and keeps the safety image provable', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const glBefore = await db.glAccount.findMany({ where: { companyId: company.id } });

    await db.journalLine.deleteMany({ where: { entry: { companyId: company.id } } });
    await db.journalEntry.deleteMany({ where: { companyId: company.id } });
    await db.journalChainHead.deleteMany({ where: { companyId: company.id } });
    await db.bankTransaction.deleteMany({ where: { statement: { companyId: company.id } } });
    await db.bankStatement.deleteMany({ where: { companyId: company.id } });
    await db.bankAccount.deleteMany({ where: { companyId: company.id } });
    await db.glAccount.deleteMany({ where: { companyId: company.id } });
    expect(await db.glAccount.count({ where: { companyId: company.id } })).toBe(0);

    const res = await postRestore(token, company.id, {
      data: created.data,
      ownerPassword: OWNER_PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('committed');

    expect(await db.glAccount.findMany({ where: { companyId: company.id } })).toHaveLength(glBefore.length);
    expect(await db.auditLog.count({ where: { companyId: company.id, action: 'COMPANY_RESTORE_COMMITTED' } })).toBe(1);

    // The rollback image of the restore carries its own verifier for the same
    // credential, so it stays restorable without weakening the protection.
    const safety = JSON.parse(getBackupFile(body.safetyFilename)!.data);
    expect(safety.manifest.ownership.kdf).toBe('scrypt');
    const safetyParams = safety.manifest.ownership.params;
    const safetyDerived = crypto.scryptSync(
      OWNER_PASSWORD,
      Buffer.from(safety.manifest.ownership.salt, 'base64'),
      safetyParams.keyLength,
      { N: safetyParams.N, r: safetyParams.r, p: safetyParams.p, maxmem: 64 * 1024 * 1024 },
    );
    expect(safetyDerived.equals(Buffer.from(safety.manifest.ownership.hash, 'base64'))).toBe(true);
  });

  it('refuses a legacy backup without a verifier, saying it predates ownership protection', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const payload = decode(created.data);
    const legacyData = withoutVerifier(payload);
    const glBefore = rows(await db.glAccount.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }));
    const files = backupFiles();

    // The same password cannot help: there is nothing to verify against.
    const res = await postRestore(token, company.id, { data: legacyData, ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_OWNERSHIP');
    expect(body.error).toContain('antes de');
    expect(body.error).toContain('credencial de propiedad');

    expect(rows(await db.glAccount.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }))).toEqual(glBefore);
    expect(backupFiles()).toEqual(files);
  });

  it('refuses a bootstrap restore without the ownership credential and leaves the system empty', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    await clearDatabase();

    const formData = new FormData();
    formData.append('file', new File([Buffer.from(created.data, 'base64')], 'backup.json', { type: 'application/json' }));
    formData.append('recoveryPassword', 'NuevaClave2026');
    const res = await bootstrapRestorePOST(
      new NextRequest('http://localhost/api/bootstrap/restore', { method: 'POST', body: formData }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_OWNERSHIP');
    expect(body.error).toContain('contraseña');

    // Fail closed BEFORE the bootstrap shell: nothing was created, so the empty
    // system gate still admits a later attempt.
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    expect(await db.companyMember.count()).toBe(0);
  });

  it('restores a backup from zero once the ownership credential is supplied', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const companyId = company.id;
    await clearDatabase();

    const formData = new FormData();
    formData.append('file', new File([Buffer.from(created.data, 'base64')], 'backup.json', { type: 'application/json' }));
    formData.append('recoveryPassword', 'NuevaClave2026');
    formData.append('ownerPassword', OWNER_PASSWORD);
    const res = await bootstrapRestorePOST(
      new NextRequest('http://localhost/api/bootstrap/restore', { method: 'POST', body: formData }),
      { params: Promise.resolve({}) },
    );

    const body = await res.json();
    expect(body.error ?? '').toBe('');
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    const restored = await db.company.findUnique({ where: { id: companyId } });
    expect(restored?.legalName).toBe('Secure Restore Corp');
    expect(await db.glAccount.count({ where: { companyId } })).toBeGreaterThanOrEqual(1);
  });
});
