import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';
import { NextRequest } from 'next/server';

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

describe('H3 — POST /api/bank-rules/[id] (action=apply)', () => {
  beforeEach(async () => {
    mockCreateAuditLog.mockClear();
    await clearDatabase();
  });

  afterEach(async () => {
    if (createdPendingApprovalIds.length > 0) {
      await db.pendingApproval.deleteMany({
        where: { id: { in: createdPendingApprovalIds } },
      });
      createdPendingApprovalIds.length = 0;
    }
    await clearDatabase();
  });

  const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdPendingApprovalIds: string[] = [];

  // PendingApproval has no company FK, so clearDatabase() cannot reach it —
  // these tests only ever delete the approval rows THEY created (§6).
  async function createPendingAiProposal(companyId: string, importHash: string) {
    const row = await db.pendingApproval.create({
      data: {
        companyId,
        action: 'ai_classification_proposal',
        payload: { transactionId: importHash },
        requestedBy: 'single-rule-guard-test',
        // status defaults to 'pending'
      },
    });
    createdPendingApprovalIds.push(row.id);
    return row;
  }

  async function createRule(companyId: string, glAccountId: string) {
    return db.bankRule.create({
      data: {
        companyId,
        name: 'Test Rule',
        conditionType: 'contains',
        conditionValue: 'TEST',
        transactionDirection: 'any',
        glAccountId,
        priority: 10,
        isActive: true,
      },
    });
  }

  it('aplica regla exitosamente: clasifica transacciones y crea audit log', async () => {
    const user = await createTestUser('h3-happy@example.com');
    const company = await createTestCompany('H3 Happy');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const gl = await createTestGlAccount({ companyId: company.id, code: '6000', name: 'Expense' });
    const bankAccount = await createTestBankAccount(company.id, gl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'TEST EXPENSE',
    });
    await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-16',
      amount: 200,
      description: 'TEST EXPENSE 2',
    });

    const rule = await createRule(company.id, gl.id);
    const { POST } = await import('../../src/app/api/bank-rules/[id]/route');

    const res = await POST(
      new NextRequest(`http://localhost/api/bank-rules/${rule.id}?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.matched).toBe(2);

    const classifiedTxns = await db.bankTransaction.findMany({
      where: { matchedRuleId: rule.id },
    });
    expect(classifiedTxns).toHaveLength(2);
    for (const tx of classifiedTxns) {
      expect(tx.glAccountId).toBe(gl.id);
    }

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'BankRule', entityId: rule.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('RULE_APPLIED');
  });

  it('rollback: si createAuditLogWithRetry falla las transacciones no se clasifican', async () => {
    mockCreateAuditLog.mockRejectedValueOnce(new Error('Simulated audit log failure'));

    const user = await createTestUser('h3-rollback@example.com');
    const company = await createTestCompany('H3 Rollback');
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const gl = await createTestGlAccount({ companyId: company.id, code: '6001', name: 'Expense' });
    const bankAccount = await createTestBankAccount(company.id, gl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'TEST EXPENSE',
    });

    const rule = await createRule(company.id, gl.id);
    const { POST } = await import('../../src/app/api/bank-rules/[id]/route');

    const res = await POST(
      new NextRequest(`http://localhost/api/bank-rules/${rule.id}?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );

    expect(res.status).toBe(500);

    const reloadedTx = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(reloadedTx?.glAccountId).toBeNull();
    expect(reloadedTx?.matchedRuleId).toBeNull();

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'BankRule', entityId: rule.id },
    });
    expect(auditLogs).toHaveLength(0);

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
  });

  it('bloquea apply en periodo fiscal cerrado', async () => {
    const user = await createTestUser('h3-fiscal@example.com');
    const company = await createTestCompany('H3 Fiscal');
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

    const gl = await createTestGlAccount({ companyId: company.id, code: '6002', name: 'Expense' });
    const bankAccount = await createTestBankAccount(company.id, gl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'TEST EXPENSE',
    });

    const rule = await createRule(company.id, gl.id);
    const { POST } = await import('../../src/app/api/bank-rules/[id]/route');

    const res = await POST(
      new NextRequest(`http://localhost/api/bank-rules/${rule.id}?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );

    expect(res.status).toBe(403);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'BankRule', entityId: rule.id },
    });
    expect(auditLogs).toHaveLength(0);
  });

  it('§6 match-time: excluye del single-rule apply la transacción con PendingApproval pending', async () => {
    const user = await createTestUser(`h3-guard-match-${RUN}@example.com`);
    const company = await createTestCompany(`H3 Guard Match ${RUN}`);
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const gl = await createTestGlAccount({ companyId: company.id, code: '6010', name: 'Expense' });
    const bankAccount = await createTestBankAccount(company.id, gl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'TEST EXPENSE PENDING',
    });
    const importHash = `single-rule-guard-match-${RUN}`;
    await db.bankTransaction.update({ where: { id: tx.id }, data: { importHash } });
    await createPendingAiProposal(company.id, importHash);

    const rule = await createRule(company.id, gl.id);
    const { POST } = await import('../../src/app/api/bank-rules/[id]/route');

    const res = await POST(
      new NextRequest(`http://localhost/api/bank-rules/${rule.id}?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.matched).toBe(0);

    const reloadedTx = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(reloadedTx?.glAccountId).toBeNull();
    expect(reloadedTx?.matchedRuleId).toBeNull();
    expect(reloadedTx?.ruleApplyRecordId).toBeNull();

    const approval = await db.pendingApproval.findUniqueOrThrow({
      where: { id: createdPendingApprovalIds[0]! },
    });
    expect(approval.status).toBe('pending');
  });

  it('§6 TOCTOU: el write-time guard bloquea IDs stale cuando la PendingApproval aparece después del matching', async () => {
    const user = await createTestUser(`h3-guard-toctou-${RUN}@example.com`);
    const company = await createTestCompany(`H3 Guard TOCTOU ${RUN}`);
    await createTestCompanyMember(user.id, company.id);

    const gl = await createTestGlAccount({ companyId: company.id, code: '6011', name: 'Expense' });
    const bankAccount = await createTestBankAccount(company.id, gl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'TEST EXPENSE TOCTOU',
    });
    const importHash = `single-rule-guard-toctou-${RUN}`;
    await db.bankTransaction.update({ where: { id: tx.id }, data: { importHash } });

    const rule = await createRule(company.id, gl.id);

    // 1: candidate set obtained while NO pending decision exists (stale IDs).
    const staleIds = [tx.id];

    // 2: PendingApproval appears BEFORE executeSingleRuleClassificationApply.
    await createPendingAiProposal(company.id, importHash);

    const { executeSingleRuleClassificationApply } = await import(
      '@/lib/services/single-rule-apply.service'
    );
    const result = await db.$transaction((txClient) =>
      executeSingleRuleClassificationApply(txClient, {
        companyId: company.id,
        userId: user.id,
        rule: {
          id: rule.id,
          name: rule.name,
          glAccountId: rule.glAccountId,
          debitGlAccountId: rule.debitGlAccountId,
          creditGlAccountId: rule.creditGlAccountId,
        },
        debitIds: [],
        creditIds: staleIds,
      }),
    );

    expect(result.actualMatched).toBe(0);
    expect(result.acquiredIds).toEqual([]);
    expect(result.applyRecordId).toBeUndefined();

    const reloadedTx = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(reloadedTx?.glAccountId).toBeNull();
    expect(reloadedTx?.matchedRuleId).toBeNull();
    expect(reloadedTx?.ruleApplyRecordId).toBeNull();

    const approval = await db.pendingApproval.findUniqueOrThrow({
      where: { id: createdPendingApprovalIds[0]! },
    });
    expect(approval.status).toBe('pending');
  });

  it('§6 positivo: sin PendingApproval pending el single-rule apply sigue clasificando (matched=1)', async () => {
    const user = await createTestUser(`h3-guard-positive-${RUN}@example.com`);
    const company = await createTestCompany(`H3 Guard Positive ${RUN}`);
    await createTestCompanyMember(user.id, company.id);
    mockGetSessionUserId.mockResolvedValue(user.id);

    const gl = await createTestGlAccount({ companyId: company.id, code: '6012', name: 'Expense' });
    const bankAccount = await createTestBankAccount(company.id, gl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-06-15',
      amount: 100,
      description: 'TEST EXPENSE POSITIVE',
    });
    // Same shape as the blocked case: importHash set, but NO pending decision.
    const importHash = `single-rule-guard-positive-${RUN}`;
    await db.bankTransaction.update({ where: { id: tx.id }, data: { importHash } });

    const rule = await createRule(company.id, gl.id);
    const { POST } = await import('../../src/app/api/bank-rules/[id]/route');

    const res = await POST(
      new NextRequest(`http://localhost/api/bank-rules/${rule.id}?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.matched).toBe(1);

    const reloadedTx = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(reloadedTx?.glAccountId).toBe(gl.id);
    expect(reloadedTx?.matchedRuleId).toBe(rule.id);
    expect(reloadedTx?.ruleApplyRecordId).toBeTruthy();
  });
});
