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
import { GET } from '@/app/api/reports/transactions/route';

/**
 * GET /api/reports/transactions — dedup by journalEntryId.
 *
 * DB-fixture suite: the report aggregates in SQL over a UNION of journal entries
 * and "virtual" entries built from reconciled bank transactions, so the mock
 * Prisma client this file used to hand-roll no longer exists. The two rules
 * below are unchanged and still pinned here:
 *   1. a reconciled transaction already represented by a journal entry is never
 *      duplicated as a virtual entry;
 *   2. a reconciled transaction with no journal entry IS reported as a virtual
 *      entry with its two lines (assigned account + bank asset account).
 */

const EXPENSE = { code: '6000', name: 'Expense', accountType: 'expense', normalBalance: 'debit' } as const;
const BANK_ASSET = { code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit' } as const;

interface Fixture {
  token: string;
  companyId: string;
  expenseGlId: string;
  bankAssetGlId: string;
  statementId: string;
}

async function seedFixture(email: string): Promise<Fixture> {
  const user = await createTestUser(email);
  const company = await createTestCompany('Reports Dedup');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  const bankAsset = await createTestGlAccount({ companyId: company.id, ...BANK_ASSET });
  const expense = await createTestGlAccount({ companyId: company.id, ...EXPENSE });

  const bank = await createTestBankAccount(company.id, bankAsset.id, 'Operating');
  const statement = await createTestBankStatement(company.id, bank.id);

  return {
    token,
    companyId: company.id,
    expenseGlId: expense.id,
    bankAssetGlId: bankAsset.id,
    statementId: statement.id,
  };
}

function call(ctx: Fixture) {
  return GET(
    new NextRequest(`http://localhost/api/reports/transactions?companyId=${ctx.companyId}`, {
      headers: { Authorization: `Bearer ${ctx.token}` },
    }),
    { params: Promise.resolve({}) },
  );
}

describe('GET /api/reports/transactions — dedup by journalEntryId', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('does not add a reconciled tx WITH journalEntryId as a virtual entry', async () => {
    const ctx = await seedFixture('reports-dedup-linked@example.com');

    const entry = await db.journalEntry.create({
      data: {
        companyId: ctx.companyId,
        date: new Date('2025-03-15T00:00:00.000Z'),
        description: 'Auto-reconcile: Compra (Rule: X)',
        status: 'posted',
        lines: {
          create: [
            { glAccountId: ctx.expenseGlId, description: 'Auto-reconcile: Compra (Rule: X)', debit: 100, credit: 0 },
            { glAccountId: ctx.bankAssetGlId, description: 'Auto-reconcile: Compra (Rule: X)', debit: 0, credit: 100 },
          ],
        },
      },
    });

    await db.bankTransaction.create({
      data: {
        statementId: ctx.statementId,
        companyId: ctx.companyId,
        date: new Date('2025-03-15T00:00:00.000Z'),
        amount: -100,
        description: 'Compra',
        isReconciled: true,
        glAccountId: ctx.expenseGlId,
        journalEntryId: entry.id,
      },
    });

    const res = await call(ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(entry.id);
    expect(body.pagination.totalCount).toBe(1);
  });

  it('adds a reconciled tx WITHOUT journalEntryId as a virtual entry', async () => {
    const ctx = await seedFixture('reports-dedup-virtual@example.com');

    const tx = await db.bankTransaction.create({
      data: {
        statementId: ctx.statementId,
        companyId: ctx.companyId,
        date: new Date('2025-03-16T00:00:00.000Z'),
        amount: -30,
        description: 'Cafe',
        isReconciled: true,
        glAccountId: ctx.expenseGlId,
      },
    });

    const res = await call(ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(tx.id);
    expect(body.data[0].lines).toHaveLength(2);
    expect(body.pagination.totalCount).toBe(1);
  });
});
