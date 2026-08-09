import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET } from '../../src/app/api/reports/reconciliation/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('P10 — GET /api/reports/reconciliation (aislamiento de tenant)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  async function seedBankWithTransaction(companyId: string) {
    const gl = await createTestGlAccount({ companyId, code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit' });
    const bank = await createTestBankAccount(companyId, gl.id, 'Bank X');
    const statement = await db.bankStatement.create({
      data: {
        companyId,
        bankAccountId: bank.id,
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-01-31T23:59:59Z'),
        openingBalance: 0,
        closingBalance: 100,
        totalCredits: 100,
        totalDebits: 0,
        format: 'csv',
        fileName: 'jan.csv',
      },
    });
    await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2026-01-10T00:00:00Z'),
        description: 'Client payment SECRET-B',
        amount: 100,
        isReconciled: true,
        glAccountId: gl.id,
      },
    });
    return { bank, gl };
  }

  it('rechaza leer una cuenta bancaria de otra empresa (404, sin datos de B)', async () => {
    const userA = await createTestUser('p10-a@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const companyB = await createTestCompany('Company B');
    const { bank: bankB } = await seedBankWithTransaction(companyB.id);

    const res = await GET(
      new NextRequest(
        `http://localhost/api/reports/reconciliation?companyId=${companyA.id}&bankAccountId=${bankB.id}`,
        { headers: { Authorization: `Bearer ${tokenA}` } },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(404);

    const body = await res.json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('SECRET-B');
  });

  it('devuelve datos únicamente de la cuenta de la propia empresa (200)', async () => {
    const userA = await createTestUser('p10-b@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);
    const tokenA = await createSession(userA.id);

    const { bank: bankA } = await seedBankWithTransaction(companyA.id);

    const res = await GET(
      new NextRequest(
        `http://localhost/api/reports/reconciliation?companyId=${companyA.id}&bankAccountId=${bankA.id}`,
        { headers: { Authorization: `Bearer ${tokenA}` } },
      ),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bankAccount.id).toBe(bankA.id);
    expect(body.summary.totalTransactions).toBe(1);
    expect(body.reconciledTransactions[0]!.description).toBe('Client payment SECRET-B');
  });
});