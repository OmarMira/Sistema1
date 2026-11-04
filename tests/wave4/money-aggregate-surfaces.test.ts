import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { toCents } from '@/lib/money';
import { GET as accountsGET } from '@/app/api/accounts/route';
import { GET as reconciliationReportGET } from '@/app/api/reconciliation/report/route';
import {
  clearDatabase,
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
} from '../helpers/factories';

/**
 * S3 — aggregate/groupBy bypass sites are normalized through the money module.
 *
 * These surfaces emit JSON numbers, so float drift is directly observable in
 * the response (unlike a Decimal(18,2) write, where Postgres masks it).
 */

type AccountRow = {
  id: string;
  code: string;
  directBalance: number;
  balance: number;
  _count: { children: number; journalLines: number };
};

async function seedCompany(email: string, name: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(name);
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  return { user, company, token };
}

async function postEntry(
  companyId: string,
  date: string,
  lines: { glAccountId: string; debit: number; credit: number }[],
) {
  return db.journalEntry.create({
    data: {
      companyId,
      date: new Date(`${date}T00:00:00.000Z`),
      description: 'fixture',
      status: 'posted',
      lines: { create: lines },
    },
  });
}

async function listAccounts(companyId: string, token: string): Promise<AccountRow[]> {
  const res = await accountsGET(
    new NextRequest(`http://localhost/api/accounts?companyId=${companyId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { accounts: AccountRow[] };
  return body.accounts;
}

describe('S3 — GET /api/accounts aggregates in cents', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('reports directBalance without float residual drift (0.10 + 0.20)', async () => {
    const { company, token } = await seedCompany('w4-accounts-direct@example.com', 'W4 Accounts Direct');
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const income = await createTestGlAccount({
      companyId: company.id,
      code: '4100',
      name: 'Income',
      accountType: 'revenue',
      normalBalance: 'credit',
    });

    await postEntry(company.id, '2025-03-01', [
      { glAccountId: cash.id, debit: 0.1, credit: 0 },
      { glAccountId: income.id, debit: 0, credit: 0.1 },
    ]);
    await postEntry(company.id, '2025-03-02', [
      { glAccountId: cash.id, debit: 0.2, credit: 0 },
      { glAccountId: income.id, debit: 0, credit: 0.2 },
    ]);

    const accounts = await listAccounts(company.id, token);
    const cashRow = accounts.find((a) => a.id === cash.id)!;
    const incomeRow = accounts.find((a) => a.id === income.id)!;

    expect(toCents(cashRow.directBalance)).toBe(30);
    expect(cashRow.directBalance).toBe(0.3);
    expect(toCents(cashRow.balance)).toBe(30);
    expect(toCents(incomeRow.balance)).toBe(30);
  });

  it('accumulates child balances up the hierarchy exactly', async () => {
    const { company, token } = await seedCompany('w4-accounts-tree@example.com', 'W4 Accounts Tree');
    const parent = await createTestGlAccount({
      companyId: company.id,
      code: '1000',
      name: 'Assets',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const childA = await db.glAccount.create({
      data: {
        companyId: company.id,
        code: '1010',
        name: 'Cash A',
        accountType: 'asset',
        normalBalance: 'debit',
        parentId: parent.id,
        isActive: true,
      },
    });
    const childB = await db.glAccount.create({
      data: {
        companyId: company.id,
        code: '1020',
        name: 'Cash B',
        accountType: 'asset',
        normalBalance: 'debit',
        parentId: parent.id,
        isActive: true,
      },
    });
    const income = await createTestGlAccount({
      companyId: company.id,
      code: '4100',
      name: 'Income',
      accountType: 'revenue',
      normalBalance: 'credit',
    });

    await postEntry(company.id, '2025-03-01', [
      { glAccountId: childA.id, debit: 0.1, credit: 0 },
      { glAccountId: income.id, debit: 0, credit: 0.1 },
    ]);
    await postEntry(company.id, '2025-03-02', [
      { glAccountId: childB.id, debit: 0.2, credit: 0 },
      { glAccountId: income.id, debit: 0, credit: 0.2 },
    ]);

    const accounts = await listAccounts(company.id, token);
    const parentRow = accounts.find((a) => a.id === parent.id)!;
    const childARow = accounts.find((a) => a.id === childA.id)!;
    const childBRow = accounts.find((a) => a.id === childB.id)!;

    expect(parentRow.directBalance).toBe(0);
    expect(toCents(childARow.balance)).toBe(10);
    expect(toCents(childBRow.balance)).toBe(20);
    expect(parentRow.balance).toBe(0.3);
  });

  it('PRESERVE: a pre-existing hierarchy cycle does not recurse forever', async () => {
    const { company, token } = await seedCompany('w4-accounts-cycle@example.com', 'W4 Accounts Cycle');
    const a = await createTestGlAccount({
      companyId: company.id,
      code: '1000',
      name: 'Cycle A',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const b = await db.glAccount.create({
      data: {
        companyId: company.id,
        code: '1010',
        name: 'Cycle B',
        accountType: 'asset',
        normalBalance: 'debit',
        parentId: a.id,
        isActive: true,
      },
    });
    await db.glAccount.update({ where: { id: a.id }, data: { parentId: b.id } });

    const creator = await createTestGlAccount({
      companyId: company.id,
      code: '4100',
      name: 'Income',
      accountType: 'revenue',
      normalBalance: 'credit',
    });
    await postEntry(company.id, '2025-03-01', [
      { glAccountId: b.id, debit: 5, credit: 0 },
      { glAccountId: creator.id, debit: 0, credit: 5 },
    ]);

    const accounts = await listAccounts(company.id, token);
    expect(accounts).toHaveLength(3);
    for (const row of accounts) {
      expect(Number.isFinite(row.balance)).toBe(true);
    }
  });
});

describe('S3 — GET /api/reconciliation/report computes in cents', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('marks a one-cent difference as unbalanced instead of a float residual', async () => {
    const { company, token } = await seedCompany('w4-recon-report@example.com', 'W4 Recon Report');
    const bankGl = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Bank',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const income = await createTestGlAccount({
      companyId: company.id,
      code: '4100',
      name: 'Income',
      accountType: 'revenue',
      normalBalance: 'credit',
    });
    const bank = await createTestBankAccount(company.id, bankGl.id);
    const statement = await createTestBankStatement(company.id, bank.id);

    // Per books: 0.1 + 0.2 = 0.30 (a float sum yields 0.30000000000000004).
    await postEntry(company.id, '2025-03-01', [
      { glAccountId: bankGl.id, debit: 0.1, credit: 0 },
      { glAccountId: income.id, debit: 0, credit: 0.1 },
    ]);
    await postEntry(company.id, '2025-03-02', [
      { glAccountId: bankGl.id, debit: 0.2, credit: 0 },
      { glAccountId: income.id, debit: 0, credit: 0.2 },
    ]);

    // Per statement: 0.31 → the difference is exactly one cent.
    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-05',
      amount: 0.31,
      description: 'Deposit',
    });
    await db.bankTransaction.update({ where: { id: tx.id }, data: { isReconciled: true } });

    const res = await reconciliationReportGET(
      new NextRequest(
        `http://localhost/api/reconciliation/report?bankAccountId=${bank.id}&companyId=${company.id}`,
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      ),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        balancePerBooks: number;
        balancePerStatement: number;
        difference: number;
        isBalanced: boolean;
      };
    };

    expect(toCents(body.report.balancePerBooks)).toBe(30);
    expect(toCents(body.report.balancePerStatement)).toBe(31);
    expect(toCents(body.report.difference)).toBe(1);
    expect(body.report.isBalanced).toBe(false);
  });

  it('PRESERVE: a fully matched statement stays balanced', async () => {
    const { company, token } = await seedCompany('w4-recon-balanced@example.com', 'W4 Recon Balanced');
    const bankGl = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Bank',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const income = await createTestGlAccount({
      companyId: company.id,
      code: '4100',
      name: 'Income',
      accountType: 'revenue',
      normalBalance: 'credit',
    });
    const bank = await createTestBankAccount(company.id, bankGl.id);
    const statement = await createTestBankStatement(company.id, bank.id);

    await postEntry(company.id, '2025-03-01', [
      { glAccountId: bankGl.id, debit: 0.1, credit: 0 },
      { glAccountId: income.id, debit: 0, credit: 0.1 },
    ]);
    await postEntry(company.id, '2025-03-02', [
      { glAccountId: bankGl.id, debit: 0.2, credit: 0 },
      { glAccountId: income.id, debit: 0, credit: 0.2 },
    ]);

    const tx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-05',
      amount: 0.3,
      description: 'Deposit',
    });
    await db.bankTransaction.update({ where: { id: tx.id }, data: { isReconciled: true } });

    const res = await reconciliationReportGET(
      new NextRequest(
        `http://localhost/api/reconciliation/report?bankAccountId=${bank.id}&companyId=${company.id}`,
        { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      ),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { balancePerBooks: number; balancePerStatement: number; difference: number; isBalanced: boolean };
    };

    expect(body.report.balancePerBooks).toBe(0.3);
    expect(body.report.balancePerStatement).toBe(0.3);
    expect(toCents(body.report.difference)).toBe(0);
    expect(body.report.isBalanced).toBe(true);
  });
});

/** Sanity: the Decimal reference used above agrees with the cents conversion. */
describe('S3 — cents conversion agrees with the Decimal reference', () => {
  it('toCents(Decimal("0.30")) === 30', () => {
    expect(toCents(new Prisma.Decimal('0.30'))).toBe(30);
  });
});
