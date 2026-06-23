import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { POST } from '@/app/api/reconciliation/review/route';
import { NextRequest } from 'next/server';
import { createSession } from '@/lib/sessions';
import {
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from './helpers/factories';

async function seedTestData() {
  const user = await db.user.create({
    data: {
      email: 'review@test.com',
      passwordHash: 'hash',
      firstName: 'Review',
      lastName: 'Tester',
      role: 'company_admin',
    },
  });

  const company = await createTestCompany('Review Co');
  await createTestCompanyMember(user.id, company.id);

  const session = await createSession(user.id);

  const cashGl = await db.glAccount.create({
    data: {
      companyId: company.id,
      code: '1010',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
      isActive: true,
    },
  });

  const suspenseGl = await db.glAccount.create({
    data: {
      companyId: company.id,
      code: '1050',
      name: 'Suspense Account',
      accountType: 'asset',
      normalBalance: 'debit',
      isActive: true,
      isSystem: true,
    },
  });

  const equityGl = await db.glAccount.create({
    data: {
      companyId: company.id,
      code: '3010',
      name: 'Owner Equity',
      accountType: 'equity',
      normalBalance: 'credit',
      isActive: true,
    },
  });

  // Create the bank account and statement first (FK dependency)
  const bankAccount = await db.bankAccount.create({
    data: {
      companyId: company.id,
      accountName: 'Test Bank',
      bankName: 'Test',
      glAccountId: cashGl.id,
      balance: 1000,
    },
  });

  const statement = await db.bankStatement.create({
    data: {
      companyId: company.id,
      bankAccountId: bankAccount.id,
      startDate: new Date('2025-03-01'),
      endDate: new Date('2025-03-31'),
      openingBalance: 1000,
      closingBalance: 900,
      format: 'pdf',
    },
  });

  const entry = await db.journalEntry.create({
    data: {
      companyId: company.id,
      date: new Date('2025-03-15'),
      description: 'Reconciliation: Compra de muebles',
      status: 'pending_review',
      lines: {
        create: [
          { glAccountId: cashGl.id, description: 'Reconciliation: Compra de muebles', debit: 100, credit: 0 },
          { glAccountId: equityGl.id, description: 'Reconciliation: Compra de muebles', debit: 0, credit: 100 },
        ],
      },
    },
  });

  const bankTx = await db.bankTransaction.create({
    data: {
      statementId: statement.id,
      date: new Date('2025-03-15'),
      description: 'Compra de muebles',
      amount: -100,
      isReconciled: true,
      status: 'pending_review',
      glAccountId: equityGl.id,
      reconciledAt: new Date(),
    },
  });

  return { user, company, session, bankTx, entry, suspenseGl, bankAccount };
}

describe('POST /api/reconciliation/review', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe aprobar una transacción pending_review → status posted', async () => {
    const { session, bankTx, company } = await seedTestData();

    const req = new NextRequest('http://localhost/api/reconciliation/review', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session}`,
        'Content-Type': 'application/json',
        'x-company-id': company.id,
      },
      body: JSON.stringify({
        transactionId: bankTx.id,
        action: 'approve',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.action).toBe('approved');

    const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
    expect(updatedTx?.status).toBe('posted');

    const entry = await db.journalEntry.findFirst({
      where: { description: 'Reconciliation: Compra de muebles', companyId: company.id },
    });
    expect(entry?.status).toBe('posted');
  });

  it('debe rechazar una transacción pending_review → status suspense y void entry', async () => {
    const { session, bankTx, company, suspenseGl } = await seedTestData();

    const req = new NextRequest('http://localhost/api/reconciliation/review', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session}`,
        'Content-Type': 'application/json',
        'x-company-id': company.id,
      },
      body: JSON.stringify({
        transactionId: bankTx.id,
        action: 'reject',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.action).toBe('rejected');

    const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
    expect(updatedTx?.status).toBe('suspense');
    expect(updatedTx?.isReconciled).toBe(false);
    expect(updatedTx?.glAccountId).toBe(suspenseGl.id);

    const entry = await db.journalEntry.findFirst({
      where: { description: 'Reconciliation: Compra de muebles', companyId: company.id },
    });
    expect(entry?.status).toBe('void');
  });

  it('debe retornar 400 si action es inválido', async () => {
    const { session, bankTx, company } = await seedTestData();

    const req = new NextRequest('http://localhost/api/reconciliation/review', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session}`,
        'Content-Type': 'application/json',
        'x-company-id': company.id,
      },
      body: JSON.stringify({
        transactionId: bankTx.id,
        action: 'invalid_action',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('debe retornar 404 si la transacción no está en pending_review', async () => {
    const { session, company } = await seedTestData();

    const req = new NextRequest('http://localhost/api/reconciliation/review', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session}`,
        'Content-Type': 'application/json',
        'x-company-id': company.id,
      },
      body: JSON.stringify({
        transactionId: 'non-existent-id',
        action: 'approve',
      }),
    });

    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(404);
  });
});
