import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { createBackup, restoreBackup } from '@/lib/backup';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups');
const MANIFEST_PATH = path.join(BACKUP_DIR, 'manifest.json');
const diskTestCompanyIds = new Set<string>();
const createdCompanyIds = new Set<string>();

function readManifestFile(): { backups: Array<Record<string, unknown>> } {
  if (!fs.existsSync(MANIFEST_PATH)) return { backups: [] };
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch {
    return { backups: [] };
  }
}

function cleanupDiskArtifacts(): void {
  const manifest = readManifestFile();
  const kept = manifest.backups.filter((b) => !diskTestCompanyIds.has(String(b.companyId)));
  if (kept.length !== manifest.backups.length) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ backups: kept }, null, 2) + '\n', 'utf-8');
  }
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (diskTestCompanyIds.has(f.split('_')[0])) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  }
}

async function cleanupCreatedDbRows(): Promise<void> {
  const ids = [...createdCompanyIds];
  createdCompanyIds.clear();
  if (ids.length === 0) return;
  const filter = { companyId: { in: ids } };
  await db.journalLine.deleteMany({ where: { entry: filter } }).catch(() => {});
  await db.journalEntry.deleteMany({ where: filter }).catch(() => {});
  const statements = await db.bankStatement.findMany({ where: filter, select: { id: true } }).catch(() => []);
  if (statements.length > 0) {
    await db.bankTransaction.deleteMany({ where: { statementId: { in: statements.map((s) => s.id) } } }).catch(() => {});
  }
  await db.bankStatement.deleteMany({ where: filter }).catch(() => {});
  await db.bankRule.deleteMany({ where: filter }).catch(() => {});
  await db.bankAccount.deleteMany({ where: filter }).catch(() => {});
  await db.glAccount.deleteMany({ where: filter }).catch(() => {});
  await db.fiscalPeriod.deleteMany({ where: filter }).catch(() => {});
  await db.ruleApplyRecord.deleteMany({ where: filter }).catch(() => {});
  await db.entityContext.deleteMany({ where: filter }).catch(() => {});
  await db.companyMember.deleteMany({ where: filter }).catch(() => {});
  await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

describe('C3 — Restore FK integrity with auto-classification artifacts (dynamic PoC)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    await cleanupCreatedDbRows();
  });

  afterAll(async () => {
    const leftoverUsers = await db.user.count({ where: { email: { contains: '@example.com' } } });
    const testCompanies = await db.company.findMany({
      where: { legalName: { in: ['Acme Corp'] } },
      select: { id: true },
    });
    const testCompanyIds = testCompanies.map((c) => c.id);
    const scoped = testCompanyIds.length ? { companyId: { in: testCompanyIds } } : { companyId: { in: ['__none__'] } };
    const leftoverRar = await db.ruleApplyRecord.count({ where: scoped });
    const leftoverEc = await db.entityContext.count({ where: scoped });
    log('AFTER-ALL DB STATE: users =', leftoverUsers, '| acme companies =', testCompanies.length, '| acme ruleApplyRecords =', leftoverRar, '| acme entityContexts =', leftoverEc);
    cleanupDiskArtifacts();
  });

  it('Case A: backup with JournalEntry.ruleApplyRecordId fails with FK violation when the anchor is absent', async () => {
    // Setup: company with a RuleApplyRecord-driven journal entry (auto-classification)
    const user = await createTestUser('c3a@example.com');
    const company = await createTestCompany('Acme Corp');
    await createTestCompanyMember(user.id, company.id);
    diskTestCompanyIds.add(company.id);
    createdCompanyIds.add(company.id);

    const gl = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const rar = await db.ruleApplyRecord.create({
      data: { companyId: company.id, userId: user.id, idempotencyKey: 'c3a-key-1' },
    });
    const entry = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2026-03-01'),
        description: 'Auto-classified entry',
        status: 'posted',
        ruleApplyRecordId: rar.id,
        lines: { create: [{ glAccountId: gl.id, debit: 100, credit: 0 }] },
      },
    });
    log('SEEDED: ruleApplyRecord.id =', rar.id, '| journalEntry.id =', entry.id, '| journalEntry.ruleApplyRecordId =', entry.ruleApplyRecordId);

    // 1. Create a legitimate backup
    const backup = await createBackup(company.id);
    const backupData = JSON.parse(Buffer.from(backup.data, 'base64').toString('utf-8'));

    // 2. Static check: does the payload carry the FK but NOT the anchor entity?
    const payloadEntry = backupData.data.journalEntries.find((e: { id: string }) => e.id === entry.id);
    expect(payloadEntry.ruleApplyRecordId).toBe(rar.id);
    expect(backupData.data.ruleApplyRecords).toBeUndefined();
    log('PAYLOAD: journalEntry.ruleApplyRecordId =', payloadEntry.ruleApplyRecordId, '| data.ruleApplyRecords section =', backupData.data.ruleApplyRecords);

    // 3. Simulate the anchor being absent at restore time (fresh DB / disaster recovery)
    const deleted = await db.ruleApplyRecord.delete({ where: { id: rar.id } });
    log('REMOVED anchor (simulates fresh DB): ruleApplyRecord', deleted.id, 'deleted');
    const dbBefore = await db.journalEntry.count({ where: { companyId: company.id } });
    const linesBefore = await db.journalLine.count({ where: { entry: { companyId: company.id } } });
    const memBefore = await db.companyMember.count({ where: { companyId: company.id } });
    log('DB BEFORE RESTORE: journalEntries =', dbBefore, '| journalLines =', linesBefore, '| companyMembers =', memBefore);

    // 4. Restore it
    const result = await restoreBackup(company.id, backupData, user.id);
    log('RESTORE result: success =', result.success, '| message =', result.message);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/rollback|rolled back/i);

    // 5. Transaction state after failure: no partial data
    const dbAfter = await db.journalEntry.count({ where: { companyId: company.id } });
    const linesAfter = await db.journalLine.count({ where: { entry: { companyId: company.id } } });
    const memAfter = await db.companyMember.count({ where: { companyId: company.id } });
    const glAfter = await db.glAccount.count({ where: { companyId: company.id } });
    log('DB AFTER FAILED RESTORE: journalEntries =', dbAfter, '| journalLines =', linesAfter, '| companyMembers =', memAfter, '| glAccounts =', glAfter);
    expect(dbAfter).toBe(dbBefore);
    expect(linesAfter).toBe(linesBefore);
    expect(memAfter).toBe(memBefore);
  });

  it('Case B: backup with BankRule.entityContextId fails with FK violation when the anchor is absent', async () => {
    const user = await createTestUser('c3b@example.com');
    const company = await createTestCompany('Acme Corp');
    await createTestCompanyMember(user.id, company.id);
    diskTestCompanyIds.add(company.id);
    createdCompanyIds.add(company.id);

    const gl = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const ec = await db.entityContext.create({
      data: { companyId: company.id, pattern: 'ZELLE PAYMENT', role: 'revenue' },
    });
    const rule = await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Zelle rule',
        conditionType: 'description',
        conditionValue: 'zelle',
        entityContextId: ec.id,
        glAccountId: gl.id,
      },
    });
    log('SEEDED: entityContext.id =', ec.id, '| bankRule.id =', rule.id, '| bankRule.entityContextId =', rule.entityContextId);

    const backup = await createBackup(company.id);
    const backupData = JSON.parse(Buffer.from(backup.data, 'base64').toString('utf-8'));

    const payloadRule = backupData.data.bankRules.find((r: { id: string }) => r.id === rule.id);
    expect(payloadRule.entityContextId).toBe(ec.id);
    expect(backupData.data.entityContexts).toBeUndefined();
    log('PAYLOAD: bankRule.entityContextId =', payloadRule.entityContextId, '| data.entityContexts section =', backupData.data.entityContexts);

    const deleted = await db.entityContext.delete({ where: { id: ec.id } });
    log('REMOVED anchor (simulates fresh DB): entityContext', deleted.id, 'deleted');
    const rulesBefore = await db.bankRule.count({ where: { companyId: company.id } });
    const glBefore = await db.glAccount.count({ where: { companyId: company.id } });
    const memBefore = await db.companyMember.count({ where: { companyId: company.id } });

    const result = await restoreBackup(company.id, backupData, user.id);
    log('RESTORE result: success =', result.success, '| message =', result.message);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/rollback|rolled back/i);

    const rulesAfter = await db.bankRule.count({ where: { companyId: company.id } });
    const glAfter = await db.glAccount.count({ where: { companyId: company.id } });
    const memAfter = await db.companyMember.count({ where: { companyId: company.id } });
    log('DB AFTER FAILED RESTORE: bankRules =', rulesAfter, '| glAccounts =', glAfter, '| companyMembers =', memAfter);
    expect(rulesAfter).toBe(rulesBefore);
    expect(glAfter).toBe(glBefore);
    expect(memAfter).toBe(memBefore);
  });
});
