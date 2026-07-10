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
  const journalLines = await db.journalLine.findMany({
    where: {
      entry: {
        companyId,
        status: 'posted',
      },
    },
    select: {
      debit: true,
      credit: true,
      glAccount: {
        select: {
          accountType: true,
          normalBalance: true,
        },
      },
      entry: {
        select: {
          description: true,
        },
      },
    },
  });

  // Aggregate by account type
  const typeBalances = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };

  for (const line of journalLines) {
    const aType = line.glAccount.accountType;
    if (!(aType in typeBalances)) continue;

    const net = line.debit - Number(line.credit);
    // For assets/expenses (normal debit): net debit increases balance
    // For liabilities/equity/revenue (normal credit): net credit increases balance
    if (line.glAccount.normalBalance === 'debit') {
      typeBalances[aType]! += net;
    } else {
      typeBalances[aType]! -= net;
    }
  }

  // Include reconciled bank transactions that didn't generate journal entries
  const reconciledTxs = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccount: { companyId } },
      isReconciled: true,
      glAccountId: { not: null },
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

  // Create a set of journal entry descriptions to prevent double counting
  const journalDescSet = new Set(journalLines.map((l) => l.entry?.description));

  for (const tx of reconciledTxs) {
    if (!tx.glAccount) continue;
    // If a journal entry was created for this reconciliation, it will have this exact description prefix
    if (journalDescSet.has(`Reconciliation: ${tx.description}`)) {
      continue;
    }

    const aType = tx.glAccount.accountType;
    if (!(aType in typeBalances)) continue;

    // For BankTransactions: amount > 0 is a deposit (increases asset, credits assigned account)
    // amount < 0 is a payment (decreases asset, debits assigned account)
    const isDeposit = Number(tx.amount) > 0;
    const absAmount = Math.abs(tx.amount);

    // We affect the assigned account
    const netDebit = isDeposit ? 0 : absAmount;
    const netCredit = isDeposit ? absAmount : 0;
    const net = netDebit - netCredit;

    if (tx.glAccount.normalBalance === 'debit') {
      typeBalances[aType]! += net;
    } else {
      typeBalances[aType]! -= net;
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
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const trendTxs = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccount: { companyId } },
      date: { gte: twelveMonthsAgo },
    },
    select: { date: true, amount: true },
  });

  const monthMap: Record<string, { income: number; expenses: number }> = {};
  const MONTH_NAMES = [
    'Ene',
    'Feb',
    'Mar',
    'Abr',
    'May',
    'Jun',
    'Jul',
    'Ago',
    'Sep',
    'Oct',
    'Nov',
    'Dic',
  ];

  for (const tx of trendTxs) {
    const d = new Date(tx.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthMap[key]) monthMap[key] = { income: 0, expenses: 0 };
    if (Number(tx.amount) > 0) monthMap[key].income += Number(tx.amount);
    else monthMap[key].expenses += Math.abs(tx.amount);
  }

  const monthlyTrend = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => ({
      month: MONTH_NAMES[parseInt(key.split('-')[1] ?? '1') - 1] ?? '',
      income: Math.round(val.income * 100) / 100,
      expenses: Math.round(val.expenses * 100) / 100,
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

