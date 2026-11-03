import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { createBackup } from '@/lib/backup';
import { restoreCompanyBackup } from '@/lib/backup-restore';
import { sealSnapshot } from '@/lib/backup-format';
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

  it('Case A: a backup carrying JournalEntry.ruleApplyRecordId without its anchor is refused, never half-restored', async () => {
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

    // 2. Current 2.x contract: the FK and its anchor travel together, so a
    // backup the running app produces can never carry a dangling FK.
    const payloadEntry = backupData.data.journalEntries.find((e: { id: string }) => e.id === entry.id);
    expect(payloadEntry.ruleApplyRecordId).toBe(rar.id);
    const payloadRecords = backupData.data.ruleApplyRecords as Array<{ id: string }>;
    expect(payloadRecords.map((r) => r.id)).toContain(rar.id);
    log('PAYLOAD: journalEntry.ruleApplyRecordId =', payloadEntry.ruleApplyRecordId, '| anchor in ruleApplyRecords =', payloadRecords.some((r) => r.id === rar.id));

    // 3. The FK-break artifact this PoC exists for: a payload that carries the
    // FK but NOT the anchor (the legacy shape). The document stays otherwise
    // self-consistent — row count and seal are recomputed — so the dangling
    // reference is the ONLY defect left for restore admission to catch.
    backupData.data.ruleApplyRecords = payloadRecords.filter((r) => r.id !== rar.id);
    backupData.manifest.recordCounts.ruleApplyRecords = backupData.data.ruleApplyRecords.length;
    sealSnapshot(backupData);

    // 4. Simulate the anchor being absent at restore time (fresh DB / disaster recovery)
    const deleted = await db.ruleApplyRecord.delete({ where: { id: rar.id } });
    log('REMOVED anchor (simulates fresh DB): ruleApplyRecord', deleted.id, 'deleted');
    const dbBefore = await db.journalEntry.count({ where: { companyId: company.id } });
    const linesBefore = await db.journalLine.count({ where: { entry: { companyId: company.id } } });
    const memBefore = await db.companyMember.count({ where: { companyId: company.id } });
    log('DB BEFORE RESTORE: journalEntries =', dbBefore, '| journalLines =', linesBefore, '| companyMembers =', memBefore);

    // 5. Restore it: the dangling FK is rejected at admission.
    await expect(
      restoreCompanyBackup(company.id, JSON.stringify(backupData)),
    ).rejects.toThrow(/RESTORE_REFERENCE: JournalEntry\.ruleApplyRecordId/);

    // 6. Transaction state after the refusal: no partial data
    const dbAfter = await db.journalEntry.count({ where: { companyId: company.id } });
    const linesAfter = await db.journalLine.count({ where: { entry: { companyId: company.id } } });
    const memAfter = await db.companyMember.count({ where: { companyId: company.id } });
    const glAfter = await db.glAccount.count({ where: { companyId: company.id } });
    log('DB AFTER REFUSED RESTORE: journalEntries =', dbAfter, '| journalLines =', linesAfter, '| companyMembers =', memAfter, '| glAccounts =', glAfter);
    expect(dbAfter).toBe(dbBefore);
    expect(linesAfter).toBe(linesBefore);
    expect(memAfter).toBe(memBefore);
  });

  it('Case B: a backup carrying BankRule.entityContextId without its anchor is refused, never half-restored', async () => {
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

    // Current 2.x contract: entityContexts is a RESTORE_MODELS section, so the
    // referenced anchor is part of the same payload as the referencing rule.
    const payloadRule = backupData.data.bankRules.find((r: { id: string }) => r.id === rule.id);
    expect(payloadRule.entityContextId).toBe(ec.id);
    const payloadContexts = backupData.data.entityContexts as Array<{ id: string }>;
    expect(payloadContexts.map((c) => c.id)).toContain(ec.id);
    log('PAYLOAD: bankRule.entityContextId =', payloadRule.entityContextId, '| anchor in entityContexts =', payloadContexts.some((c) => c.id === ec.id));

    // The FK-break artifact: the FK travels without its anchor (count and seal
    // recomputed, so the dangling reference is the only defect).
    backupData.data.entityContexts = payloadContexts.filter((c) => c.id !== ec.id);
    backupData.manifest.recordCounts.entityContexts = backupData.data.entityContexts.length;
    sealSnapshot(backupData);

    const deleted = await db.entityContext.delete({ where: { id: ec.id } });
    log('REMOVED anchor (simulates fresh DB): entityContext', deleted.id, 'deleted');
    const rulesBefore = await db.bankRule.count({ where: { companyId: company.id } });
    const glBefore = await db.glAccount.count({ where: { companyId: company.id } });
    const memBefore = await db.companyMember.count({ where: { companyId: company.id } });

    // Dangling reference refused before any write.
    await expect(
      restoreCompanyBackup(company.id, JSON.stringify(backupData)),
    ).rejects.toThrow(/RESTORE_REFERENCE: BankRule\.entityContextId/);

    const rulesAfter = await db.bankRule.count({ where: { companyId: company.id } });
    const glAfter = await db.glAccount.count({ where: { companyId: company.id } });
    const memAfter = await db.companyMember.count({ where: { companyId: company.id } });
    log('DB AFTER REFUSED RESTORE: bankRules =', rulesAfter, '| glAccounts =', glAfter, '| companyMembers =', memAfter);
    expect(rulesAfter).toBe(rulesBefore);
    expect(glAfter).toBe(glBefore);
    expect(memAfter).toBe(memBefore);
  });
});
