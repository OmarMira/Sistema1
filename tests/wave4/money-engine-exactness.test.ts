import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '@/lib/db';
import { toCents } from '@/lib/money';
import { getVarianceReport } from '@/lib/budget/engine';
import { generateInsights } from '@/lib/assistant/insight-engine';
import { matchTransactions } from '@/lib/services/apply-all-engine';
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
 * S3 — the groupBy/aggregate bypass sites normalize their Decimal results
 * through src/lib/money.ts before doing any arithmetic, so the JSON numbers
 * they expose are exact cent values instead of float residuals.
 */

async function seedCompany(email: string, name: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(name);
  await createTestCompanyMember(user.id, company.id);
  return { user, company };
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

describe('S3 — budget variance engine computes in cents', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('reports the actual balance of a credit-normal account exactly (0.30 − 0.20)', async () => {
    const { company } = await seedCompany('w4-budget-credit@example.com', 'W4 Budget Credit');
    const revenue = await createTestGlAccount({
      companyId: company.id,
      code: '4100',
      name: 'Revenue',
      accountType: 'revenue',
      normalBalance: 'credit',
    });
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });

    await postEntry(company.id, '2025-03-10', [
      { glAccountId: cash.id, debit: 0.3, credit: 0 },
      { glAccountId: revenue.id, debit: 0, credit: 0.3 },
    ]);
    await postEntry(company.id, '2025-03-11', [
      { glAccountId: revenue.id, debit: 0.2, credit: 0 },
      { glAccountId: cash.id, debit: 0, credit: 0.2 },
    ]);

    const report = await getVarianceReport(company.id, 2025, 3);
    const revenueRow = report.find((r) => r.accountCode === '4100')!;

    expect(toCents(revenueRow.actual)).toBe(10);
    expect(revenueRow.actual).toBe(0.1);
    expect(toCents(revenueRow.variance)).toBe(10);
  });

  it('sums a 1000-line month without drift', async () => {
    const { company } = await seedCompany('w4-budget-1000@example.com', 'W4 Budget 1000');
    const expense = await createTestGlAccount({
      companyId: company.id,
      code: '6010',
      name: 'Office',
      accountType: 'expense',
      normalBalance: 'debit',
    });
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });

    const debitLines = Array.from({ length: 500 }, () => ({
      glAccountId: expense.id,
      debit: 0.1,
      credit: 0,
    }));
    const creditLines = Array.from({ length: 500 }, () => ({
      glAccountId: cash.id,
      debit: 0,
      credit: 0.1,
    }));
    await postEntry(company.id, '2025-03-10', [...debitLines, ...creditLines]);

    const report = await getVarianceReport(company.id, 2025, 3);
    const expenseRow = report.find((r) => r.accountCode === '6010')!;

    // 500 × 0.10 = 50.00 exactly.
    expect(toCents(expenseRow.actual)).toBe(5000);
    expect(expenseRow.actual).toBe(50);
  });

  it('PRESERVE: an account with no postings and no budget is not reported', async () => {
    const { company } = await seedCompany('w4-budget-empty@example.com', 'W4 Budget Empty');
    const expense = await createTestGlAccount({
      companyId: company.id,
      code: '6010',
      name: 'Office',
      accountType: 'expense',
      normalBalance: 'debit',
    });

    const report = await getVarianceReport(company.id, 2025, 3);
    expect(report.find((r) => r.accountCode === expense.code)).toBeUndefined();
    expect(report).toEqual([]);
  });
});

describe('S3 — insight engine money arithmetic is exact', () => {
  let scratchDir: string;
  let previousBudgetsPath: string | undefined;

  beforeEach(async () => {
    await clearDatabase();
    scratchDir = await mkdtemp(join(tmpdir(), 'w4-insights-'));
    previousBudgetsPath = process.env.BUDGETS_FILE_PATH;
  });

  afterEach(async () => {
    if (previousBudgetsPath === undefined) delete process.env.BUDGETS_FILE_PATH;
    else process.env.BUDGETS_FILE_PATH = previousBudgetsPath;
    await rm(scratchDir, { recursive: true, force: true });
    await clearDatabase();
  });

  it('reports the budget variance actual exactly (0.20 − 0.30)', async () => {
    const { company } = await seedCompany('w4-insight-budget@example.com', 'W4 Insight Budget');
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const day = String(Math.min(now.getUTCDate(), 28)).padStart(2, '0');

    const expense = await createTestGlAccount({
      companyId: company.id,
      code: '6010',
      name: 'Office',
      accountType: 'expense',
      normalBalance: 'debit',
    });
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });

    await postEntry(company.id, `${year}-${String(month).padStart(2, '0')}-${day}`, [
      { glAccountId: expense.id, debit: 0.2, credit: 0 },
      { glAccountId: cash.id, debit: 0, credit: 0.2 },
    ]);
    await postEntry(company.id, `${year}-${String(month).padStart(2, '0')}-${day}`, [
      { glAccountId: expense.id, debit: 0, credit: 0.3 },
      { glAccountId: cash.id, debit: 0.3, credit: 0 },
    ]);

    const budgetsPath = join(scratchDir, 'budgets.json');
    await writeFile(
      budgetsPath,
      JSON.stringify({
        companies: { [company.id]: { [year]: { [month]: { '6010': 100 } } } },
      }),
      'utf-8',
    );
    process.env.BUDGETS_FILE_PATH = budgetsPath;

    const insights = await generateInsights(company.id);
    const alert = insights.find((i) => i.id === 'budget_6010');

    expect(alert).toBeDefined();
    const context = alert!.context as { actual: number; budget: number };
    expect(toCents(context.actual)).toBe(-10);
    expect(context.actual).toBe(-0.1);
  });
});

describe('S3 — apply-all matching total is cents-exact', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('accumulates the matched batch total without float drift', async () => {
    const { company } = await seedCompany('w4-apply-all@example.com', 'W4 Apply All');
    const expense = await createTestGlAccount({
      companyId: company.id,
      code: '6001',
      name: 'Expense',
      accountType: 'expense',
      normalBalance: 'debit',
    });
    const bankGl = await createTestGlAccount({
      companyId: company.id,
      code: '1001',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const bankAccount = await createTestBankAccount(company.id, bankGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    for (const amount of [0.1, 0.2]) {
      await createTestBankTransaction(company.id, statement.id, {
        date: '2025-06-15',
        amount,
        description: 'W4 TOTALS expense',
      });
    }

    await db.bankRule.create({
      data: {
        companyId: company.id,
        name: 'W4 TOTALS rule',
        conditionType: 'contains',
        conditionValue: 'W4 TOTALS',
        transactionDirection: 'any',
        glAccountId: expense.id,
        priority: 10,
        isActive: true,
      },
    });

    const matchResult = await matchTransactions(company.id);

    expect(matchResult.totalCount).toBe(2);
    expect(toCents(matchResult.totalAmount)).toBe(30);
    expect(matchResult.totalAmount).toBe(0.3);
  });

  it('PRESERVE: a company without rules matches nothing', async () => {
    const { company } = await seedCompany('w4-apply-all-empty@example.com', 'W4 Apply All Empty');
    const matchResult = await matchTransactions(company.id);
    expect(matchResult.totalCount).toBe(0);
    expect(matchResult.totalAmount).toBe(0);
    expect(matchResult.matchedRules).toEqual([]);
  });
});
