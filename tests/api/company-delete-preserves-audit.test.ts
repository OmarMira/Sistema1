/**
 * S19 — Accounts and data integrity (Wave 3, unit E)
 *
 *  (c) Deleting a company must NOT destroy audit evidence: AuditLog rows are
 *      hash-chained evidence (the chain is GLOBAL, links are not company
 *      scoped), so they survive the tenant deletion with their companyId
 *      intact and verifyAuditChain still reports a valid chain afterwards.
 *      Every other tenant cleanup stays exactly as it was.
 *  (d) Additive hot-path indexes: Session(expiresAt) and the BankTransaction
 *      review-queue path (companyId, glAccountId, date).
 *  (e) RuleApplyRecord.idempotencyKey uniqueness is per company, not global.
 *  (f) BankTransaction carries a denormalized companyId (defense in depth):
 *      the import path writes it on insert and the migration backfills legacy
 *      rows through statement → account.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import { verifyAuditChain } from '@/lib/journal-hash';
import { createSession } from '@/lib/sessions';
import { ImportService } from '@/lib/services/import.service';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  clearDatabase,
} from '../helpers/factories';
import { DELETE as deleteCompany } from '../../src/app/api/admin/companies/[id]/route';
import { GET as adminAuditLogsGET } from '../../src/app/api/admin/audit-logs/route';

const ROUTE_CONTEXT = (id: string) => ({ params: Promise.resolve({ id }) });

/** Super admin with the verified identity the API gate requires. */
async function createSuperAdmin(email: string) {
  const user = await createTestUser(email);
  const promoted = await db.user.update({
    where: { id: user.id },
    data: { platformRole: 'super_admin', emailVerifiedAt: new Date(), legacyUser: false },
  });
  const token = await createSession(promoted.id);
  return { user: promoted, token };
}

function deleteRequest(companyId: string, token: string) {
  return new NextRequest(`http://localhost/api/admin/companies/${companyId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function indexNames(table: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE tablename = ${table} ORDER BY indexname`;
  return rows.map((row) => row.indexname);
}

/**
 * RuleApplyRecord has no cascade from User and clearDatabase() does not know
 * about it: purge the rows this suite (or a previous failed run) created so the
 * helper's user deletion cannot hit RuleApplyRecord_userId_fkey.
 */
async function purgeRuleApplyRecords() {
  await db.ruleApplyRecord.deleteMany({
    where: { user: { email: { contains: '@example.com' } } },
  });
}

beforeEach(async () => {
  await purgeRuleApplyRecords();
  await clearDatabase();
  // The audit chain is one global sequence: this suite owns its starting point.
  await db.auditLog.deleteMany({});
});

afterEach(async () => {
  await db.auditLog.deleteMany({});
  await purgeRuleApplyRecords();
  await clearDatabase();
});

// ─────────────────────────────────────────────────────────────────────
// S19(c) — audit evidence survives a company deletion
// ─────────────────────────────────────────────────────────────────────
describe('S19(c) — company deletion preserves hash-chained audit evidence', () => {
  it('keeps the deleted company audit rows and the global chain still verifies', async () => {
    const { user, token } = await createSuperAdmin('s19c-evidence-admin@example.com');
    const company = await createTestCompany('S19c Evidence Co');
    await createTestCompanyMember(user.id, company.id);
    const glAccount = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
    });

    const firstRow = await createAuditLogWithRetry({
      companyId: company.id,
      userId: user.id,
      action: 'TEST_EVIDENCE_ONE',
      entity: 'Company',
      entityId: company.id,
    });
    const secondRow = await createAuditLogWithRetry({
      companyId: company.id,
      userId: user.id,
      action: 'TEST_EVIDENCE_TWO',
      entity: 'GlAccount',
      entityId: glAccount.id,
    });
    expect(firstRow.hash).toBeTruthy();
    expect(secondRow.previousHash).toBe(firstRow.hash);

    const res = await deleteCompany(deleteRequest(company.id, token), ROUTE_CONTEXT(company.id));
    expect(res.status).toBe(200);

    // The tenant itself is gone...
    expect(await db.company.findUnique({ where: { id: company.id } })).toBeNull();

    // ...but its audit evidence is not, and it still belongs to that company.
    const rows = await db.auditLog.findMany({
      where: { id: { in: [firstRow.id, secondRow.id] } },
      orderBy: { id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.companyId).toBe(company.id);
      expect(row.hash).toBeTruthy();
    }

    const verdict = await verifyAuditChain();
    expect(verdict.valid).toBe(true);
    expect(verdict.reasonCode).toBeUndefined();
    expect(verdict.members).toBe(2);
    expect(verdict.companyRows).toBeUndefined();
  });

  it('PRESERVE — every other tenant cleanup and the other tenants remain as before', async () => {
    const { user, token } = await createSuperAdmin('s19c-preserve-admin@example.com');

    const doomed = await createTestCompany('S19c Doomed Co');
    await createTestCompanyMember(user.id, doomed.id);
    const doomedGl = await createTestGlAccount({ companyId: doomed.id, code: '1010', name: 'Cash' });
    const doomedBank = await createTestBankAccount(doomed.id, doomedGl.id, 'Doomed Bank');
    const doomedStatement = await db.bankStatement.create({
      data: {
        companyId: doomed.id,
        bankAccountId: doomedBank.id,
        startDate: new Date('2025-03-01'),
        endDate: new Date('2025-03-31'),
        openingBalance: 0,
        closingBalance: 10,
        format: 'csv',
        fileName: 'doomed.csv',
      },
    });
    await db.bankTransaction.create({
      data: {
        statementId: doomedStatement.id,
        date: new Date('2025-03-05'),
        description: 'DOOMED ROW',
        amount: 10,
      },
    });
    await db.fiscalPeriod.create({
      data: {
        companyId: doomed.id,
        name: 'S19c 2025',
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-12-31'),
      },
    });

    const survivor = await createTestCompany('S19c Survivor Co');
    const survivorGl = await createTestGlAccount({
      companyId: survivor.id,
      code: '1010',
      name: 'Cash',
    });
    await createAuditLogWithRetry({
      companyId: survivor.id,
      action: 'TEST_SURVIVOR_EVIDENCE',
      entity: 'GlAccount',
      entityId: survivorGl.id,
    });

    const res = await deleteCompany(deleteRequest(doomed.id, token), ROUTE_CONTEXT(doomed.id));
    expect(res.status).toBe(200);

    // Tenant-scoped cleanup unchanged.
    expect(await db.glAccount.count({ where: { companyId: doomed.id } })).toBe(0);
    expect(await db.bankAccount.count({ where: { companyId: doomed.id } })).toBe(0);
    expect(await db.bankStatement.count({ where: { companyId: doomed.id } })).toBe(0);
    expect(await db.bankTransaction.count({ where: { statementId: doomedStatement.id } })).toBe(0);
    expect(await db.fiscalPeriod.count({ where: { companyId: doomed.id } })).toBe(0);
    expect(await db.companyMember.count({ where: { companyId: doomed.id } })).toBe(0);

    // The other tenant is untouched.
    expect(await db.company.findUnique({ where: { id: survivor.id } })).not.toBeNull();
    expect(await db.glAccount.count({ where: { companyId: survivor.id } })).toBe(1);
    const survivorRows = await db.auditLog.findMany({ where: { companyId: survivor.id } });
    expect(survivorRows).toHaveLength(1);
    expect(survivorRows[0]!.hash).toBeTruthy();

    const verdict = await verifyAuditChain();
    expect(verdict.valid).toBe(true);
    expect(verdict.members).toBe(1);
  });

  it('keeps the admin audit-log listing shape: company { id, legalName } while it exists, null after deletion', async () => {
    const { user, token } = await createSuperAdmin('s19c-listing-admin@example.com');
    const company = await createTestCompany('S19c Listing Co');
    await createTestCompanyMember(user.id, company.id);
    const row = await createAuditLogWithRetry({
      companyId: company.id,
      action: 'TEST_LISTING_EVIDENCE',
      entity: 'Company',
      entityId: company.id,
    });

    const listingRequest = () =>
      new NextRequest('http://localhost/api/admin/audit-logs', {
        headers: { Authorization: `Bearer ${token}` },
      });

    const before = await adminAuditLogsGET(listingRequest(), { params: Promise.resolve({}) });
    expect(before.status).toBe(200);
    const beforeRows = (await before.json()).auditLogs as Array<{
      id: string;
      companyId: string | null;
      company: { id: string; legalName: string } | null;
    }>;
    const beforeRow = beforeRows.find((entry) => entry.id === row.id);
    expect(beforeRow?.companyId).toBe(company.id);
    expect(beforeRow?.company).toEqual({ id: company.id, legalName: 'S19c Listing Co' });

    const res = await deleteCompany(deleteRequest(company.id, token), ROUTE_CONTEXT(company.id));
    expect(res.status).toBe(200);

    const after = await adminAuditLogsGET(listingRequest(), { params: Promise.resolve({}) });
    expect(after.status).toBe(200);
    const afterRows = (await after.json()).auditLogs as typeof beforeRows;
    const afterRow = afterRows.find((entry) => entry.id === row.id);
    // The evidence row survives with its historical scope, and the resolved
    // company is null because the tenant no longer exists.
    expect(afterRow?.companyId).toBe(company.id);
    expect(afterRow?.company).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// S19(d)(e)(f) — structural proof: indexes, column, uniqueness
// ─────────────────────────────────────────────────────────────────────
describe('S19(d)(e)(f) — additive index and column structure', () => {
  it('exposes the Session expiry index and the BankTransaction review-queue index', async () => {
    expect(await indexNames('Session')).toContain('Session_expiresAt_idx');
    expect(await indexNames('BankTransaction')).toContain(
      'BankTransaction_companyId_glAccountId_date_idx',
    );
  });

  it('carries the denormalized BankTransaction.companyId column', async () => {
    const columns = await db.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'BankTransaction' AND column_name = 'companyId'`;
    expect(columns).toHaveLength(1);
    expect(columns[0]!.is_nullable).toBe('YES');
    expect(await indexNames('BankTransaction')).toContain('BankTransaction_companyId_idx');
  });

  it('replaces the global RuleApplyRecord idempotencyKey unique index with the per-company one', async () => {
    const names = await indexNames('RuleApplyRecord');
    expect(names).toContain('RuleApplyRecord_companyId_idempotencyKey_key');
    expect(names).not.toContain('RuleApplyRecord_idempotencyKey_key');
  });
});

describe('S19(e) — RuleApplyRecord idempotency is scoped per company', () => {
  it('accepts the same key in two companies and still rejects a repeat inside one company', async () => {
    const user = await createTestUser('s19e-idempotency@example.com');
    const companyA = await createTestCompany('S19e Company A');
    const companyB = await createTestCompany('S19e Company B');
    const key = 's19e-shared-idempotency-key';

    const recordA = await db.ruleApplyRecord.create({
      data: { companyId: companyA.id, userId: user.id, idempotencyKey: key },
    });
    const recordB = await db.ruleApplyRecord.create({
      data: { companyId: companyB.id, userId: user.id, idempotencyKey: key },
    });

    expect(recordA.companyId).toBe(companyA.id);
    expect(recordB.companyId).toBe(companyB.id);
    expect(recordA.idempotencyKey).toBe(key);
    expect(recordB.idempotencyKey).toBe(key);

    await expect(
      db.ruleApplyRecord.create({
        data: { companyId: companyA.id, userId: user.id, idempotencyKey: key },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// S19(f) — denormalized companyId is written and backfilled
// ─────────────────────────────────────────────────────────────────────
describe('S19(f) — BankTransaction.companyId via the import path and the backfill', () => {
  async function seedBankAccount(companyName: string) {
    const company = await createTestCompany(companyName);
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const bankAccount = await db.bankAccount.create({
      data: {
        companyId: company.id,
        accountName: 'Checking',
        bankName: 'Test Bank',
        accountNo: 'ACC-1',
        glAccountId: cash.id,
        balance: 0,
        currency: 'USD',
        isActive: true,
      },
    });
    return { company, bankAccount };
  }

  it('the import service writes companyId on every inserted transaction', async () => {
    const { company, bankAccount } = await seedBankAccount('S19f Import Co');
    const content = 'date,description,amount\n2025-09-01,S19F IMPORTED ROW,25.00\n';

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 's19f.csv',
      extension: 'csv',
      buffer: Buffer.from(content, 'utf8'),
      content,
      userId: 'test-user',
    });

    expect(result.transactionCount).toBe(1);

    const rows = await db.bankTransaction.findMany({
      where: { statementId: result.statementId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe('S19F IMPORTED ROW');
    expect(rows[0]!.companyId).toBe(company.id);
  });

  it('the backfill statement fills legacy rows through statement → account', async () => {
    const { company, bankAccount } = await seedBankAccount('S19f Backfill Co');
    const statement = await db.bankStatement.create({
      data: {
        companyId: company.id,
        bankAccountId: bankAccount.id,
        startDate: new Date('2025-04-01'),
        endDate: new Date('2025-04-30'),
        openingBalance: 0,
        closingBalance: 15,
        format: 'csv',
        fileName: 'legacy.csv',
      },
    });
    // Pre-migration shape: the row exists with no denormalized companyId.
    const legacy = await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2025-04-10'),
        description: 'S19F LEGACY ROW',
        amount: 15,
      },
    });
    expect(legacy.companyId).toBeNull();

    // Mirrors prisma/migrations/20261105000001_banktransaction_company_backfill.
    // The statement is a global UPDATE, so the shared fixture may legitimately
    // hold other pre-migration rows: only this row's outcome is asserted.
    const updated = await db.$executeRaw`
      UPDATE "BankTransaction" bt
      SET "companyId" = ba."companyId"
      FROM "BankStatement" bs
      JOIN "BankAccount" ba ON bs."bankAccountId" = ba."id"
      WHERE bt."statementId" = bs."id" AND bt."companyId" IS NULL`;
    expect(updated).toBeGreaterThanOrEqual(1);

    const filled = await db.bankTransaction.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(filled.companyId).toBe(company.id);

    // Invariant the migration establishes for this tenant: no row trails its
    // statement tenant.
    const lagging = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM "BankTransaction" bt
      JOIN "BankStatement" bs ON bt."statementId" = bs."id"
      WHERE bt."companyId" IS NULL AND bs."companyId" = ${company.id}`;
    expect(lagging[0]!.count).toBe(0);
  });
});
