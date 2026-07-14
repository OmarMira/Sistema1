import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as backupPOST, GET as backupGET, DELETE as backupDELETE } from '../../src/app/api/backup/route';
import { POST as restorePOST } from '../../src/app/api/backup/restore/route';
import { validateBackup } from '../../src/lib/backup';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction, createTestJournalEntry, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
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
  await createTestJournalEntry(companyId, {
    date: '2025-03-15',
    description: 'Test entry',
    lines: [
      { glAccountId: gl.id, debit: 500, credit: 0 },
      { glAccountId: gl.id, debit: 0, credit: 500 },
    ],
  });
  return { gl, bankAccount, statement };
}

describe('POST /api/backup + POST /api/backup/restore', () => {
  const createdBackups: string[] = [];

  beforeEach(async () => {
    await clearDatabase();
    createdBackups.length = 0;
  });

  afterEach(async () => {
    await clearDatabase();
    cleanTestBackups(createdBackups);
  });

  it('debe crear backup y restaurar datos (GL accounts, bank accounts, transacciones, asientos) en una empresa existente', async () => {
    const user = await createTestUser('backup-full@example.com');
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
      headers: { 'Authorization': `Bearer ${token}` },
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

    const backupData = backupBody.data;

    // Delete only the child data that restore can recreate (keep company + user for auth)
    // Order matters: FK-sensitive children first
    await db.journalLine.deleteMany({ where: { entry: { companyId: company.id } } });
    await db.journalEntry.deleteMany({ where: { companyId: company.id } });
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
  });

  it('debe rechazar restauracion con backup de otra empresa', async () => {
    const user = await createTestUser('backup-cross@example.com');
    const companyA = await createTestCompany('Company A');
    const companyB = await createTestCompany('Company B');
    await createTestCompanyMember(user.id, companyA.id);
    await createTestCompanyMember(user.id, companyB.id);
    const token = await createSession(user.id);

    await createTestFixture(companyA.id);

    const backupReq = new NextRequest(`http://localhost/api/backup?companyId=${companyA.id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
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
      body: JSON.stringify({ data: backupBody.data }),
    });
    const restoreRes = await restorePOST(restoreReq, { params: Promise.resolve({}) });
    expect(restoreRes.status).toBe(400);

    const restoreBody = await restoreRes.json();
    expect(restoreBody.error).toContain('does not match');
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
    const user = await createTestUser('backup-list@example.com');
    const company = await createTestCompany('List Backup');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    for (let i = 0; i < 2; i++) {
      const req = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
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

  it('ownership check: debe rechazar eliminacion de backup de otra empresa', async () => {
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
    expect(res.status).toBe(403);
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
