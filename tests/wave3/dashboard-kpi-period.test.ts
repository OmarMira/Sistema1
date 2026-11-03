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
} from '../helpers/factories';
import { GET as dashboardGET } from '@/app/api/dashboard/financial/route';

/**
 * S23d — KPI honesty.
 *
 * The panel (and `monthlyTrend`) describe ONE fiscal year, but the KPI totals
 * used to be aggregated with no date bound at all: revenue/expenses were
 * cumulative while the trend next to them was fiscal-year. The contract now is:
 *   - assets / liabilities / equity = position through the fiscal year end;
 *   - revenue / expenses            = that fiscal year (YTD), same as the trend;
 *   - the accounting-equation check keeps using the cumulative P&L slice, so it
 *     still balances.
 */

interface Seed {
  token: string;
  companyId: string;
}

async function seed(): Promise<Seed> {
  const user = await createTestUser('wave3-kpi@example.com');
  const company = await createTestCompany('Wave3 KPI');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  const cash = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const equity = await createTestGlAccount({
    companyId: company.id,
    code: '3010',
    name: 'Owner Equity',
    accountType: 'equity',
    normalBalance: 'credit',
  });
  const revenue = await createTestGlAccount({
    companyId: company.id,
    code: '4010',
    name: 'Sales',
    accountType: 'revenue',
    normalBalance: 'credit',
  });
  const expense = await createTestGlAccount({
    companyId: company.id,
    code: '6010',
    name: 'Office',
    accountType: 'expense',
    normalBalance: 'debit',
  });

  const post = async (
    date: string,
    description: string,
    lines: Array<{ glAccountId: string; debit: number; credit: number }>,
  ) =>
    db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date(date),
        description,
        status: 'posted',
        lines: { create: lines },
      },
    });

  // ── prior fiscal year (2024) ──
  await post('2024-01-02T00:00:00.000Z', 'Opening capital 2024', [
    { glAccountId: cash.id, debit: 5000, credit: 0 },
    { glAccountId: equity.id, debit: 0, credit: 5000 },
  ]);
  await post('2024-06-15T00:00:00.000Z', 'Revenue 2024', [
    { glAccountId: cash.id, debit: 1000, credit: 0 },
    { glAccountId: revenue.id, debit: 0, credit: 1000 },
  ]);
  await post('2024-07-15T00:00:00.000Z', 'Expense 2024', [
    { glAccountId: expense.id, debit: 400, credit: 0 },
    { glAccountId: cash.id, debit: 0, credit: 400 },
  ]);

  // ── current fiscal year (2025) ──
  await post('2025-01-05T00:00:00.000Z', 'Capital 2025', [
    { glAccountId: cash.id, debit: 100, credit: 0 },
    { glAccountId: equity.id, debit: 0, credit: 100 },
  ]);
  await post('2025-03-10T00:00:00.000Z', 'Revenue 2025', [
    { glAccountId: cash.id, debit: 200, credit: 0 },
    { glAccountId: revenue.id, debit: 0, credit: 200 },
  ]);
  await post('2025-03-20T00:00:00.000Z', 'Expense 2025', [
    { glAccountId: expense.id, debit: 50, credit: 0 },
    { glAccountId: cash.id, debit: 0, credit: 50 },
  ]);

  return { token, companyId: company.id };
}

describe('S23d — /api/dashboard/financial KPI date bound', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('bounds revenue/expenses to the fiscal year and keeps balance-sheet KPIs cumulative', async () => {
    const ctx = await seed();

    const res = await dashboardGET(
      new NextRequest(`http://localhost/api/dashboard/financial?companyId=${ctx.companyId}`, {
        headers: { Authorization: `Bearer ${ctx.token}` },
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.fiscalYear).toBe(2025);
    expect(body.kpiPeriod.year).toBe(2025);
    expect(body.kpiPeriod.start).toBe('2025-01-01T00:00:00.000Z');
    expect(body.kpiPeriod.end).toBe('2025-12-31T23:59:59.999Z');

    // P&L: fiscal year to date only (2024 revenue/expenses are NOT included).
    expect(body.kpi.revenue).toBe(200);
    expect(body.kpi.expenses).toBe(50);

    // Balance sheet: position through the fiscal year end (cumulative).
    expect(body.kpi.assets).toBe(5850);
    expect(body.kpi.liabilities).toBe(0);
    // equity 5100 + cumulative result (1200 - 450)
    expect(body.kpi.equity).toBe(5850);
    expect(body.kpi.accountingEquationCheck).toBe('PASS');

    // The trend next to the KPIs covers exactly the same fiscal year.
    expect(body.monthlyTrend).toEqual([{ month: '2025-03', revenue: 200, expenses: 50 }]);
  });
});
