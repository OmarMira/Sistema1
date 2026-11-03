import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { GET as transactionsGET } from '@/app/api/reports/transactions/route';

/**
 * S23a — GET /api/reports/transactions must paginate in SQL and push the GL
 * filter into the query, while keeping the response contract the client already
 * consumes: { data, pagination: { page, limit, totalCount, totalPages } }.
 *
 * The report merges journal entries with "virtual" entries built from
 * reconciled bank transactions that never became a journal entry, so the page
 * must be cut from the union of both sources (not from each one separately).
 */

interface Seed {
  token: string;
  companyId: string;
  expenseGlId: string;
  otherExpenseGlId: string;
  cashGlId: string;
}

async function seed(): Promise<Seed> {
  const user = await createTestUser('wave3-reports-paging@example.com');
  const company = await createTestCompany('Wave3 Reports Paging');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  const cash = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const expense = await createTestGlAccount({
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

  const postEntry = async (date: string, description: string, glAccountId: string, amount: number) =>
    db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date(date),
        description,
        status: 'posted',
        lines: {
          create: [
            { glAccountId, description, debit: amount, credit: 0 },
            { glAccountId: cash.id, description, debit: 0, credit: amount },
          ],
        },
      },
    });

  await postEntry('2025-01-05T00:00:00.000Z', 'Entry 05', expense.id, 10);
  await postEntry('2025-01-06T00:00:00.000Z', 'Entry 06', travel.id, 20);
  await postEntry('2025-01-07T00:00:00.000Z', 'Entry 07', travel.id, 30);
  await postEntry('2025-01-08T00:00:00.000Z', 'Entry 08', expense.id, 40);
  await postEntry('2025-01-09T00:00:00.000Z', 'Entry 09', expense.id, 50);

  // Virtual entry: reconciled bank transaction with a GL account and no linked
  // journal entry — it must take part in the same paginated stream (oldest row).
  const bank = await createTestBankAccount(company.id, cash.id, 'Operating');
  const statement = await createTestBankStatement(company.id, bank.id);
  await db.bankTransaction.create({
    data: {
      statementId: statement.id,
      companyId: company.id,
      date: new Date('2025-01-03T00:00:00.000Z'),
      description: 'Virtual travel',
      amount: -60,
      isReconciled: true,
      glAccountId: travel.id,
    },
  });

  return {
    token,
    companyId: company.id,
    expenseGlId: expense.id,
    otherExpenseGlId: travel.id,
    cashGlId: cash.id,
  };
}

function request(ctx: Seed, query: string) {
  return transactionsGET(
    new NextRequest(
      `http://localhost/api/reports/transactions?companyId=${ctx.companyId}${query}`,
      { headers: { Authorization: `Bearer ${ctx.token}` } },
    ),
    { params: Promise.resolve({}) },
  );
}

describe('S23a — GET /api/reports/transactions: SQL pagination over both sources', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('returns the same response shape with SQL-side page windows', async () => {
    const ctx = await seed();

    const res = await request(ctx, '&page=1&limit=3');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(['data', 'pagination']);
    expect(body.pagination).toEqual({ page: 1, limit: 3, totalCount: 6, totalPages: 2 });
    expect(body.data).toHaveLength(3);
    expect(body.data.map((e: { description: string }) => e.description)).toEqual([
      'Entry 09',
      'Entry 08',
      'Entry 07',
    ]);
    // Every row keeps the documented per-entry totals.
    expect(body.data[0]._totalDebit).toBe(50);
    expect(body.data[0]._totalCredit).toBe(50);
  });

  it('cuts the page from the union of journal + virtual entries (no overlap, no gap)', async () => {
    const ctx = await seed();

    const first = await (await request(ctx, '&page=1&limit=3')).json();
    const second = await (await request(ctx, '&page=2&limit=3')).json();

    expect(second.pagination).toEqual({ page: 2, limit: 3, totalCount: 6, totalPages: 2 });
    expect(second.data.map((e: { description: string }) => e.description)).toEqual([
      'Entry 06',
      'Entry 05',
      'Virtual travel',
    ]);

    const ids = [...first.data, ...second.data].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('pushes the glAccountId filter into the query (journal AND virtual lines)', async () => {
    const ctx = await seed();

    const res = await request(ctx, `&glAccountId=${ctx.otherExpenseGlId}&page=1&limit=25`);
    const body = await res.json();

    expect(body.pagination.totalCount).toBe(3);
    expect(body.data.map((e: { description: string }) => e.description)).toEqual([
      'Entry 07',
      'Entry 06',
      'Virtual travel',
    ]);
  });

  it('selects virtual entries by their assigned account (previous filter semantics)', async () => {
    const ctx = await seed();

    // Filtering by the bank asset account returns the journal entries that post
    // to it; the virtual entry is assigned to Travel, exactly as before.
    const body = await (await request(ctx, `&glAccountId=${ctx.cashGlId}&page=1&limit=25`)).json();

    expect(body.pagination.totalCount).toBe(5);
    expect(body.data.map((e: { description: string }) => e.description)).toEqual([
      'Entry 09',
      'Entry 08',
      'Entry 07',
      'Entry 06',
      'Entry 05',
    ]);
    // The returned rows still carry their full line set.
    expect(body.data[0].lines).toHaveLength(2);
  });

  it('issues bounded SQL (LIMIT/OFFSET + COUNT) instead of loading the ledger', async () => {
    const ctx = await seed();
    const rawSpy = vi.spyOn(db, '$queryRaw');

    // Rendered SQL of every raw call made by the route, nested Prisma.sql
    // fragments included (tagged-template and pre-built Sql call shapes).
    const renderedCalls = () =>
      rawSpy.mock.calls.map((call) => {
        const rendered = JSON.stringify(call).replace(/\\"/g, '"');
        return rendered;
      });

    try {
      const res = await request(ctx, '&page=2&limit=2');
      expect(res.status).toBe(200);

      const rendered = renderedCalls();
      expect(rendered.some((text) => /LIMIT/i.test(text) && /OFFSET/i.test(text))).toBe(true);
      expect(rendered.some((text) => /COUNT\(\*\)/i.test(text))).toBe(true);

      // The GL filter is a predicate in the query, not a JS post-filter.
      rawSpy.mockClear();
      await request(ctx, `&glAccountId=${ctx.cashGlId}`);
      const filtered = renderedCalls().join(' ');
      expect(filtered).toMatch(/glAccountId" = /i);
      expect(filtered).toContain(ctx.cashGlId);
    } finally {
      rawSpy.mockRestore();
    }
  });
});
