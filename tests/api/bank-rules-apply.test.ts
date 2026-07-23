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
    await clearDatabase();
  });

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
});
