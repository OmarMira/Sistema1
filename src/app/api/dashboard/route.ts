import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';

// ─── GET /api/dashboard?companyId=xxx ──────────────────────────────
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { searchParams } = new URL(request.url);

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

  // ── GL account balances by type ──
  // H-2 fix: use GROUP BY instead of loading all journal lines into memory.
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
    GROUP BY ga."accountType", ga."normalBalance"
  `;

  const typeBalances = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };

  for (const row of typeBalanceRows) {
    const aType = row.accountType;
    if (!(aType in typeBalances)) continue;
    const acctKey = aType as keyof typeof typeBalances;

    const totalDebit = Number(row.totalDebit);
    const totalCredit = Number(row.totalCredit);
    const net = totalDebit - totalCredit;
    if (row.normalBalance === 'debit') {
      typeBalances[acctKey]! += net;
    } else {
      typeBalances[acctKey]! -= net;
    }
  }

  // Include reconciled bank transactions that didn't generate journal entries
  // H-2 fix: use NOT relation filter instead of loading all and filtering in JS.
  const reconciledTxs = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccount: { companyId } },
      isReconciled: true,
      glAccountId: { not: null },
      journalEntryId: null,
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
    const acctKey = aType as keyof typeof typeBalances;

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

    // We also affect the bank asset account implicitly if we wanted to balance,
    // but the totalBankBalance is already calculated accurately from BankAccount.balance.
    // However, if typeBalances.asset is used to show total assets, we should add the bank balance impact?
    // Wait, typeBalances.asset includes the JournalLine of the bank account.
    // If the bank transaction is NOT in JournalLine, the bank asset balance in typeBalances.asset is missing it!
    // So we should also update typeBalances.asset
    const bankAssetNet = isDeposit ? absAmount : -absAmount;
    typeBalances.asset += bankAssetNet;
  }

  // ── Posted journal entries count (current period) ──
  const now = new Date();
  const currentPeriod = await db.fiscalPeriod.findFirst({
    where: {
      companyId,
      startDate: { lte: now },
      endDate: { gte: now },
    },
  });

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

  const MONTH_NAMES = [
    'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
    'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
  ];

  const monthlyTrend = trendRows.map((row) => ({
    month: MONTH_NAMES[parseInt(row.month.split('-')[1] ?? '1') - 1] ?? '',
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

