import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { clearDatabase, createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE-G4-AB-BULK]', ...args);

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-placeholder'));
const mockCreateAuditLog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/audit', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/audit')>();
  mockCreateAuditLog.mockImplementation(mod.createAuditLogWithRetry);
  return {
    ...mod,
    createAuditLogWithRetry: mockCreateAuditLog,
  };
});

const createdCompanyIds = new Set<string>();

async function cleanup() {
  const testUsers = await db.user.findMany({ where: { email: { contains: '@example.com' } }, select: { id: true } });
  const testUserIds = testUsers.map((u) => u.id);
  if (testUserIds.length > 0) {
    await db.session.deleteMany({ where: { user: { id: { in: testUserIds } } } }).catch(() => {});
    await db.ruleApplyRecord.deleteMany({ where: { userId: { in: testUserIds } } }).catch(() => {});
  }
  if (createdCompanyIds.size > 0) {
    await db.ruleApplyRecord.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.bankRule.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.reconciliationPeriod.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.companyKnowledge.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.companyMember.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: [...createdCompanyIds] } } }).catch(() => {});
    createdCompanyIds.clear();
  }
  await clearDatabase();
}

describe('G4-AB-BULK — Bulk/import/reconciliation writes matrix (A/B)', () => {
  beforeEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    mockGetSessionUserId.mockResolvedValue('user-placeholder');
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function seedTenants() {
    const tenantA = await createTestCompany('G4 AB Bulk Tenant A');
    createdCompanyIds.add(tenantA.id);
    const tenantB = await createTestCompany('G4 AB Bulk Tenant B');
    createdCompanyIds.add(tenantB.id);
    const attacker = await createTestUser('attacker-g4abbulk@example.com');
    await createTestCompanyMember(attacker.id, tenantA.id);
    const ownerB = await createTestUser('owner-g4abbulk@example.com');
    await createTestCompanyMember(ownerB.id, tenantB.id);
    return { tenantA, tenantB, attacker, ownerB };
  }

  async function seedRuleAndTxB(tenantBId: string) {
    const gl = await createTestGlAccount({ companyId: tenantBId, code: '6000', name: 'Expense B' });
    const rule = await db.bankRule.create({
      data: {
        companyId: tenantBId,
        name: 'CLIENT Rule B',
        conditionType: 'contains',
        conditionValue: 'CLIENT',
        transactionDirection: 'any',
        glAccountId: gl.id,
        priority: 10,
        isActive: true,
      },
    });
    const bankGl = await createTestGlAccount({ companyId: tenantBId, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantBId, bankGl.id, 'Own Bank B');
    const statement = await createTestBankStatement(tenantBId, bank.id);
    const tx = await createTestBankTransaction(tenantBId, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'CLIENT PAYMENT',
    });
    return { gl, rule, bank, statement, tx };
  }

  it('A-spoof: POST /api/bank-rules/apply-all?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    await seedRuleAndTxB(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/bank-rules/apply-all/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/bank-rules/apply-all?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    log('A-spoof apply-all status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: POST /api/bank-rules/apply-all?companyId=B — owner applies own rules (200 EXECUTED + real effect)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const { gl, tx } = await seedRuleAndTxB(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { POST } = await import('@/app/api/bank-rules/apply-all/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/bank-rules/apply-all?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('EXECUTED');
    expect(body.success).toBe(true);
    expect(body.matched).toBe(1);

    const stored = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(stored?.glAccountId).toBe(gl.id);
    expect(stored?.matchedRuleId).toBeTruthy();
  });

  it('A-spoof: POST /api/fiscal-periods/generate?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/fiscal-periods/generate/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/fiscal-periods/generate?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: 2031, config: { type: 'CALENDAR', startMonth: 1, closingAccountCode: '1111' } }),
      }),
    );
    log('A-spoof generate status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: POST /api/fiscal-periods/generate?companyId=B — owner generates 12 periods (200 + audit); duplicate 409', async () => {
    const { tenantB, ownerB } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { POST } = await import('@/app/api/fiscal-periods/generate/route');
    const payload = { year: 2031, config: { type: 'CALENDAR', startMonth: 1, closingAccountCode: '1111' } };

    const res = await POST(
      new NextRequest(`http://localhost/api/fiscal-periods/generate?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.periods).toBeDefined();
    expect(body.periods).toHaveLength(12);
    expect(body.periods[0].name).toContain('ENERO');
    expect(body.periods[0].startDate).toContain('2031');

    const periodsInDb = await db.fiscalPeriod.count({ where: { companyId: tenantB.id } });
    expect(periodsInDb).toBe(12);

    const audit = await db.auditLog.findFirst({
      where: { companyId: tenantB.id, action: 'PERIODS_GENERATED' },
    });
    expect(audit).toBeTruthy();

    const dup = await POST(
      new NextRequest(`http://localhost/api/fiscal-periods/generate?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    expect(dup.status).toBe(409);
  });

  it('A-id: POST /api/import?companyId=A — importing into victim bank of B fails 404 with no mutation', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const victimBank = await createTestBankAccount(tenantB.id, bankGl.id, 'Victim Bank B');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const csv = 'date,description,amount\n2025-06-15,CLIENT PAYMENT,500.00\n';
    const formData = new FormData();
    formData.append('file', new File([csv], 'statement.csv', { type: 'text/csv' }));
    formData.append('bankAccountId', victimBank.id);
    formData.append('bypassHolderValidation', 'true');

    const { POST } = await import('@/app/api/import/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/import?companyId=${tenantA.id}`, {
        method: 'POST',
        headers: {},
        body: formData,
      }),
    );
    log('A-id import status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('La cuenta bancaria especificada no existe');

    const statements = await db.bankStatement.count({ where: { bankAccountId: victimBank.id } });
    expect(statements).toBe(0);
  });

  it('A-spoof: POST /api/import?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Own Bank B');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const csv = 'date,description,amount\n2025-06-15,CLIENT PAYMENT,500.00\n';
    const formData = new FormData();
    formData.append('file', new File([csv], 'statement.csv', { type: 'text/csv' }));
    formData.append('bankAccountId', bank.id);
    formData.append('bypassHolderValidation', 'true');

    const { POST } = await import('@/app/api/import/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/import?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: {},
        body: formData,
      }),
    );
    log('A-spoof import status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: POST /api/import?companyId=B — owner imports own CSV (200 with statement and transaction)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Own Bank B');
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const csv = 'date,description,amount\n2025-06-15,CLIENT PAYMENT,500.00\n';
    const formData = new FormData();
    formData.append('file', new File([csv], 'statement.csv', { type: 'text/csv' }));
    formData.append('bankAccountId', bank.id);
    formData.append('bypassHolderValidation', 'true');

    const { POST } = await import('@/app/api/import/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/import?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: {},
        body: formData,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statementId).toBeTruthy();
    expect(body.transactionCount).toBe(1);

    const stored = await db.bankTransaction.findFirst({
      where: { statement: { bankAccountId: bank.id } },
    });
    expect(stored?.description).toBe('CLIENT PAYMENT');
  });

  it('A-id: POST /api/reconciliation/auto?companyId=A — auto-reconcile victim bank of B fails 404 with no mutation', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const { tx } = await seedRuleAndTxB(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const bankGl = await db.glAccount.findFirst({
      where: { companyId: tenantB.id, code: '1000' },
    });
    const bank = await db.bankAccount.findFirst({ where: { glAccountId: bankGl?.id } });

    const { POST } = await import('@/app/api/reconciliation/auto/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/reconciliation/auto?companyId=${tenantA.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankAccountId: bank?.id, createJournalEntries: false, matchByAmount: false }),
      }),
    );
    log('A-id auto status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Bank account not found');

    const stored = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(stored?.isReconciled).toBe(false);
    expect(stored?.glAccountId).toBeNull();
  });

  it('A-spoof: POST /api/reconciliation/auto?companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    const { bank } = await seedRuleAndTxB(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/reconciliation/auto/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/reconciliation/auto?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankAccountId: bank.id, createJournalEntries: false, matchByAmount: false }),
      }),
    );
    log('A-spoof auto status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: POST /api/reconciliation/auto?companyId=B — owner reconciles own transaction (200 matched=1 + real effect)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const { gl, rule, bank, tx } = await seedRuleAndTxB(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { POST } = await import('@/app/api/reconciliation/auto/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/reconciliation/auto?companyId=${tenantB.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankAccountId: bank.id, createJournalEntries: false, matchByAmount: false }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.matched).toBe(1);
    expect(body.matchedByRule).toBe(1);

    const stored = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(stored?.isReconciled).toBe(true);
    expect(stored?.glAccountId).toBe(gl.id);
    expect(stored?.matchedRuleId).toBe(rule.id);
  });

  it('A-id: PATCH /api/reconciliation/ignore — member of A cannot ignore transactions of B (404 neutral)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const { tx } = await seedRuleAndTxB(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { PATCH } = await import('@/app/api/reconciliation/ignore/route');
    const res = await PATCH(
      new NextRequest('http://localhost/api/reconciliation/ignore', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantA.id, transactionIds: [tx.id], ignore: true }),
      }),
    );
    log('A-id ignore status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('No valid transactions found for the given IDs');

    const stored = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(stored?.isIgnored).toBe(false);
  });

  it('A-spoof: PATCH /api/reconciliation/ignore body companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    const { tx } = await seedRuleAndTxB(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { PATCH } = await import('@/app/api/reconciliation/ignore/route');
    const res = await PATCH(
      new NextRequest('http://localhost/api/reconciliation/ignore', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, transactionIds: [tx.id], ignore: true }),
      }),
    );
    log('A-spoof ignore status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: PATCH /api/reconciliation/ignore — owner ignores own transaction (200 + real effect)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const { tx } = await seedRuleAndTxB(tenantB.id);
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { PATCH } = await import('@/app/api/reconciliation/ignore/route');
    const res = await PATCH(
      new NextRequest('http://localhost/api/reconciliation/ignore', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, transactionIds: [tx.id], ignore: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.updated).toBe(1);
    expect(body.ignore).toBe(true);

    const stored = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(stored?.isIgnored).toBe(true);
  });

  it('A-id: POST /api/reconciliation/unreconcile — member of A cannot unreconcile transactions of B (404 neutral)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const { bank, tx } = await seedRuleAndTxB(tenantB.id);
    await db.bankTransaction.update({ where: { id: tx.id }, data: { isReconciled: true } });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/reconciliation/unreconcile/route');
    const res = await POST(
      new NextRequest('http://localhost/api/reconciliation/unreconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantA.id, bankAccountId: bank.id, transactionIds: [tx.id] }),
      }),
    );
    log('A-id unreconcile status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Bank account not found');

    const stored = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(stored?.isReconciled).toBe(true);
  });

  it('A-spoof: POST /api/reconciliation/unreconcile body companyId=B — non-member blocked (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    const { bank, tx } = await seedRuleAndTxB(tenantB.id);
    await db.bankTransaction.update({ where: { id: tx.id }, data: { isReconciled: true } });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/reconciliation/unreconcile/route');
    const res = await POST(
      new NextRequest('http://localhost/api/reconciliation/unreconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, bankAccountId: bank.id, transactionIds: [tx.id] }),
      }),
    );
    log('A-spoof unreconcile status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: POST /api/reconciliation/unreconcile — owner unreconciles own transaction (200 + real effect)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const { bank, tx } = await seedRuleAndTxB(tenantB.id);
    await db.bankTransaction.update({ where: { id: tx.id }, data: { isReconciled: true } });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { POST } = await import('@/app/api/reconciliation/unreconcile/route');
    const res = await POST(
      new NextRequest('http://localhost/api/reconciliation/unreconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, bankAccountId: bank.id, transactionIds: [tx.id] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.unreconciled).toBe(1);

    const stored = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(stored?.isReconciled).toBe(false);
  });
});