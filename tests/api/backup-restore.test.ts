import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as backupPOST, GET as backupGET, DELETE as backupDELETE } from '../../src/app/api/backup/route';
import { POST as restorePOST } from '../../src/app/api/backup/restore/route';
import { validateBackup, getBackupFile } from '../../src/lib/backup';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction, createTestJournalEntry, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { hashPassword } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createMaintenanceGate } from '@/lib/backup-maintenance.mjs';
import { RUNTIME_DIR } from '@/lib/config/paths';
import fs from 'fs';
import path from 'path';

const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups');

function cleanTestBackups(filenames: string[]) {
  for (const name of filenames) {
    const filePath = path.join(BACKUP_DIR, name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  const manifestPath = path.join(BACKUP_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.backups = manifest.backups.filter(
        (b: { filename: string }) => !filenames.includes(b.filename),
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // ignore parse errors on cleanup
    }
  }
}

/**
 * Release a maintenance marker left behind by an unsuccessful transition, using
 * the same gate API an operator would. Returns the previous state for evidence.
 */
async function releaseMaintenanceIfMarked() {
  const root = path.join(RUNTIME_DIR, 'backup-maintenance');
  const markerPath = path.join(root, 'maintenance.json');
  if (!fs.existsSync(markerPath)) return false;
  const gate = createMaintenanceGate(root);
  const record = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { id: string };
  const owner = gate.resumeMaintenance(record.id);
  await owner.drain({ timeoutMs: 0 });
  owner.release();
  return true;
}

async function createTestFixture(companyId: string) {
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
  // JH2: a posted entry without its v2 seal (hash/previousHash + chain head) is
  // not restorable — the coordinated restore certifies the source chain and
  // never re-signs (RESTORE_CHAIN MEMBER_HASH_NULL). Seal it through the SAME
  // production primitive the journal POST route uses, so the backup under test
  // is the contract-compliant output of createBackup, not a hand-built payload.
  await db.$transaction((tx) => appendEntryToJournalChain(tx, { companyId, entryId: entry.id }));
  return { gl, bankAccount, statement, entry };
}

/**
 * S7: creating a backup requires the administrator to re-enter their password,
 * and the SERVER resolves the owner from its own records: only an ACTIVE,
 * VERIFIED `super_admin` of this company can be certified (anything else answers
 * 409 RECOVERY_OWNER_MISSING). These suites keep their original assertions; only
 * the credential and the owner identity the new contract demands are supplied
 * here.
 */
const OWNER_PASSWORD = 'Clave.Backup.2026';

async function createAdministrator(email: string) {
  const user = await createTestUser(email);
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(OWNER_PASSWORD), platformRole: 'super_admin' },
  });
  return user;
}

/**
 * The POST answer carries the encrypted PORTABLE file (the owner-verified
 * artifact a first installation restores); the in-app restore consumes the
 * internal snapshot the installation keeps. This reads that stored snapshot
 * through the production accessor so the fixture never hand-builds a payload.
 */
function storedSnapshotBase64(filename: string): string {
  const stored = getBackupFile(filename);
  if (!stored) throw new Error(`Backup ${filename} is not stored`);
  return Buffer.from(stored.data, 'utf-8').toString('base64');
}

describe('POST /api/backup + POST /api/backup/restore', () => {
  const createdBackups: string[] = [];

  beforeEach(async () => {
    await clearDatabase();
    createdBackups.length = 0;
    // The coordinated restore certifies the INSTALLATION-WIDE audit chain before
    // it replaces any row (src/lib/backup-validation.ts RESTORE_CHAIN): a
    // predecessor another tenant still
    // needs must never be deleted or re-signed. Other suites leave hashed
    // AuditLog rows behind (their tenant is gone, or the hash was sealed with a
    // stubbed HMAC secret) and such a row can never be certified, so the shared
    // test DB removes ONLY that hashed residue. Unhashed operational rows — the
    // BACKUP_CREATED / COMPANY_RESTORE_COMMITTED rows asserted below — are
    // untouched, and the restore assertions stay exactly as they were.
    await db.auditLog.deleteMany({ where: { hash: { not: null } } });
  });

  afterEach(async () => {
    // A maintenance transition that does not reach release() leaves the gate
    // fenced — by design, ambiguity blocks all normal admission. The suite owns
    // that state, so it unwinds it through the production gate API instead of
    // leaking a marker into the next test (the transition failure itself is
    // asserted by the restore test, never hidden here).
    await releaseMaintenanceIfMarked();
    await clearDatabase();
    cleanTestBackups(createdBackups);
  });

  it('debe crear AuditLog (BACKUP_CREATED) al crear backup, cumpliendo Audit Contract v1', async () => {
    const user = await createAdministrator('backup-audit@example.com');
    const company = await createTestCompany('Backup Audit Test');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);
    await createTestFixture(company.id);

    const req = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: company.id, password: OWNER_PASSWORD }),
    });
    const res = await backupPOST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    createdBackups.push(body.filename);

    const auditLogs = await db.auditLog.findMany({
      where: { companyId: company.id, action: 'BACKUP_CREATED' },
    });
    expect(auditLogs).toHaveLength(1);

    const log = auditLogs[0];
    expect(log.userId).toBe(user.id);
    expect(log.entity).toBe('Backup');
    expect(log.entityId).toBe(body.id);

    const details = JSON.parse(log.details || '{}');
    expect(details.contractVersion).toBe(1);
    expect(details.filename).toBe(body.filename);
    expect(details.size).toBeGreaterThan(0);
    expect(details.recordCounts).toBeDefined();
    expect(details.recordCounts.glAccounts).toBeGreaterThanOrEqual(1);
  });

  it('debe crear backup y restaurar datos (GL accounts, bank accounts, transacciones, asientos) en una empresa existente', async () => {
    const user = await createAdministrator('backup-full@example.com');
    const company = await createTestCompany('Backup Full Test');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);
    await createTestFixture(company.id);

    // Snapshot IDs before delete
    const glBefore = await db.glAccount.findMany({ where: { companyId: company.id } });
    const bankAccountsBefore = await db.bankAccount.findMany({ where: { companyId: company.id } });
    const statementsBefore = await db.bankStatement.findMany({ where: { companyId: company.id } });
    const entriesBefore = await db.journalEntry.findMany({ where: { companyId: company.id } });

    // Create backup
    const backupReq = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: company.id, password: OWNER_PASSWORD }),
    });
    const backupRes = await backupPOST(backupReq, { params: Promise.resolve({}) });
    expect(backupRes.status).toBe(200);

    const backupBody = await backupRes.json();
    expect(backupBody.filename).toContain(company.id);
    expect(backupBody.recordCounts.glAccounts).toBeGreaterThanOrEqual(1);
    expect(backupBody.recordCounts.bankAccounts).toBe(1);
    expect(backupBody.recordCounts.bankTransactions).toBe(1);
    expect(backupBody.recordCounts.journalEntries).toBe(1);
    createdBackups.push(backupBody.filename);

    const backupData = storedSnapshotBase64(backupBody.filename);

    // Delete only the child data that restore can recreate (keep company + user for auth)
    // Order matters: FK-sensitive children first
    await db.journalLine.deleteMany({ where: { entry: { companyId: company.id } } });
    await db.journalEntry.deleteMany({ where: { companyId: company.id } });
    // The chain head is a link to the tail entry: leaving it behind would be a
    // dangling JournalChainHead.lastEntryId that the restore correctly refuses
    // (RESTORE_REFERENCE), so the whole journal-chain state is removed here.
    await db.journalChainHead.deleteMany({ where: { companyId: company.id } });
    await db.bankTransaction.deleteMany({ where: { statement: { companyId: company.id } } });
    await db.bankStatement.deleteMany({ where: { companyId: company.id } });
    await db.bankAccount.deleteMany({ where: { companyId: company.id } });
    await db.glAccount.deleteMany({ where: { companyId: company.id } });

    // Verify data is gone
    expect(await db.glAccount.findMany({ where: { companyId: company.id } })).toHaveLength(0);
    expect(await db.bankAccount.findMany({ where: { companyId: company.id } })).toHaveLength(0);
    expect(await db.bankStatement.findMany({ where: { companyId: company.id } })).toHaveLength(0);

    // Company still exists (contract: restore operates on existing company)
    expect(await db.company.findUnique({ where: { id: company.id } })).not.toBeNull();

    // Restore from backup
    const restoreReq = new NextRequest(`http://localhost/api/backup/restore?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: backupData }),
    });
    const restoreRes = await restorePOST(restoreReq, { params: Promise.resolve({}) });
    expect(restoreRes.status).toBe(200);

    const restoreBody = await restoreRes.json();
    expect(restoreBody.success).toBe(true);
    expect(restoreBody.status).toBe('committed');
    expect(restoreBody.scope).toBe('database-and-company-config');
    // The restore publishes a safety preimage; remove it with the other backups.
    createdBackups.push(restoreBody.safetyFilename);

    // Verify GL accounts restored
    const glRestored = await db.glAccount.findMany({ where: { companyId: company.id } });
    expect(glRestored).toHaveLength(glBefore.length);

    // Verify bank accounts restored
    const bankRestored = await db.bankAccount.findMany({ where: { companyId: company.id } });
    expect(bankRestored).toHaveLength(bankAccountsBefore.length);

    // Verify transactions restored
    const stmtRestored = await db.bankStatement.findMany({ where: { companyId: company.id } });
    const stmtIds = stmtRestored.map((s) => s.id);
    const txs = await db.bankTransaction.findMany({ where: { statementId: { in: stmtIds } } });
    expect(txs).toHaveLength(1);
    expect(txs[0].reference).toBe('REF-001');

    // Verify journal entries restored
    const entriesRestored = await db.journalEntry.findMany({ where: { companyId: company.id } });
    expect(entriesRestored).toHaveLength(entriesBefore.length);

    // Coordinated-restore audit contract: the legacy RESTORE_COMPLETED /
    // SECURITY_RESTORE_INITIATED pair is written only by the retired lib/backup.ts
    // restore path. /api/backup/restore now commits through
    // restoreCompanyBackupCoordinated, whose atomic evidence is exactly one
    // userId-null COMPANY_RESTORE_COMMITTED receipt (the actor is proven by the
    // RBAC gate above, and the receipt is deliberately not an accounting seal).
    const commitAudit = await db.auditLog.findMany({
      where: { companyId: company.id, action: 'COMPANY_RESTORE_COMMITTED' },
    });
    expect(commitAudit).toHaveLength(1);
    const commitLog = commitAudit[0];
    expect(commitLog.userId).toBeNull();
    expect(commitLog.entity).toBe('Backup');
    expect(commitLog.id).toBe(restoreBody.operationId);
    const commitDetails = JSON.parse(commitLog.details || '{}');
    expect(commitDetails.scope).toBe('database-only');
    expect(commitDetails.safetyFilename).toBe(restoreBody.safetyFilename);
    expect(commitDetails.checksum).toMatch(/^[a-f0-9]{64}$/);

    // The pre-existing audit trail of the source company is replaced by the
    // snapshot (which predates its own BACKUP_CREATED row) — no stale rows leak.
    const staleAudits = await db.auditLog.findMany({
      where: { companyId: company.id, action: { in: ['RESTORE_COMPLETED', 'SECURITY_RESTORE_INITIATED'] } },
    });
    expect(staleAudits).toHaveLength(0);
  });

  it('debe rechazar restauracion con backup de otra empresa', async () => {
    const user = await createAdministrator('backup-cross@example.com');
    const companyA = await createTestCompany('Company A');
    const companyB = await createTestCompany('Company B');
    await createTestCompanyMember(user.id, companyA.id);
    await createTestCompanyMember(user.id, companyB.id);
    const token = await createSession(user.id);

    await createTestFixture(companyA.id);

    const backupReq = new NextRequest(`http://localhost/api/backup?companyId=${companyA.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: companyA.id, password: OWNER_PASSWORD }),
    });
    const backupRes = await backupPOST(backupReq, { params: Promise.resolve({}) });
    const backupBody = await backupRes.json();
    createdBackups.push(backupBody.filename);

    const restoreReq = new NextRequest(`http://localhost/api/backup/restore?companyId=${companyB.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: storedSnapshotBase64(backupBody.filename) }),
    });
    const restoreRes = await restorePOST(restoreReq, { params: Promise.resolve({}) });
    expect(restoreRes.status).toBe(400);

    const restoreBody = await restoreRes.json();
    // Identity admission is a client rejection (AppError -> 400), not a 500.
    expect(restoreBody.code).toBe('VALIDATION_ERROR');
    expect(restoreBody.error).toContain('RESTORE_IDENTITY');
    expect(restoreBody.error).toContain('mismatch');

    // The rejected payload left the other tenant untouched.
    expect(await db.glAccount.findMany({ where: { companyId: companyB.id } })).toHaveLength(0);
    expect(await db.bankAccount.findMany({ where: { companyId: companyB.id } })).toHaveLength(0);
    expect(
      await db.auditLog.findMany({ where: { companyId: companyB.id, action: 'COMPANY_RESTORE_COMMITTED' } }),
    ).toHaveLength(0);
  });

  it('debe rechazar datos de backup invalidos', async () => {
    const user = await createTestUser('backup-invalid@example.com');
    const company = await createTestCompany('Invalid Backup');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const invalidBase64 = Buffer.from('{"invalid": true}').toString('base64');

    const restoreReq = new NextRequest(`http://localhost/api/backup/restore?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: invalidBase64 }),
    });
    const restoreRes = await restorePOST(restoreReq, { params: Promise.resolve({}) });
    expect(restoreRes.status).toBe(400);
  });

  it('debe listar backups de una empresa', async () => {
    const user = await createAdministrator('backup-list@example.com');
    const company = await createTestCompany('List Backup');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    for (let i = 0; i < 2; i++) {
      const req = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, password: OWNER_PASSWORD }),
      });
      const res = await backupPOST(req, { params: Promise.resolve({}) });
      const body = await res.json();
      createdBackups.push(body.filename);
    }

    const listReq = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const listRes = await backupGET(listReq, { params: Promise.resolve({}) });
    expect(listRes.status).toBe(200);

    const listBody = await listRes.json();
    expect(listBody.backups.length).toBe(2);
    expect(listBody.backups[0].filename).toContain(company.id);
  });

  it('ownership check: backup de otra empresa tratado como no existente (404 neutral)', async () => {
    const user = await createTestUser('backup-owner@example.com');
    const company = await createTestCompany('Owner Check');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename: 'other-company_id_test.json' }),
    });
    const res = await backupDELETE(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
  });
});

describe('validateBackup', () => {
  it('debe rechazar backup sin manifest', () => {
    const result = validateBackup({} as never);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing manifest');
  });

  it('debe rechazar backup sin data section', () => {
    const result = validateBackup({
      manifest: { version: '1.0.0', companyId: 'c1', companyInfo: { id: 'c1', legalName: 'T', taxId: null }, createdAt: new Date().toISOString(), recordCounts: {} as never },
    } as never);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing data section');
  });

  it('debe rechazar backup sin company data', () => {
    const result = validateBackup({
      manifest: { version: '1.0.0', companyId: 'c1', companyInfo: { id: 'c1', legalName: 'T', taxId: null }, createdAt: new Date().toISOString(), recordCounts: {} as never },
      data: {
        company: [],
        glAccounts: [],
        bankAccounts: [],
        bankStatements: [],
        bankTransactions: [],
        bankRules: [],
        journalEntries: [],
        journalLines: [],
        fiscalPeriods: [],
        companyMembers: [],
        users: [],
        systemConfig: [],
        companyConfig: null,
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('No company data found');
  });
});
