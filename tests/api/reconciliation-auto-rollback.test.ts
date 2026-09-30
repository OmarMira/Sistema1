import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';
import { NextRequest } from 'next/server';
import { JournalEntryService } from '@/lib/services/journal-entry.service';

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

// Unique per test-run so importHash (@unique) never collides across runs.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// §8 TOCTOU harness: intercepts the shared pending-decision exclusion so the
// FIRST call (match-time load) can be made blind while every subsequent call
// (write-time revalidation) still sees the real pending decision — a
// deterministic reproduction of a decision landing between match and write.
const mockExcludeMode = vi.hoisted(() => ({ mode: 'real' as 'real' | 'blind-once', calls: 0 }));

vi.mock('@/lib/services/single-rule-apply.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/services/single-rule-apply.service')>();
  return {
    ...mod,
    excludePendingHumanDecisions: async (
      executor: Parameters<typeof mod.excludePendingHumanDecisions>[0],
    ) => {
      mockExcludeMode.calls += 1;
      if (mockExcludeMode.mode === 'blind-once') {
        mockExcludeMode.mode = 'real';
        return {};
      }
      return mod.excludePendingHumanDecisions(executor);
    },
  };
});

// clearDatabase() does not purge PendingApproval (known factories gap) — this
// ledger removes ONLY the rows this file created (targeted deleteMany).
const createdPendingApprovalIds: string[] = [];

describe('H4 — POST /api/reconciliation/auto', () => {
  beforeEach(async () => {
    mockCreateAuditLog.mockClear();
    mockExcludeMode.mode = 'real';
    mockExcludeMode.calls = 0;
    if (createdPendingApprovalIds.length > 0) {
      await db.pendingApproval.deleteMany({ where: { id: { in: createdPendingApprovalIds } } });
      createdPendingApprovalIds.length = 0;
    }
    await clearDatabase();
  });

  afterEach(async () => {
    if (createdPendingApprovalIds.length > 0) {
      await db.pendingApproval.deleteMany({ where: { id: { in: createdPendingApprovalIds } } });
      createdPendingApprovalIds.length = 0;
    }
    await clearDatabase();
  });

  async function seedData(companyId: string, glAccountId: string, bankAccountId: string) {
    const statement = await createTestBankStatement(companyId, bankAccountId);
    await createTestBankTransaction(companyId, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'CLIENT PAYMENT',
    });
    return statement;
  }

  // ── §8 pending human-decision guard fixtures ──────────────────────────

  const GUARD_GL_CODES = {
    match: { cash: '1091', target: '4091' },
    toctou: { cash: '1092', target: '4092' },
    positive: { cash: '1093', target: '4093' },
  } as const;

  async function createPendingClassificationApproval(payloadTransactionId: string, requestedBy: string) {
    const row = await db.pendingApproval.create({
      data: {
        action: 'ai_classification_proposal',
        payload: { transactionId: payloadTransactionId },
        requestedBy,
        status: 'pending',
      },
    });
    createdPendingApprovalIds.push(row.id);
    return row;
  }

  async function seedGuardScenario(companyId: string, tag: keyof typeof GUARD_GL_CODES) {
    const codes = GUARD_GL_CODES[tag];
    const cashGl = await createTestGlAccount({
      companyId,
      code: codes.cash,
      name: `Cash Guard ${tag}`,
      normalBalance: 'debit',
    });
    const targetGl = await createTestGlAccount({
      companyId,
      code: codes.target,
      name: `Target Guard ${tag}`,
      normalBalance: 'credit',
    });
    const bankAccount = await createTestBankAccount(companyId, cashGl.id);
    const statement = await createTestBankStatement(companyId, bankAccount.id);
    const bankTx = await createTestBankTransaction(companyId, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'CLIENT PAYMENT',
    });
    const importHash = `auto-guard-${tag}-${RUN}`;
    await db.bankTransaction.update({ where: { id: bankTx.id }, data: { importHash } });
    const rule = await db.bankRule.create({
      data: {
        companyId,
        name: 'Match Client Guard',
        conditionType: 'contains',
        conditionValue: 'CLIENT',
        transactionDirection: 'any',
        glAccountId: targetGl.id,
        priority: 10,
        isActive: true,
      },
    });
    return { cashGl, targetGl, bankAccount, statement, bankTx, importHash, rule };
  }

  async function postAutoReconcile(companyId: string, bankAccountId: string) {
    const { POST } = await import('../../src/app/api/reconciliation/auto/route');
    return POST(
      new NextRequest(
        `http://localhost/api/reconciliation/auto?companyId=${companyId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankAccountId,
            createJournalEntries: true,
            matchByAmount: false,
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );
  }

  it('reconcilia y crea audit log dentro de la transaccion', async () => {
    const user = await createTestUser('h4-happy@example.com');
    const company = await createTestCompany('H4 Happy');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', normalBalance: 'debit' });
    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Revenue', normalBalance: 'credit' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    await seedData(company.id, cashGl.id, bankAccount.id);

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Match Client',
        conditionType: 'contains',
        conditionValue: 'CLIENT',
        transactionDirection: 'any',
        glAccountId: revenueGl.id,
        priority: 10,
        isActive: true,
      },
    });

    const { POST } = await import('../../src/app/api/reconciliation/auto/route');

    const res = await POST(
      new NextRequest(
        `http://localhost/api/reconciliation/auto?companyId=${company.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankAccountId: bankAccount.id,
            createJournalEntries: true,
            matchByAmount: false,
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);

    const auditLogs = await db.auditLog.findMany({
      where: { companyId: company.id, action: 'auto_reconcile' },
    });
    expect(auditLogs).toHaveLength(1);

    const reconciledTxs = await db.bankTransaction.findMany({
      where: { statement: { bankAccountId: bankAccount.id }, isReconciled: true },
    });
    expect(reconciledTxs.length).toBeGreaterThan(0);
  });

  it('rollback: si createAuditLog falla las transacciones no se reconcilian', async () => {
    mockCreateAuditLog.mockRejectedValueOnce(new Error('Simulated audit log failure'));

    const user = await createTestUser('h4-rollback@example.com');
    const company = await createTestCompany('H4 Rollback');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1011', name: 'Cash2', normalBalance: 'debit' });
    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4011', name: 'Revenue2', normalBalance: 'credit' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    await seedData(company.id, cashGl.id, bankAccount.id);

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Match Client 2',
        conditionType: 'contains',
        conditionValue: 'CLIENT',
        transactionDirection: 'any',
        glAccountId: revenueGl.id,
        priority: 10,
        isActive: true,
      },
    });

    const { POST } = await import('../../src/app/api/reconciliation/auto/route');

    const res = await POST(
      new NextRequest(
        `http://localhost/api/reconciliation/auto?companyId=${company.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankAccountId: bankAccount.id,
            createJournalEntries: true,
            matchByAmount: false,
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(500);

    const reconciledTxs = await db.bankTransaction.findMany({
      where: { statement: { bankAccountId: bankAccount.id }, isReconciled: true },
    });
    expect(reconciledTxs).toHaveLength(0);

    const auditLogs = await db.auditLog.findMany({
      where: { companyId: company.id, action: 'auto_reconcile' },
    });
    expect(auditLogs).toHaveLength(0);

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
  });

  it('bloquea auto-reconciliacion en periodo fiscal cerrado', async () => {
    const user = await createTestUser('h4-fiscal@example.com');
    const company = await createTestCompany('H4 Fiscal');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: '2025-06',
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-06-30'),
        isLocked: true,
      },
    });

    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1012', name: 'Cash3', normalBalance: 'debit' });
    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4012', name: 'Revenue3', normalBalance: 'credit' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    await seedData(company.id, cashGl.id, bankAccount.id);

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Match Client 3',
        conditionType: 'contains',
        conditionValue: 'CLIENT',
        transactionDirection: 'any',
        glAccountId: revenueGl.id,
        priority: 10,
        isActive: true,
      },
    });

    const { POST } = await import('../../src/app/api/reconciliation/auto/route');

    const res = await POST(
      new NextRequest(
        `http://localhost/api/reconciliation/auto?companyId=${company.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankAccountId: bankAccount.id,
            createJournalEntries: true,
            matchByAmount: false,
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(403);
  });

  it('auto-reconcile con createJournalEntries=true: vincula journalEntryId en la tx y crea JE balanceado', async () => {
    const user = await createTestUser('h4-link@example.com');
    const company = await createTestCompany('H4 Link');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1013', name: 'Cash4', normalBalance: 'debit' });
    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4013', name: 'Revenue4', normalBalance: 'credit' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'CLIENT PAYMENT',
    });

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Match Client 4',
        conditionType: 'contains',
        conditionValue: 'CLIENT',
        transactionDirection: 'any',
        glAccountId: revenueGl.id,
        priority: 10,
        isActive: true,
      },
    });

    const { POST } = await import('../../src/app/api/reconciliation/auto/route');

    const res = await POST(
      new NextRequest(
        `http://localhost/api/reconciliation/auto?companyId=${company.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankAccountId: bankAccount.id,
            createJournalEntries: true,
            matchByAmount: false,
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);

    const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
    expect(updatedTx?.journalEntryId).toBeTruthy();

    const entry = await db.journalEntry.findUnique({
      where: { id: updatedTx?.journalEntryId! },
      include: { lines: true },
    });
    expect(entry).toBeTruthy();
    expect(entry?.lines).toHaveLength(2);
    const dr = entry!.lines.reduce((s, l) => s + Number(l.debit), 0);
    const cr = entry!.lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(Math.abs(dr - cr)).toBeLessThan(0.01);
  });

  it('auto-reconcile: NO duplica JE si la tx ya tiene uno (contrato 1:1)', async () => {
    const user = await createTestUser('h4-nodup@example.com');
    const company = await createTestCompany('H4 NoDup');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1014', name: 'Cash5', normalBalance: 'debit' });
    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4014', name: 'Revenue5', normalBalance: 'credit' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'CLIENT PAYMENT',
    });

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'Match Client 5',
        conditionType: 'contains',
        conditionValue: 'CLIENT',
        transactionDirection: 'any',
        glAccountId: revenueGl.id,
        priority: 10,
        isActive: true,
      },
    });

    // Simula apply-all previo: la tx ya tiene JE vinculado
    const existingEntryId = await JournalEntryService.createFromBankTransaction(db as any, {
      bankTxId: bankTx.id,
      bankTxDate: bankTx.date,
      bankTxAmount: Number(bankTx.amount),
      bankTxDescription: bankTx.description,
      bankGlAccountId: cashGl.id,
      counterpartyGlAccountId: revenueGl.id,
      companyId: company.id,
    });
    expect(existingEntryId).toBeTruthy();

    const jeCountBefore = await db.journalEntry.count({ where: { companyId: company.id } });

    const { POST } = await import('../../src/app/api/reconciliation/auto/route');

    const res = await POST(
      new NextRequest(
        `http://localhost/api/reconciliation/auto?companyId=${company.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankAccountId: bankAccount.id,
            createJournalEntries: true,
            matchByAmount: false,
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);

    const jeCountAfter = await db.journalEntry.count({ where: { companyId: company.id } });
    expect(jeCountAfter).toBe(jeCountBefore);

    const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
    expect(updatedTx?.journalEntryId).toBe(existingEntryId);
  });

  it('amount-match: vincula journalEntryId al JE existente y evita doble conteo', async () => {
    const user = await createTestUser('h4-amount-match@example.com');
    const company = await createTestCompany('H4 AmountMatch');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1015', name: 'Cash6', normalBalance: 'debit' });
    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4015', name: 'Revenue6', normalBalance: 'credit' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'MANUAL ENTRY MATCH',
    });

    // JE existente posteado que ya representa este movimiento (mismo monto y fecha)
    const je = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'Entrada manual',
        status: 'posted',
        lines: {
          create: [
            { glAccountId: cashGl.id, description: 'Entrada manual', debit: 500, credit: 0 },
            { glAccountId: revenueGl.id, description: 'Entrada manual', debit: 0, credit: 500 },
          ],
        },
      },
    });

    const { POST } = await import('../../src/app/api/reconciliation/auto/route');

    const res = await POST(
      new NextRequest(
        `http://localhost/api/reconciliation/auto?companyId=${company.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bankAccountId: bankAccount.id,
            createJournalEntries: false,
            matchByAmount: true,
          }),
        },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);

    const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
    expect(updatedTx?.journalEntryId).toBe(je.id);
  });

  // ── §8: pending human-decision guard (match-time + write-time) ────────

  it('§8 match-time: tx con PendingApproval pending no es candidata a auto-reconciliacion', async () => {
    const user = await createTestUser('h4-guard-match@example.com');
    const company = await createTestCompany('H4 Guard Match');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const s = await seedGuardScenario(company.id, 'match');
    const pending = await createPendingClassificationApproval(s.importHash, user.id);

    const res = await postAutoReconcile(company.id, s.bankAccount.id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(0);

    const row = await db.bankTransaction.findUnique({ where: { id: s.bankTx.id } });
    expect(row?.glAccountId).toBeNull();
    expect(row?.matchedRuleId).toBeNull();
    expect(row?.isReconciled).toBe(false);
    expect(row?.journalEntryId).toBeNull();

    const approval = await db.pendingApproval.findUnique({ where: { id: pending.id } });
    expect(approval?.status).toBe('pending');

    // No journal side effects for a pending-decision transaction.
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(0);
  });

  it('§8 write-time TOCTOU: candidato stale con PendingApproval posterior queda bloqueado', async () => {
    const user = await createTestUser('h4-guard-toctou@example.com');
    const company = await createTestCompany('H4 Guard TOCTOU');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const s = await seedGuardScenario(company.id, 'toctou');
    // The human decision lands BEFORE the request but AFTER the match-time
    // candidate list would be built: with the first exclusion made blind, the
    // row enters the match as a stale candidate and only the write-time
    // revalidation can stop it.
    const pending = await createPendingClassificationApproval(s.importHash, user.id);

    const { revalidateAutoMatchCandidate } = await import(
      '../../src/app/api/reconciliation/auto/route'
    );

    // Write-scope primitive: with the pending decision present, revalidation fails.
    expect(await revalidateAutoMatchCandidate(db, s.bankTx.id)).toBe(false);

    // Blind the FIRST exclusion only (match-time load); write-time revalidation
    // (every subsequent call) reads the real pending decision.
    mockExcludeMode.mode = 'blind-once';
    mockExcludeMode.calls = 0;

    const res = await postAutoReconcile(company.id, s.bankAccount.id);

    expect(res.status).toBe(200);
    // Both gates executed: match-time load + write-time revalidation.
    expect(mockExcludeMode.calls).toBeGreaterThanOrEqual(2);

    // Stale candidate: NO classification/reconciliation/journal write persisted.
    const row = await db.bankTransaction.findUnique({ where: { id: s.bankTx.id } });
    expect(row?.glAccountId).toBeNull();
    expect(row?.matchedRuleId).toBeNull();
    expect(row?.isReconciled).toBe(false);
    expect(row?.journalEntryId).toBeNull();

    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(0);

    const approval = await db.pendingApproval.findUnique({ where: { id: pending.id } });
    expect(approval?.status).toBe('pending');
  });

  it('§8 positive: sin pending human decision auto-reconcilia con glAccountId, matchedRuleId e isReconciled=true', async () => {
    const user = await createTestUser('h4-guard-positive@example.com');
    const company = await createTestCompany('H4 Guard Positive');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const s = await seedGuardScenario(company.id, 'positive');

    const res = await postAutoReconcile(company.id, s.bankAccount.id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe(1);

    const row = await db.bankTransaction.findUnique({ where: { id: s.bankTx.id } });
    expect(row?.glAccountId).toBe(s.targetGl.id);
    expect(row?.matchedRuleId).toBe(s.rule.id);
    expect(row?.isReconciled).toBe(true);
    expect(row?.journalEntryId).toBeTruthy();

    // Legitimate side effects preserved: balanced JE created and linked.
    const entry = await db.journalEntry.findUnique({
      where: { id: row!.journalEntryId! },
      include: { lines: true },
    });
    expect(entry).toBeTruthy();
    expect(entry?.lines).toHaveLength(2);
    const dr = entry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const cr = entry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(Math.abs(dr - cr)).toBeLessThan(0.01);

    // Scenario-scoped: no pending human decision governs THIS transaction
    // (global count is not asserted — clearDatabase() does not purge
    // PendingApproval, see known factories gap).
    expect(
      await db.pendingApproval.count({
        where: { payload: { path: ['transactionId'], equals: s.importHash } },
      }),
    ).toBe(0);
  });
});
