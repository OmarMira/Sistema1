import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { restoreBackup, type BackupData } from '@/lib/backup';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { createTestUser, createTestCompany, clearDatabase } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

function buildMinimalBackup(
  company: { id: string; legalName: string },
  user: { id: string; email: string; firstName: string; lastName: string; passwordHash: string },
  withHash = true,
): BackupData {
  const memberId = `member-${crypto.randomUUID()}`;
  return {
    manifest: {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      companyId: company.id,
      companyInfo: { id: company.id, legalName: company.legalName, taxId: null },
      recordCounts: {
        company: 1,
        glAccounts: 0,
        bankAccounts: 0,
        bankStatements: 0,
        bankTransactions: 0,
        bankRules: 0,
        journalEntries: 0,
        journalLines: 0,
        fiscalPeriods: 0,
        companyMembers: 1,
        users: 1,
        systemConfig: 0,
        companyConfig: false,
      },
    },
    data: {
      company: [{ id: company.id, legalName: company.legalName, entityType: 'BUSINESS', taxId: '12-3456789', isActive: true }],
      users: [
        withHash
          ? { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, passwordHash: user.passwordHash, role: 'company_admin', isActive: true }
          : { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: 'company_admin', isActive: true },
      ],
      companyMembers: [{ id: memberId, userId: user.id, companyId: company.id, role: 'company_admin', joinedAt: new Date().toISOString() }],
      glAccounts: [],
      bankAccounts: [],
      bankStatements: [],
      bankTransactions: [],
      bankRules: [],
      journalEntries: [],
      journalLines: [],
      fiscalPeriods: [],
      systemConfig: [],
      companyConfig: null,
    },
  };
}

describe('F-5 — non-bootstrap restore must not set a known default password (remediation)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    log('AFTER-ALL: remaining @example.com users =', await db.user.count({ where: { email: { contains: '@example.com' } } }));
  });

  async function setupUserWithPassword(email: string, password: string) {
    const user = await createTestUser(email);
    return db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
      select: { id: true, email: true, firstName: true, lastName: true, passwordHash: true },
    });
  }

  it('Q1: restore of a backup WITH a bcrypt hash preserves it (original login works, Admin123! does not)', async () => {
    const user = await setupUserWithPassword('f5-q1@example.com', 'original-password');
    const company = await createTestCompany('F5 Q1 Co');
    const backupData = buildMinimalBackup(company, user, true);

    const result = await restoreBackup(company.id, backupData, user.id);
    const stored = await db.user.findUnique({ where: { id: user.id } });
    const loginOriginal = await verifyPassword('original-password', stored!.passwordHash);
    const loginDefault = await verifyPassword('Admin123!', stored!.passwordHash);

    log('Q1: restore WITH hash -> success =', result.success);
    log('Q1: login with original password =', loginOriginal, '| login with Admin123! =', loginDefault);
    expect(result.success).toBe(true);
    expect(loginOriginal).toBe(true);
    expect(loginDefault).toBe(false);
  });

  it('Q2: restore of a backup WITHOUT a hash must NOT enable login with Admin123!', async () => {
    const user = await setupUserWithPassword('f5-q2@example.com', 'original-password');
    const company = await createTestCompany('F5 Q2 Co');
    const backupData = buildMinimalBackup(company, user, false);
    log('Q2: passwordHash omitted from backup before restore');

    const result = await restoreBackup(company.id, backupData, user.id);
    const stored = await db.user.findUnique({ where: { id: user.id } });
    const loginDefault = await verifyPassword('Admin123!', stored!.passwordHash);

    log('Q2: restore WITHOUT hash -> success =', result.success, '| login with Admin123! =', loginDefault);
    expect(result.success).toBe(true);
    expect(loginDefault).toBe(false);
  });

  it('Q3 (control): bootstrap restore keeps preserving the hash (unchanged behavior)', async () => {
    const user = await setupUserWithPassword('f5-q3@example.com', 'original-password');
    const company = await createTestCompany('F5 Q3 Co');
    const backupData = buildMinimalBackup(company, user, true);

    const result = await restoreBackup(company.id, backupData, user.id, { bootstrap: true });
    const stored = await db.user.findUnique({ where: { id: user.id } });
    const loginOriginal = await verifyPassword('original-password', stored!.passwordHash);

    log('Q3: bootstrap restore -> success =', result.success, '| login with original password =', loginOriginal);
    expect(result.success).toBe(true);
    expect(loginOriginal).toBe(true);
  });
});
