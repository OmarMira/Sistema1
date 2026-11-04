import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { executeYearClose } from '@/lib/services/closing-engine';
import { toCents, fromCents, sumCents } from '@/lib/money';
import {
  clearDatabase,
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
} from '../helpers/factories';

/**
 * S3 — ledger-critical arithmetic is cents-exact.
 *
 * Every converted site is compared against a `Prisma.Decimal` (Decimal.js)
 * reference: the assertions never re-do the arithmetic they are checking in
 * JS floats, so a `number`-typed balance that drifted from the exact cent
 * value fails.
 *
 * Production posting path: the entry is created and sealed into the per-company
 * journal hash chain inside one transaction (`appendEntryToJournalChain`), the
 * same primitive every posting path uses.
 */

async function seedCompany(email: string, name: string) {
  const user = await createTestUser(email);
  const company = await createTestCompany(name);
  await createTestCompanyMember(user.id, company.id);
  return { user, company };
}

type LineFixture = { glAccountId: string; debit: number; credit: number };

/** Post an entry through the production path (entry + chain append, one tx). */
async function post(companyId: string, date: string, lines: LineFixture[], description = 'fixture') {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const entry = await tx.journalEntry.create({
      data: {
        companyId,
        date: new Date(`${date}T00:00:00.000Z`),
        description,
        status: 'posted',
        lines: { create: lines },
      },
    });
    await appendEntryToJournalChain(tx as never, { companyId, entryId: entry.id });
    return entry;
  });
}

/** Exact Decimal reference for balance = sign*(Σdebit − Σcredit) over posted lines. */
async function decimalBalanceReference(
  glAccountId: string,
  companyId: string,
  normalBalance: string,
): Promise<Prisma.Decimal> {
  const lines = await db.journalLine.findMany({
    where: { glAccountId, entry: { status: 'posted', companyId } },
    select: { debit: true, credit: true },
  });
  let debit = new Prisma.Decimal(0);
  let credit = new Prisma.Decimal(0);
  for (const line of lines) {
    debit = debit.plus(new Prisma.Decimal(String(line.debit)));
    credit = credit.plus(new Prisma.Decimal(String(line.credit)));
  }
  return normalBalance === 'debit' ? debit.minus(credit) : credit.minus(debit);
}

async function recalc(glAccountId: string) {
  await db.$transaction(async (tx) => {
    await JournalEntryService.recalculateBalance(tx, glAccountId);
  });
}

function storedBalance(value: unknown): Prisma.Decimal {
  const raw = (value as { balance: unknown }).balance;
  return new Prisma.Decimal(String(raw ?? 0));
}

describe('S3 — JournalEntryService.recalculateBalance is cents-exact', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('sums 0.10-style rows without float residual drift (posted path)', async () => {
    const { company } = await seedCompany('w4-recalc-tenths@example.com', 'W4 Recalc Tenths');
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

    // 300 postings of 0.10/0.30: a 1000-row-class float sum drifts here.
    for (let i = 0; i < 300; i++) {
      const amount = i % 3 === 0 ? 0.3 : 0.1;
      await post(company.id, '2025-03-10', [
        { glAccountId: cash.id, debit: amount, credit: 0 },
        { glAccountId: income.id, debit: 0, credit: amount },
      ]);
    }

    await recalc(cash.id);
    await recalc(income.id);

    const cashRow = await db.glAccount.findUniqueOrThrow({ where: { id: cash.id } });
    const incomeRow = await db.glAccount.findUniqueOrThrow({ where: { id: income.id } });
    const cashRef = await decimalBalanceReference(cash.id, company.id, 'debit');
    const incomeRef = await decimalBalanceReference(income.id, company.id, 'credit');

    expect(toCents(storedBalance(cashRow))).toBe(toCents(cashRef));
    expect(toCents(storedBalance(incomeRow))).toBe(toCents(incomeRef));
    // 100 × 0.30 + 200 × 0.10 = 50.00
    expect(toCents(storedBalance(cashRow))).toBe(5000);
  });

  it('handles mixed signs (debit and credit on the same account) exactly', async () => {
    const { company } = await seedCompany('w4-recalc-mixed@example.com', 'W4 Recalc Mixed');
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const offset = await createTestGlAccount({
      companyId: company.id,
      code: '2100',
      name: 'Offset',
      accountType: 'liability',
      normalBalance: 'credit',
    });

    await post(company.id, '2025-04-01', [
      { glAccountId: cash.id, debit: 0.3, credit: 0 },
      { glAccountId: offset.id, debit: 0, credit: 0.3 },
    ]);
    await post(company.id, '2025-04-02', [
      { glAccountId: cash.id, debit: 0, credit: 0.2 },
      { glAccountId: offset.id, debit: 0.2, credit: 0 },
    ]);
    await post(company.id, '2025-04-03', [
      { glAccountId: cash.id, debit: 0.1, credit: 0 },
      { glAccountId: offset.id, debit: 0, credit: 0.1 },
    ]);

    await recalc(cash.id);

    const cashRow = await db.glAccount.findUniqueOrThrow({ where: { id: cash.id } });
    const cashRef = await decimalBalanceReference(cash.id, company.id, 'debit');
    // 0.3 - 0.2 + 0.1 must be exactly 0.20, not 0.20000000000000004.
    expect(toCents(storedBalance(cashRow))).toBe(20);
    expect(toCents(storedBalance(cashRow))).toBe(toCents(cashRef));
  });

  it('stays exact at large-but-valid magnitudes where a double loses a cent', async () => {
    const { company } = await seedCompany('w4-recalc-large@example.com', 'W4 Recalc Large');
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const offset = await createTestGlAccount({
      companyId: company.id,
      code: '2100',
      name: 'Offset',
      accountType: 'liability',
      normalBalance: 'credit',
    });

    // 45_000_000_000_000.01 − 0.02 = 44_999_999_999_999.99 — both operands fit
    // Decimal(18,2) and the safe cent range, but the double rounding of the
    // aggregates shifts the result by a cent on the float path.
    await post(company.id, '2025-05-01', [
      { glAccountId: cash.id, debit: 45_000_000_000_000.01, credit: 0 },
      { glAccountId: offset.id, debit: 0, credit: 45_000_000_000_000.01 },
    ]);
    await post(company.id, '2025-05-02', [
      { glAccountId: cash.id, debit: 0, credit: 0.02 },
      { glAccountId: offset.id, debit: 0.02, credit: 0 },
    ]);

    await recalc(cash.id);

    const cashRow = await db.glAccount.findUniqueOrThrow({ where: { id: cash.id } });
    const cashRef = await decimalBalanceReference(cash.id, company.id, 'debit');
    expect(toCents(cashRef)).toBe(4_499_999_999_999_999);
    expect(toCents(storedBalance(cashRow))).toBe(toCents(cashRef));
  });

  it('PRESERVE: ignores lines of an entry belonging to another company (P15)', async () => {
    const { company } = await seedCompany('w4-recalc-p15@example.com', 'W4 Recalc P15');
    const foreign = await createTestCompany('W4 Recalc Foreign');
    const cash = await createTestGlAccount({
      companyId: company.id,
      code: '1100',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    });
    const foreignOffset = await createTestGlAccount({
      companyId: foreign.id,
      code: '4100',
      name: 'Foreign Income',
      accountType: 'revenue',
      normalBalance: 'credit',
    });

    await post(company.id, '2025-06-01', [
      { glAccountId: cash.id, debit: 10, credit: 0 },
      { glAccountId: foreignOffset.id, debit: 0, credit: 10 },
    ]);
    await post(company.id, '2025-06-02', [
      { glAccountId: cash.id, debit: 0, credit: 3 },
      { glAccountId: foreignOffset.id, debit: 3, credit: 0 },
    ]);

    await recalc(cash.id);

    const cashRow = await db.glAccount.findUniqueOrThrow({ where: { id: cash.id } });
    // Only the same-company lines (10 and 3) count: 10 − 3 = 7.00.
    expect(toCents(storedBalance(cashRow))).toBe(700);
  });
});

describe('S3 — closing engine entry math is cents-exact', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('closes 0.10-style revenue/expense balances into an exactly balanced entry', async () => {
    const { company } = await seedCompany('w4-close-exact@example.com', 'W4 Close Exact');
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
    const retained = await createTestGlAccount({
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

    // Adversarial revenue/expense rows: sums that drift on the float path.
    for (const amount of [0.1, 0.2, 0.3, 0.7]) {
      await post(company.id, '2025-06-15', [
        { glAccountId: cash.id, debit: amount, credit: 0 },
        { glAccountId: revenue.id, debit: 0, credit: amount },
      ]);
    }
    for (const amount of [0.1, 0.2]) {
      await post(company.id, '2025-06-16', [
        { glAccountId: expense.id, debit: amount, credit: 0 },
        { glAccountId: cash.id, debit: 0, credit: amount },
      ]);
    }

    const result = await executeYearClose(company.id, 2025, {
      type: 'CALENDAR',
      startMonth: 1,
      closingAccountCode: '3090',
      periodsPerYear: 12,
      allowShortPeriods: false,
    });
    expect(result.success).toBe(true);

    const entry = await db.journalEntry.findUniqueOrThrow({
      where: { id: result.entryId },
      include: { lines: true },
    });

    const byAccount = new Map(
      entry.lines.map((l) => [l.glAccountId, { debit: toCents(l.debit), credit: toCents(l.credit) }]),
    );

    // Revenue closed: 1.30 debit; expense closed: 0.30 credit; retained: 1.00 credit.
    expect(byAccount.get(revenue.id)).toEqual({ debit: 130, credit: 0 });
    expect(byAccount.get(expense.id)).toEqual({ debit: 0, credit: 30 });
    expect(byAccount.get(retained.id)).toEqual({ debit: 0, credit: 100 });

    const debitTotal = sumCents(...entry.lines.map((l) => toCents(l.debit)));
    const creditTotal = sumCents(...entry.lines.map((l) => toCents(l.credit)));
    expect(debitTotal).toBe(creditTotal);
    expect(debitTotal).toBe(130);

    // The closing entry refreshed the touched balances exactly.
    const retainedRow = await db.glAccount.findUniqueOrThrow({ where: { id: retained.id } });
    expect(toCents(storedBalance(retainedRow))).toBe(toCents(fromCents(100)));
  });
});
