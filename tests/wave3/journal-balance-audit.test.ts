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
} from '../helpers/factories';
import { PUT as journalPUT } from '@/app/api/journal/[id]/route';
import { POST as adjustmentPOST } from '@/app/api/reconciliation/adjustment/route';
import { executeYearClose } from '@/lib/services/closing-engine';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import type { Prisma } from '@prisma/client';

/**
 * S23h — bookkeeping side effects that were missing:
 *  - editing a DRAFT entry writes a JOURNAL_DRAFT_UPDATED audit row;
 *  - the closing entry and reconciliation adjustments (both POSTED at creation)
 *    refresh GlAccount.balance, like every other posting path.
 */

async function seedCompany(email: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany('Wave3 Journal');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  return { user, company, token };
}

describe('S23h — draft edit audit trail', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('records JOURNAL_DRAFT_UPDATED with the entry id inside the same transaction', async () => {
    const { user, company, token } = await seedCompany('wave3-draft@example.com');
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

    const draft = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-05-10T00:00:00.000Z'),
        description: 'Original description',
        status: 'draft',
        lines: {
          create: [
            { glAccountId: office.id, debit: 15, credit: 0 },
            { glAccountId: cash.id, debit: 0, credit: 15 },
          ],
        },
      },
    });

    const res = await journalPUT(
      new NextRequest(`http://localhost/api/journal/${draft.id}?companyId=${company.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Edited description' }),
      }),
      { params: Promise.resolve({ id: draft.id }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBe('Edited description');

    const audit = await db.auditLog.findFirst({
      where: { companyId: company.id, action: 'JOURNAL_DRAFT_UPDATED', entityId: draft.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(user.id);
    expect(audit!.entity).toBe('JournalEntry');
    expect(JSON.parse(audit!.details ?? '{}')).toEqual({ changedFields: ['description'] });
  });
});

describe('S23h — closing entry refreshes GlAccount.balance', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('recalculates every account the closing entry touches', async () => {
    const { company } = await seedCompany('wave3-close@example.com');
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
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
    await createTestGlAccount({
      companyId: company.id,
      code: '3090',
      name: 'Retained Earnings',
      accountType: 'equity',
      normalBalance: 'credit',
    });

    for (let month = 1; month <= 12; month++) {
      const mm = String(month).padStart(2, '0');
      await db.fiscalPeriod.create({
        data: {
          companyId: company.id,
          name: `P${month}`,
          startDate: new Date(`2025-${mm}-01T00:00:00.000Z`),
          endDate: new Date(`2025-${mm}-28T00:00:00.000Z`),
          isLocked: true,
        },
      });
    }

    // Posted fixtures are seeded exactly as production writes them: entry +
    // chain append inside one transaction (an unsealed posted entry is refused).
    const post = (description: string, lines: Array<{ glAccountId: string; debit: number; credit: number }>) =>
      db.$transaction(async (tx: Prisma.TransactionClient) => {
        const entry = await tx.journalEntry.create({
          data: {
            companyId: company.id,
            date: new Date('2025-06-15T00:00:00.000Z'),
            description,
            status: 'posted',
            lines: { create: lines },
          },
        });
        await appendEntryToJournalChain(tx as never, { companyId: company.id, entryId: entry.id });
        return entry;
      });

    await post('Revenue', [
      { glAccountId: cash.id, debit: 10000, credit: 0 },
      { glAccountId: revenue.id, debit: 0, credit: 10000 },
    ]);
    await post('Expense', [
      { glAccountId: expense.id, debit: 6000, credit: 0 },
      { glAccountId: cash.id, debit: 0, credit: 6000 },
    ]);

    // Balances start stale: the postings above were written outside the service.
    expect(Number((await db.glAccount.findUniqueOrThrow({ where: { id: revenue.id } })).balance)).toBe(0);

    const result = await executeYearClose(company.id, 2025, {
      type: 'CALENDAR',
      startMonth: 1,
      closingAccountCode: '3090',
      periodsPerYear: 12,
      allowShortPeriods: false,
    });
    expect(result.success).toBe(true);

    const retained = await db.glAccount.findFirstOrThrow({
      where: { companyId: company.id, code: '3090' },
    });
    const revenueAfter = await db.glAccount.findUniqueOrThrow({ where: { id: revenue.id } });
    const expenseAfter = await db.glAccount.findUniqueOrThrow({ where: { id: expense.id } });

    // The closing entry moved the 4000 result into Retained Earnings. Without
    // recalculateBalance these balances would still be 0 (stale).
    expect(Number(retained.balance)).toBe(4000);
    expect(Number(revenueAfter.balance)).toBe(0);
    expect(Number(expenseAfter.balance)).toBe(0);
  });
});

describe('S23h — reconciliation adjustment refreshes GlAccount.balance', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('updates both affected account balances transactionally', async () => {
    const { company, token } = await seedCompany('wave3-adjust@example.com');
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
    const bank = await createTestBankAccount(company.id, cash.id, 'Operating');

    const res = await adjustmentPOST(
      new NextRequest(`http://localhost/api/reconciliation/adjustment?companyId=${company.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: company.id,
          bankAccountId: bank.id,
          date: '2025-06-01',
          description: 'Bank fee adjustment',
          debitAccountId: office.id,
          creditAccountId: cash.id,
          amount: 25.5,
        }),
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);

    const officeAfter = await db.glAccount.findUniqueOrThrow({ where: { id: office.id } });
    const cashAfter = await db.glAccount.findUniqueOrThrow({ where: { id: cash.id } });

    expect(Number(officeAfter.balance)).toBe(25.5);
    expect(Number(cashAfter.balance)).toBe(-25.5);
  });
});
