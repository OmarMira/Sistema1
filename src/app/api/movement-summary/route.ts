import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { AppError } from '@/lib/api-error';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { requireCompanyContext } from '@/lib/context-storage';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { Prisma } from '@prisma/client';
import { readJsonConfig } from '@/lib/config-loader';

/**
 * S23a — the movement summary used to load EVERY posted journal line (and every
 * reconciled bank transaction) into memory and aggregate in JS. The
 * aggregation now runs in PostgreSQL: one GROUP BY over a UNION of
 *   (a) posted journal lines,
 *   (b) the GL-account line of a reconciled bank transaction that never became
 *       a journal entry, and
 *   (c) that transaction's bank-asset line,
 * plus a count query and a bounded "recent movements" query. The response shape
 * is unchanged.
 *
 * Money is summed in the database and re-normalized to integer cents in JS
 * (decimal strings in, cents accumulated) instead of chaining float additions.
 */

type AccountAggregateRow = {
  accountId: string;
  code: string;
  name: string;
  accountType: string;
  debits: string;
  credits: string;
};

type RecentMovementRow = {
  id: string;
  date: Date;
  description: string;
  debit: string;
  credit: string;
  code: string;
  name: string;
  reference: string | null;
};

const RECENT_MOVEMENT_LIMIT = 50;

/** Money never accumulates as float: aggregate as cents. */
function toCents(value: string | number | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100);
}

export const GET = apiHandler(async (request: NextRequest) => {
  try {
    const { companyId } = requireCompanyContext();
    await requireModuleEntitlement('banking');
    const { searchParams } = new URL(request.url);
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');
    const accountId = searchParams.get('accountId');

    const rangeOnly = searchParams.get('rangeOnly') === 'true';
    if (rangeOnly) {
      const earliestEntry = await db.journalEntry.findFirst({
        where: { companyId, status: 'posted' },
        orderBy: { date: 'asc' },
        select: { date: true },
      });
      const latestEntry = await db.journalEntry.findFirst({
        where: { companyId, status: 'posted' },
        orderBy: { date: 'desc' },
        select: { date: true },
      });

      const earliestBankTx = await db.bankTransaction.findFirst({
        where: { statement: { bankAccount: { companyId } }, isReconciled: true, glAccountId: { not: null } },
        orderBy: { date: 'asc' },
        select: { date: true },
      });
      const latestBankTx = await db.bankTransaction.findFirst({
        where: { statement: { bankAccount: { companyId } }, isReconciled: true, glAccountId: { not: null } },
        orderBy: { date: 'desc' },
        select: { date: true },
      });

      let minDate: string | null = null;
      let maxDate: string | null = null;

      const dates: Date[] = [];
      if (earliestEntry) dates.push(earliestEntry.date);
      if (latestEntry) dates.push(latestEntry.date);
      if (earliestBankTx) dates.push(earliestBankTx.date);
      if (latestBankTx) dates.push(latestBankTx.date);

      if (dates.length > 0) {
        const sortedDates = dates.sort((a, b) => a.getTime() - b.getTime());
        minDate = sortedDates[0]!.toISOString().split('T')[0]!;
        maxDate = sortedDates[sortedDates.length - 1]!.toISOString().split('T')[0]!;
      }

      return NextResponse.json({ minDate, maxDate });
    }

    const from = fromDate ? new Date(fromDate + 'T00:00:00.000Z') : null;
    const to = toDate ? new Date(toDate + 'T23:59:59.999Z') : null;

    const journalDateFilter =
      from || to
        ? Prisma.sql`${from ? Prisma.sql`AND je."date" >= ${from}` : Prisma.empty}${
            to ? Prisma.sql` AND je."date" <= ${to}` : Prisma.empty
          }`
        : Prisma.empty;

    const bankDateFilter =
      from || to
        ? Prisma.sql`${from ? Prisma.sql`AND bt."date" >= ${from}` : Prisma.empty}${
            to ? Prisma.sql` AND bt."date" <= ${to}` : Prisma.empty
          }`
        : Prisma.empty;

    // The line-level account filter, expressed exactly as the previous JS pass:
    //  - journal lines are filtered by their own glAccountId;
    //  - a reconciled transaction is only in scope when ITS assigned account
    //    matches, and its bank-asset line is only emitted when the bank account
    //    is that same account.
    const journalLineFilter = accountId
      ? Prisma.sql`AND jl."glAccountId" = ${accountId}`
      : Prisma.empty;
    const bankAssignedFilter = accountId
      ? Prisma.sql`AND bt."glAccountId" = ${accountId}`
      : Prisma.empty;
    const bankAssetFilter = accountId
      ? Prisma.sql`AND bt."glAccountId" = ${accountId} AND ba."glAccountId" = ${accountId}`
      : Prisma.empty;

    const virtualTxFrom = Prisma.sql`
      FROM "BankTransaction" bt
      JOIN "BankStatement" bs ON bs.id = bt."statementId"
      JOIN "BankAccount" ba ON ba.id = bs."bankAccountId"
      WHERE ba."companyId" = ${companyId}
        AND bt."isReconciled" = true
        AND bt."glAccountId" IS NOT NULL
        AND bt."journalEntryId" IS NULL
        ${bankDateFilter}
    `;

    const lineFacts = Prisma.sql`
      SELECT jl."glAccountId" AS "glAccountId", jl."debit" AS debit, jl."credit" AS credit
      FROM "JournalLine" jl
      JOIN "JournalEntry" je ON jl."entryId" = je.id
      WHERE je."companyId" = ${companyId}
        AND je."status" = 'posted'
        ${journalDateFilter}
        ${journalLineFilter}
      UNION ALL
      SELECT bt."glAccountId", CASE WHEN bt."amount" > 0 THEN 0 ELSE -bt."amount" END,
             CASE WHEN bt."amount" > 0 THEN bt."amount" ELSE 0 END
      ${virtualTxFrom}
        ${bankAssignedFilter}
      UNION ALL
      SELECT ba."glAccountId", CASE WHEN bt."amount" > 0 THEN bt."amount" ELSE 0 END,
             CASE WHEN bt."amount" > 0 THEN 0 ELSE -bt."amount" END
      ${virtualTxFrom}
        AND ba."glAccountId" IS NOT NULL
        ${bankAssetFilter}
    `;

    const [aggregateRows, countRows, recentRows] = await Promise.all([
      db.$queryRaw<AccountAggregateRow[]>`
        SELECT
          ga.id AS "accountId",
          ga.code AS code,
          ga.name AS name,
          ga."accountType" AS "accountType",
          COALESCE(SUM(f.debit), 0)::text AS debits,
          COALESCE(SUM(f.credit), 0)::text AS credits
        FROM (${lineFacts}) f
        JOIN "GlAccount" ga ON ga.id = f."glAccountId"
        GROUP BY ga.id, ga.code, ga.name, ga."accountType"
      `,
      db.$queryRaw<Array<{ journalEntries: bigint; virtualTransactions: bigint }>>`
        SELECT
          (
            SELECT COUNT(DISTINCT je.id)
            FROM "JournalLine" jl
            JOIN "JournalEntry" je ON jl."entryId" = je.id
            WHERE je."companyId" = ${companyId}
              AND je."status" = 'posted'
              ${journalDateFilter}
              ${journalLineFilter}
          ) AS "journalEntries",
          (
            SELECT COUNT(DISTINCT bt.id)
            ${virtualTxFrom}
              ${bankAssignedFilter}
          ) AS "virtualTransactions"
      `,
      db.$queryRaw<RecentMovementRow[]>`
        SELECT id, date, description, debit::text AS debit, credit::text AS credit,
               code, name, reference
        FROM (
          SELECT
            je.id || '-' || jl.id AS id,
            je."date" AS date,
            je.description AS description,
            jl."debit" AS debit,
            jl."credit" AS credit,
            ga.code AS code,
            ga.name AS name,
            je.reference AS reference,
            0 AS source
          FROM "JournalLine" jl
          JOIN "JournalEntry" je ON jl."entryId" = je.id
          JOIN "GlAccount" ga ON ga.id = jl."glAccountId"
          WHERE je."companyId" = ${companyId}
            AND je."status" = 'posted'
            ${journalDateFilter}
            ${journalLineFilter}
          UNION ALL
          SELECT
            bt.id || '-' || bt."glAccountId" AS id,
            bt."date" AS date,
            bt.description AS description,
            CASE WHEN bt."amount" > 0 THEN 0 ELSE -bt."amount" END AS debit,
            CASE WHEN bt."amount" > 0 THEN bt."amount" ELSE 0 END AS credit,
            ga.code AS code,
            ga.name AS name,
            bt.reference AS reference,
            1 AS source
          FROM "BankTransaction" bt
          JOIN "BankStatement" bs ON bs.id = bt."statementId"
          JOIN "BankAccount" ba ON ba.id = bs."bankAccountId"
          JOIN "GlAccount" ga ON ga.id = bt."glAccountId"
          WHERE ba."companyId" = ${companyId}
            AND bt."isReconciled" = true
            AND bt."glAccountId" IS NOT NULL
            AND bt."journalEntryId" IS NULL
            ${bankDateFilter}
            ${bankAssignedFilter}
          UNION ALL
          SELECT
            bt.id || '-' || ba."glAccountId" AS id,
            bt."date" AS date,
            bt.description AS description,
            CASE WHEN bt."amount" > 0 THEN bt."amount" ELSE 0 END AS debit,
            CASE WHEN bt."amount" > 0 THEN 0 ELSE -bt."amount" END AS credit,
            ga.code AS code,
            ga.name AS name,
            bt.reference AS reference,
            2 AS source
          FROM "BankTransaction" bt
          JOIN "BankStatement" bs ON bs.id = bt."statementId"
          JOIN "BankAccount" ba ON ba.id = bs."bankAccountId"
          JOIN "GlAccount" ga ON ga.id = ba."glAccountId"
          WHERE ba."companyId" = ${companyId}
            AND bt."isReconciled" = true
            AND bt."glAccountId" IS NOT NULL
            AND bt."journalEntryId" IS NULL
            ${bankDateFilter}
            ${bankAssetFilter}
        ) movement
        WHERE debit <> 0 OR credit <> 0
        ORDER BY date DESC, id ASC
        LIMIT ${RECENT_MOVEMENT_LIMIT}
      `,
    ]);

    // ── By-account (and by-type) aggregation, accumulated in cents ──
    let totalDebitsCents = 0;
    let totalCreditsCents = 0;

    const accountMap = new Map<
      string,
      {
        accountId: string;
        accountCode: string;
        accountName: string;
        accountType: string;
        debitsCents: number;
        creditsCents: number;
      }
    >();

    for (const row of aggregateRows) {
      const debitsCents = toCents(row.debits);
      const creditsCents = toCents(row.credits);
      totalDebitsCents += debitsCents;
      totalCreditsCents += creditsCents;
      accountMap.set(row.accountId, {
        accountId: row.accountId,
        accountCode: row.code,
        accountName: row.name,
        accountType: row.accountType,
        debitsCents,
        creditsCents,
      });
    }

    const byAccountWithNet = Array.from(accountMap.values())
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode))
      .map((account) => ({
        accountId: account.accountId,
        accountCode: account.accountCode,
        accountName: account.accountName,
        accountType: account.accountType,
        debits: account.debitsCents / 100,
        credits: account.creditsCents / 100,
        net: (account.debitsCents - account.creditsCents) / 100,
      }));

    // Type rollup: bounded by the chart of accounts, not by the ledger size.
    const typeMap = new Map<string, { type: string; debitsCents: number; creditsCents: number }>();
    for (const account of accountMap.values()) {
      const existing = typeMap.get(account.accountType);
      if (existing) {
        existing.debitsCents += account.debitsCents;
        existing.creditsCents += account.creditsCents;
      } else {
        typeMap.set(account.accountType, {
          type: account.accountType,
          debitsCents: account.debitsCents,
          creditsCents: account.creditsCents,
        });
      }
    }

    const accountTypeMeta =
      await readJsonConfig<Record<string, { order: number }>>('account-types.json');
    const typeOrder = Object.entries(accountTypeMeta)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => key);
    const byType = Array.from(typeMap.values())
      .sort((a, b) => {
        const aIdx = typeOrder.indexOf(a.type);
        const bIdx = typeOrder.indexOf(b.type);
        return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
      })
      .map((item) => ({
        type: item.type,
        debits: item.debitsCents / 100,
        credits: item.creditsCents / 100,
        net: (item.debitsCents - item.creditsCents) / 100,
      }));

    const counts = countRows[0];
    const transactionCount =
      Number(counts?.journalEntries ?? 0) + Number(counts?.virtualTransactions ?? 0);

    const recentMovements = recentRows.map((row) => ({
      id: row.id,
      date: row.date.toISOString().split('T')[0] ?? '',
      description: row.description,
      debit: toCents(row.debit) / 100,
      credit: toCents(row.credit) / 100,
      account: `${row.code} - ${row.name}`,
      reference: row.reference ?? '',
    }));

    return NextResponse.json({
      summary: {
        totalDebits: totalDebitsCents / 100,
        totalCredits: totalCreditsCents / 100,
        netMovement: (totalDebitsCents - totalCreditsCents) / 100,
        transactionCount,
      },
      byAccount: byAccountWithNet,
      byType,
      recentMovements,
    });
  } catch (error: unknown) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Movement summary error:', { error: String(error) });
    return NextResponse.json({ error: 'Failed to fetch movement summary' }, { status: 500 });
  }
});
