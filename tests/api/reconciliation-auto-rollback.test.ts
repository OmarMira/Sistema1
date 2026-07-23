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

describe('H4 — POST /api/reconciliation/auto', () => {
  beforeEach(async () => {
    mockCreateAuditLog.mockClear();
    await clearDatabase();
  });

  afterEach(async () => {
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
});
