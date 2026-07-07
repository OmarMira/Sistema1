import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';

/**
 * GET /api/export/csv?type=trial_balance|transactions|reconciliation&companyId=xxx&...
 * Returns a CSV file download.
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');

  let csvContent: string;
  let filename: string;

  switch (type) {
    case 'trial_balance':
      ({ csvContent, filename } = await generateTrialBalanceCSV(companyId, searchParams));
      break;
    case 'transactions':
      ({ csvContent, filename } = await generateTransactionsCSV(companyId, searchParams));
      break;
    case 'reconciliation':
      ({ csvContent, filename } = await generateReconciliationCSV(companyId, searchParams));
      break;
    case 'chart_of_accounts':
      ({ csvContent, filename } = await generateChartOfAccountsCSV(companyId));
      break;
    default:
      return NextResponse.json(
        {
          error:
            'Invalid type. Use: trial_balance, transactions, reconciliation, chart_of_accounts',
        },
        { status: 400 },
      );
  }

  // Return CSV with BOM for Excel compatibility
  const bom = '\uFEFF';
  return new NextResponse(bom + csvContent, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

/* ─── Trial Balance CSV ─────────────────────────────────────── */

async function generateTrialBalanceCSV(
  companyId: string,
  searchParams: URLSearchParams,
): Promise<{ csvContent: string; filename: string }> {
  const asOfDateParam = searchParams.get('asOfDate');
  const asOfDate = asOfDateParam ? new Date(asOfDateParam + 'T23:59:59.999Z') : new Date();

  const journalLines = await db.journalLine.findMany({
    where: {
      entry: { companyId, status: 'posted', date: { lte: asOfDate } },
    },
    include: {
      glAccount: {
        select: { code: true, name: true, accountType: true, normalBalance: true, isActive: true },
      },
    },
  });

  const accountBalances = new Map<
    string,
    {
      code: string;
      name: string;
      accountType: string;
      debitTotal: number;
      creditTotal: number;
      normalBalance: string;
    }
  >();

  for (const line of journalLines) {
    const acc = line.glAccount;
    if (!acc || !acc.isActive) continue;
    if (!accountBalances.has(acc.code)) {
      accountBalances.set(acc.code, {
        code: acc.code,
        name: acc.name,
        accountType: acc.accountType,
        debitTotal: 0,
        creditTotal: 0,
        normalBalance: acc.normalBalance,
      });
    }
    const entry = accountBalances.get(acc.code)!;
    entry.debitTotal += Number(line.debit) || 0;
    entry.creditTotal += Number(line.credit) || 0;
  }

  const rows: string[][] = [
    ['Account Code', 'Account Name', 'Type', 'Debit', 'Credit', 'Net Balance'],
  ];

  let totalDebit = 0;
  let totalCredit = 0;

  const sorted = Array.from(accountBalances.values()).sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  );

  for (const entry of sorted) {
    const netBalance =
      entry.normalBalance === 'debit'
        ? entry.debitTotal - entry.creditTotal
        : entry.creditTotal - entry.debitTotal;

    if (Math.abs(netBalance) < 0.005) continue;

    rows.push([
      entry.code,
      `"${entry.name}"`,
      entry.accountType,
      entry.debitTotal.toFixed(2),
      entry.creditTotal.toFixed(2),
      netBalance.toFixed(2),
    ]);

    totalDebit += entry.debitTotal;
    totalCredit += entry.creditTotal;
  }

  rows.push([]);
  rows.push(['', 'TOTALS', '', totalDebit.toFixed(2), totalCredit.toFixed(2), '']);

  const dateStr = asOfDate.toISOString().split('T')[0];
  return {
    csvContent: rows.map((r) => r.join(',')).join('\n'),
    filename: `trial_balance_${dateStr}.csv`,
  };
}

/* ─── Transactions CSV ──────────────────────────────────────── */

async function generateTransactionsCSV(
  companyId: string,
  searchParams: URLSearchParams,
): Promise<{ csvContent: string; filename: string }> {
  const startDateParam = searchParams.get('startDate');
  const endDateParam = searchParams.get('endDate');

  const where: Record<string, unknown> = { companyId, status: 'posted' };
  if (startDateParam || endDateParam) {
    where.date = {};
    if (startDateParam)
      (where.date as Record<string, unknown>).gte = new Date(startDateParam + 'T00:00:00.000Z');
    if (endDateParam)
      (where.date as Record<string, unknown>).lte = new Date(endDateParam + 'T23:59:59.999Z');
  }

  const entries = await db.journalEntry.findMany({
    where,
    include: {
      lines: {
        include: {
          glAccount: { select: { code: true, name: true } },
        },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: { date: 'desc' },
  });

  const rows: string[][] = [
    [
      'Date',
      'Reference',
      'Entry Description',
      'Account Code',
      'Account Name',
      'Line Description',
      'Debit',
      'Credit',
    ],
  ];

  for (const entry of entries) {
    for (const line of entry.lines) {
      rows.push([
        entry.date.toISOString().split('T')[0],
        entry.reference || '',
        `"${entry.description}"`,
        line.glAccount.code,
        `"${line.glAccount.name}"`,
        line.description ? `"${line.description}"` : '',
        (line.debit || 0).toFixed(2),
        (line.credit || 0).toFixed(2),
      ]);
    }
  }

  const today = new Date().toISOString().split('T')[0];
  return {
    csvContent: rows.map((r) => r.join(',')).join('\n'),
    filename: `transactions_${today}.csv`,
  };
}

/* ─── Reconciliation CSV ────────────────────────────────────── */

async function generateReconciliationCSV(
  companyId: string,
  searchParams: URLSearchParams,
): Promise<{ csvContent: string; filename: string }> {
  const bankAccountId = searchParams.get('bankAccountId');
  if (!bankAccountId) {
    return {
      csvContent: 'Error: bankAccountId is required',
      filename: 'error.csv',
    };
  }

  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
    select: { id: true },
  });
  if (!bankAccount) {
    return { csvContent: 'Error: Bank account not found', filename: 'error.csv' };
  }

  const transactions = await db.bankTransaction.findMany({
    where: { statement: { bankAccountId } },
    include: { glAccount: { select: { code: true, name: true } } },
    orderBy: { date: 'desc' },
  });

  const rows: string[][] = [
    ['Date', 'Description', 'Amount', 'Reference', 'GL Account', 'Reconciled'],
  ];

  for (const t of transactions) {
    rows.push([
      t.date.toISOString().split('T')[0],
      `"${t.description}"`,
      t.amount.toFixed(2),
      t.reference || '',
      t.glAccount ? `${t.glAccount.code} - ${t.glAccount.name}` : '',
      t.isReconciled ? 'Yes' : 'No',
    ]);
  }

  const today = new Date().toISOString().split('T')[0];
  return {
    csvContent: rows.map((r) => r.join(',')).join('\n'),
    filename: `reconciliation_${today}.csv`,
  };
}

/* ─── Chart of Accounts CSV ─────────────────────────────────── */

async function generateChartOfAccountsCSV(
  companyId: string,
): Promise<{ csvContent: string; filename: string }> {
  const accounts = await db.glAccount.findMany({
    where: { companyId },
    select: { code: true, name: true, accountType: true, normalBalance: true, isActive: true },
    orderBy: { code: 'asc' },
  });

  const rows: string[][] = [['Account Code', 'Account Name', 'Type', 'Normal Balance', 'Active']];

  for (const acc of accounts) {
    rows.push([
      acc.code,
      `"${acc.name}"`,
      acc.accountType,
      acc.normalBalance,
      acc.isActive ? 'Yes' : 'No',
    ]);
  }

  return {
    csvContent: rows.map((r) => r.join(',')).join('\n'),
    filename: 'chart_of_accounts.csv',
  };
}

