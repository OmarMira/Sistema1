import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import {
  clearDatabase,
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
} from '../helpers/factories';
import { GET as movementSummaryGET } from '@/app/api/movement-summary/route';

/**
 * S23a — GET /api/movement-summary aggregates in SQL (one GROUP BY over the
 * union of journal lines and virtual reconciled-bank-transaction lines) instead
 * of loading every line into JS.
 *
 * The expectations below are produced by a LOCAL REFERENCE MIRROR of the
 * previous JS aggregation (same fixture, same rules), so the SQL rewrite is
 * proven equivalent on mixed data instead of merely "not crashing".
 */

const cents = (value: number) => Math.round(value * 100);

interface Fixture {
  token: string;
  companyId: string;
  officeGlId: string;
  travelGlId: string;
  cashGlId: string;
  revenueGlId: string;
}

async function seed(): Promise<Fixture> {
  const user = await createTestUser('wave3-movement@example.com');
  const company = await createTestCompany('Wave3 Movement');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  const cash = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const office = await createTestGlAccount({
    companyId: company.id,
    code: '6010',
    name: 'Office',
    accountType: 'expense',
    normalBalance: 'debit',
  });
  const travel = await createTestGlAccount({
    companyId: company.id,
    code: '6020',
    name: 'Travel',
    accountType: 'expense',
    normalBalance: 'debit',
  });
  const revenue = await createTestGlAccount({
    companyId: company.id,
    code: '4010',
    name: 'Sales',
    accountType: 'revenue',
    normalBalance: 'credit',
  });

  const postEntry = async (date: string, description: string, lines: Array<{ glAccountId: string; debit: number; credit: number }>) =>
    db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date(date),
        description,
        status: 'posted',
        lines: { create: lines },
      },
    });

  // Mixed decimals on purpose: 0.10 + 0.20 must not drift.
  await postEntry('2025-02-10T00:00:00.000Z', 'Office supplies', [
    { glAccountId: office.id, debit: 0.1, credit: 0 },
    { glAccountId: cash.id, debit: 0, credit: 0.1 },
  ]);
  await postEntry('2025-02-11T00:00:00.000Z', 'Travel ticket', [
    { glAccountId: travel.id, debit: 0.2, credit: 0 },
    { glAccountId: cash.id, debit: 0, credit: 0.2 },
  ]);
  await postEntry('2025-02-12T00:00:00.000Z', 'Client payment', [
    { glAccountId: cash.id, debit: 1234.56, credit: 0 },
    { glAccountId: revenue.id, debit: 0, credit: 1234.56 },
  ]);
  // Draft entry must never be counted.
  await db.journalEntry.create({
    data: {
      companyId: company.id,
      date: new Date('2025-02-13T00:00:00.000Z'),
      description: 'Draft (ignored)',
      status: 'draft',
      lines: { create: [{ glAccountId: office.id, debit: 999, credit: 0 }] },
    },
  });

  const bank = await createTestBankAccount(company.id, cash.id, 'Operating');
  const statement = await createTestBankStatement(company.id, bank.id);

  // Virtual withdrawal (never became a journal entry): 30.25 out of the bank.
  await db.bankTransaction.create({
    data: {
      statementId: statement.id,
      companyId: company.id,
      date: new Date('2025-02-14T00:00:00.000Z'),
      description: 'Virtual travel',
      amount: -30.25,
      isReconciled: true,
      glAccountId: travel.id,
    },
  });
  // Virtual deposit.
  await db.bankTransaction.create({
    data: {
      statementId: statement.id,
      companyId: company.id,
      date: new Date('2025-02-15T00:00:00.000Z'),
      description: 'Virtual sale',
      amount: 12.5,
      isReconciled: true,
      glAccountId: revenue.id,
    },
  });

  return {
    token,
    companyId: company.id,
    officeGlId: office.id,
    travelGlId: travel.id,
    cashGlId: cash.id,
    revenueGlId: revenue.id,
  };
}

/**
 * Reference mirror of the pre-S23a JS aggregation: journal lines of posted
 * entries plus both virtual lines of every reconciled, unlinked bank
 * transaction. Cents-based on purpose (integer money).
 */
async function referenceTotals(
  fixture: Fixture,
  opts: { accountId?: string; fromDate?: string; toDate?: string } = {},
) {
  const { companyId } = fixture;
  const dateFilter = (date: Date) => {
    if (opts.fromDate && date < new Date(opts.fromDate + 'T00:00:00.000Z')) return false;
    if (opts.toDate && date > new Date(opts.toDate + 'T23:59:59.999Z')) return false;
    return true;
  };

  const entries = await db.journalEntry.findMany({
    where: { companyId, status: 'posted' },
    include: { lines: { include: { glAccount: true } } },
  });

  const byType = new Map<string, { debits: number; credits: number }>();
  let totalDebits = 0;
  let totalCredits = 0;
  let transactionCount = 0;

  const push = (accountType: string, debit: number, credit: number) => {
    totalDebits += debit;
    totalCredits += credit;
    const existing = byType.get(accountType) ?? { debits: 0, credits: 0 };
    existing.debits += debit;
    existing.credits += credit;
    byType.set(accountType, existing);
  };

  for (const entry of entries) {
    if (!dateFilter(entry.date)) continue;
    const lines = entry.lines.filter((l) => !opts.accountId || l.glAccountId === opts.accountId);
    if (lines.length > 0) transactionCount++;
    for (const line of lines) {
      push(line.glAccount.accountType, cents(Number(line.debit)), cents(Number(line.credit)));
    }
  }

  const txs = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccount: { companyId } },
      isReconciled: true,
      glAccountId: opts.accountId ? opts.accountId : { not: null },
      journalEntryId: null,
    },
    include: { glAccount: true, statement: { include: { bankAccount: { include: { glAccount: true } } } } },
  });

  for (const tx of txs) {
    if (!dateFilter(tx.date)) continue;
    transactionCount++;
    const isDeposit = Number(tx.amount) > 0;
    const absAmount = cents(Math.abs(Number(tx.amount)));
    push(tx.glAccount!.accountType, isDeposit ? 0 : absAmount, isDeposit ? absAmount : 0);
    // Same rule as the original JS pass: with an accountId filter, the
    // bank-asset line is only emitted when the bank account IS that account.
    const bankGl = tx.statement.bankAccount.glAccount;
    if (bankGl && (!opts.accountId || opts.accountId === bankGl.id)) {
      push(bankGl.accountType, isDeposit ? absAmount : 0, isDeposit ? 0 : absAmount);
    }
  }

  return {
    totalDebits: totalDebits / 100,
    totalCredits: totalCredits / 100,
    netMovement: (totalDebits - totalCredits) / 100,
    transactionCount,
    byType: Object.fromEntries(
      [...byType].map(([type, value]) => [
        type,
        { debits: value.debits / 100, credits: value.credits / 100, net: (value.debits - value.credits) / 100 },
      ]),
    ),
  };
}

function call(fixture: Fixture, query = '') {
  return movementSummaryGET(
    new NextRequest(`http://localhost/api/movement-summary?companyId=${fixture.companyId}${query}`, {
      headers: { Authorization: `Bearer ${fixture.token}` },
    }),
    { params: Promise.resolve({}) },
  );
}

describe('S23a — GET /api/movement-summary aggregates in SQL and matches the JS reference', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('returns the same totals, byType and shape as the JS aggregation', async () => {
    const fixture = await seed();
    const expected = await referenceTotals(fixture);

    const res = await call(fixture);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(['byAccount', 'byType', 'recentMovements', 'summary']);
    expect(body.summary).toEqual({
      totalDebits: expected.totalDebits,
      totalCredits: expected.totalCredits,
      netMovement: expected.netMovement,
      transactionCount: expected.transactionCount,
    });

    const byType = Object.fromEntries(
      body.byType.map((row: { type: string; debits: number; credits: number; net: number }) => [
        row.type,
        { debits: row.debits, credits: row.credits, net: row.net },
      ]),
    );
    expect(byType).toEqual(expected.byType);

    // Cents discipline: 0.10 + 0.20 is 0.30, not 0.30000000000000004.
    const expense = body.byType.find((row: { type: string }) => row.type === 'expense');
    expect(expense.debits).toBe(30.55);
    expect(body.summary.totalDebits).toBe(1277.61);
    expect(body.summary.totalCredits).toBe(1277.61);

    expect(body.byAccount.map((row: { accountCode: string }) => row.accountCode)).toEqual([
      '1010',
      '4010',
      '6010',
      '6020',
    ]);
    expect(body.recentMovements.length).toBeGreaterThan(0);
    expect(body.recentMovements.length).toBeLessThanOrEqual(50);
  });

  it('applies the accountId filter in SQL (assigned and bank-asset lines stay consistent)', async () => {
    const fixture = await seed();
    const expected = await referenceTotals(fixture, { accountId: fixture.travelGlId });

    const body = await (await call(fixture, `&accountId=${fixture.travelGlId}`)).json();

    expect(body.summary).toEqual({
      totalDebits: expected.totalDebits,
      totalCredits: expected.totalCredits,
      netMovement: expected.netMovement,
      transactionCount: expected.transactionCount,
    });
    expect(body.byAccount.map((row: { accountCode: string }) => row.accountCode)).toEqual(['6020']);
    expect(body.byAccount[0]).toEqual({
      accountId: fixture.travelGlId,
      accountCode: '6020',
      accountName: 'Travel',
      accountType: 'expense',
      debits: 30.45,
      credits: 0,
      net: 30.45,
    });
  });

  it('applies the date range filter in SQL', async () => {
    const fixture = await seed();
    const expected = await referenceTotals(fixture, { fromDate: '2025-02-12', toDate: '2025-02-12' });

    const body = await (await call(fixture, '&fromDate=2025-02-12&toDate=2025-02-12')).json();

    expect(body.summary).toEqual({
      totalDebits: expected.totalDebits,
      totalCredits: expected.totalCredits,
      netMovement: expected.netMovement,
      transactionCount: expected.transactionCount,
    });
    expect(body.summary.transactionCount).toBe(1);
    expect(body.summary.totalDebits).toBe(1234.56);
  });
});
