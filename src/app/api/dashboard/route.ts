import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';

type TypeBalances = {
  asset: number;
  liability: number;
  equity: number;
  revenue: number;
  expense: number;
};

// ─── GL balances by account type ───────────────────────────────────
// H-2 fix: use GROUP BY instead of loading all journal lines into memory.
// `bounds` optionally restricts the aggregation to a journal-entry date
// window so the same computation yields all-time totals (no bounds), period
// totals (gte + lte), or a point-in-time snapshot (lt = "everything before").
// Reconciled bank transactions that never generated a journal entry are
// folded in using their own transaction date, keeping snapshots consistent
// with the all-time totals.
async function computeTypeBalances(
  companyId: string,
  bounds?: { gte?: Date; lte?: Date; lt?: Date },
): Promise<TypeBalances> {
  const dateFilter = Prisma.sql`
    ${bounds?.gte ? Prisma.sql`AND je."date" >= ${bounds.gte}` : Prisma.empty}
    ${bounds?.lte ? Prisma.sql`AND je."date" <= ${bounds.lte}` : Prisma.empty}
    ${bounds?.lt ? Prisma.sql`AND je."date" < ${bounds.lt}` : Prisma.empty}
  `;

  const typeBalanceRows = await db.$queryRaw<
    Array<{ accountType: string; normalBalance: string; totalDebit: bigint; totalCredit: bigint }>
  >`
    SELECT
      ga."accountType" AS "accountType",
      ga."normalBalance" AS "normalBalance",
      COALESCE(SUM(jl."debit"), 0) AS "totalDebit",
      COALESCE(SUM(jl."credit"), 0) AS "totalCredit"
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON jl."entryId" = je.id
    JOIN "GlAccount" ga ON jl."glAccountId" = ga.id
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'posted'
      ${dateFilter}
    GROUP BY ga."accountType", ga."normalBalance"
  `;

  const typeBalances: TypeBalances = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };

  for (const row of typeBalanceRows) {
    const aType = row.accountType;
    if (!(aType in typeBalances)) continue;
    const acctKey = aType as keyof TypeBalances;

    const totalDebit = Number(row.totalDebit);
    const totalCredit = Number(row.totalCredit);
    const net = totalDebit - totalCredit;
    if (row.normalBalance === 'debit') {
      typeBalances[acctKey]! += net;
    } else {
      typeBalances[acctKey]! -= net;
    }
  }

  const txDateFilter = {
    ...(bounds?.gte ? { date: { gte: bounds.gte } } : {}),
    ...(bounds?.lte ? { date: { lte: bounds.lte } } : {}),
    ...(bounds?.lt ? { date: { lt: bounds.lt } } : {}),
  };

  // Include reconciled bank transactions that didn't generate journal entries.
  // H-2 fix: use NOT relation filter instead of loading all and filtering in JS.
  const reconciledTxs = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccount: { companyId } },
      isReconciled: true,
      glAccountId: { not: null },
      journalEntryId: null,
      ...txDateFilter,
    },
    select: {
      amount: true,
      description: true,
      glAccount: {
        select: {
          accountType: true,
          normalBalance: true,
        },
      },
    },
  });

  for (const tx of reconciledTxs) {
    if (!tx.glAccount) continue;

    const aType = tx.glAccount.accountType;
    if (!(aType in typeBalances)) continue;
    const acctKey = aType as keyof TypeBalances;

    const isDeposit = Number(tx.amount) > 0;
    const absAmount = Math.abs(tx.amount);

    const netDebit = isDeposit ? 0 : absAmount;
    const netCredit = isDeposit ? absAmount : 0;
    const net = netDebit - netCredit;

    if (tx.glAccount.normalBalance === 'debit') {
      typeBalances[acctKey]! += net;
    } else {
      typeBalances[acctKey]! -= net;
    }

    // A reconciled-but-unjournaled transaction changes the bank balance without
    // a JournalLine, so the asset total must absorb it directly (otherwise a
    // GL-only snapshot would disagree with the all-time BankAccount.balance).
    const bankAssetNet = isDeposit ? absAmount : -absAmount;
    typeBalances.asset += bankAssetNet;
  }

  return typeBalances;
}

// Percentage change vs a reference value. Returns null when the reference is
// zero: there is no honest percentage to display, so callers hide the delta.
function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

// ─── GET /api/dashboard?companyId=xxx ──────────────────────────────
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  await requireModuleEntitlement('accounting');
  const { searchParams } = new URL(request.url);
  const localeParam = searchParams.get('locale');
  const locale = localeParam === 'en' || localeParam === 'es' ? localeParam : 'es';

  // ── Bank accounts summary ──
  const bankAccounts = await db.bankAccount.findMany({
    where: { companyId, isActive: true },
    select: {
      id: true,
      accountName: true,
      bankName: true,
      balance: true,
      currency: true,
    },
  });

  const totalBankBalance = bankAccounts.reduce((sum, a) => sum + a.balance, 0);

  // ── GL account balances by type (all-time) ──
  const typeBalances = await computeTypeBalances(companyId);

  // ── Active reporting period ──
  // Fiscal period covering "now" when configured, otherwise the current
  // calendar month in UTC — derived from the clock, never a hardcoded window.
  const now = new Date();
  const currentPeriod = await db.fiscalPeriod.findFirst({
    where: {
      companyId,
      startDate: { lte: now },
      endDate: { gte: now },
    },
  });

  const calendarStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const calendarEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
  );
  const periodStart = currentPeriod?.startDate ?? calendarStart;
  const periodEnd = currentPeriod?.endDate ?? calendarEnd;

  // Previous comparable period: the fiscal period that ended right before the
  // active one, else the previous calendar month.
  const previousPeriod = await db.fiscalPeriod.findFirst({
    where: { companyId, endDate: { lt: periodStart } },
    orderBy: { endDate: 'desc' },
    select: { startDate: true, endDate: true },
  });
  const prevStart =
    previousPeriod?.startDate ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevEnd =
    previousPeriod?.endDate ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));

  // Period-scoped totals plus a point-in-time snapshot at the start of the
  // active period, so every displayed delta compares real measurements.
  const [snapshotBalances, periodBalances, prevPeriodBalances] = await Promise.all([
    computeTypeBalances(companyId, { lt: periodStart }),
    computeTypeBalances(companyId, { gte: periodStart, lte: periodEnd }),
    computeTypeBalances(companyId, { gte: prevStart, lte: prevEnd }),
  ]);

  // ── Posted journal entries count (current period) ──
  const postedEntries = await db.journalEntry.count({
    where: {
      companyId,
      status: 'posted',
      ...(currentPeriod && {
        date: {
          gte: currentPeriod.startDate,
          lte: currentPeriod.endDate,
        },
      }),
    },
  });

  // ── Reconciliation status ──
  const reconciledCount = await db.bankTransaction.count({
    where: {
      statement: { bankAccount: { companyId } },
      isReconciled: true,
    },
  });

  const unreconciledCount = await db.bankTransaction.count({
    where: {
      statement: { bankAccount: { companyId } },
      isReconciled: false,
    },
  });

  // ── Recent transactions (last 10) ──
  const recentTransactions = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccount: { companyId } },
    },
    orderBy: { date: 'desc' },
    take: 10,
    select: {
      id: true,
      date: true,
      description: true,
      amount: true,
      reference: true,
      isReconciled: true,
      glAccount: {
        select: { name: true },
      },
    },
  });

  // ── Fiscal period alerts ──
  const upcomingPeriods = await db.fiscalPeriod.findMany({
    where: {
      companyId,
      endDate: { gte: now, lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) },
      isLocked: false,
    },
    orderBy: { endDate: 'asc' },
    select: {
      id: true,
      name: true,
      endDate: true,
    },
  });

  // ── Monthly trend (last 12 months from bank transactions) ──
  // H-2 fix: use GROUP BY instead of loading all transactions into memory.
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const trendRows = await db.$queryRaw<
    Array<{ month: string; income: bigint; expenses: bigint }>
  >`
    SELECT
      TO_CHAR(bt."date", 'YYYY-MM') AS "month",
      COALESCE(SUM(CASE WHEN bt."amount" > 0 THEN bt."amount" ELSE 0 END), 0) AS "income",
      COALESCE(SUM(CASE WHEN bt."amount" < 0 THEN ABS(bt."amount") ELSE 0 END), 0) AS "expenses"
    FROM "BankTransaction" bt
    JOIN "BankStatement" bs ON bt."statementId" = bs.id
    JOIN "BankAccount" ba ON bs."bankAccountId" = ba.id
    WHERE ba."companyId" = ${companyId}
      AND bt."date" >= ${twelveMonthsAgo}
    GROUP BY TO_CHAR(bt."date", 'YYYY-MM')
    ORDER BY "month" ASC
  `;

  // Month labels are localized: `locale` is validated against the supported
  // set (default 'es' so requests without the param keep today's output).
  // Intl gives e.g. 'ene'/'sept' (es) or 'Jan' (en); normalize to the
  // canonical 3-letter, capitalized form consumers already expect ('Ene').
  const monthLabelFormatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    timeZone: 'UTC',
  });
  const monthName = (monthIndex: number) =>
    monthLabelFormatter
      .format(new Date(Date.UTC(2000, monthIndex, 1)))
      .replace(/\./g, '')
      .replace(/^./, (c) => c.toUpperCase())
      .slice(0, 3);

  const monthlyTrend = trendRows.map((row) => ({
    month: monthName(parseInt(row.month.split('-')[1] ?? '1', 10) - 1),
    income: Math.round(Number(row.income) * 100) / 100,
    expenses: Math.round(Number(row.expenses) * 100) / 100,
  }));

  // ── Build response ──
  const accountBalances = Object.entries(typeBalances).map(([accountType, balance]) => ({
    accountType,
    balance: Math.round(balance * 100) / 100,
  }));

  return NextResponse.json({
    totalBankBalance: Math.round(totalBankBalance * 100) / 100,
    bankAccountCount: bankAccounts.length,
    totalAssets: Math.round(typeBalances.asset * 100) / 100,
    totalLiabilities: Math.round(typeBalances.liability * 100) / 100,
    totalEquity: Math.round(typeBalances.equity * 100) / 100,
    totalRevenue: Math.round(typeBalances.revenue * 100) / 100,
    totalExpenses: Math.round(typeBalances.expense * 100) / 100,
    period: {
      startDate: periodStart.toISOString(),
      endDate: periodEnd.toISOString(),
      prevStartDate: prevStart.toISOString(),
      prevEndDate: prevEnd.toISOString(),
      name: currentPeriod?.name ?? null,
    },
    periodRevenue: Math.round(periodBalances.revenue * 100) / 100,
    periodExpenses: Math.round(periodBalances.expense * 100) / 100,
    deltas: {
      assets: pctDelta(typeBalances.asset, snapshotBalances.asset),
      liabilities: pctDelta(typeBalances.liability, snapshotBalances.liability),
      revenue: pctDelta(periodBalances.revenue, prevPeriodBalances.revenue),
      expenses: pctDelta(periodBalances.expense, prevPeriodBalances.expense),
    },
    postedEntries,
    reconciledCount,
    unreconciledCount,
    recentTransactions,
    accountBalances,
    monthlyTrend,
    bankAccounts: bankAccounts.map((a) => ({
      id: a.id,
      accountName: a.accountName,
      bankName: a.bankName,
      balance: Math.round(a.balance * 100) / 100,
      currency: a.currency,
    })),
    upcomingPeriodEnds: upcomingPeriods.map((p) => ({
      id: p.id,
      name: p.name,
      endDate: p.endDate.toISOString(),
    })),
  });
});
