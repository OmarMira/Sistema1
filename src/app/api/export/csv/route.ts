import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { csvCell } from '@/lib/csv-cell';

/**
 * Hard row cap for every CSV export (S23a).
 *
 * These endpoints used to stream whatever the database held. A 50k-row ceiling
 * keeps a single request from pinning the Node process and the client's memory.
 * Over the cap the export is REFUSED (413) instead of silently truncated: a
 * bookkeeping export that quietly drops rows is worse than one that asks for a
 * narrower date range.
 */
export const MAX_EXPORT_ROWS = 50_000;

type CsvExport = {
  csvContent: string;
  filename: string;
  /** Emitted data rows (header excluded). */
  rowCount: number;
  /** True when the source exceeded MAX_EXPORT_ROWS and was not exported. */
  capped: boolean;
};

/**
 * GET /api/export/csv?type=trial_balance|transactions|reconciliation&companyId=xxx&...
 * Returns a CSV file download.
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  await requireModuleEntitlement('accounting');

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');

  // H2: validate caller-supplied dates BEFORE any Prisma condition. Invalid
  // dates used to become Invalid Date → PrismaClientValidationError → generic
  // 500. Trial balance (reports/trial-balance) already rejects with 400.
  const hasInvalidDate =
    (searchParams.get('asOfDate') !== null &&
      Number.isNaN(new Date(searchParams.get('asOfDate') as string + 'T23:59:59.999Z').getTime())) ||
    (searchParams.get('startDate') !== null &&
      Number.isNaN(new Date(searchParams.get('startDate') as string + 'T00:00:00.000Z').getTime())) ||
    (searchParams.get('endDate') !== null &&
      Number.isNaN(new Date(searchParams.get('endDate') as string + 'T23:59:59.999Z').getTime()));
  if (hasInvalidDate) {
    return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
  }

  let csvContent: string;
  let filename: string;
  let capped = false;

  switch (type) {
    case 'trial_balance':
      ({ csvContent, filename, capped } = await generateTrialBalanceCSV(companyId, searchParams));
      break;
    case 'transactions':
      ({ csvContent, filename, capped } = await generateTransactionsCSV(companyId, searchParams));
      break;
    case 'reconciliation':
      ({ csvContent, filename, capped } = await generateReconciliationCSV(companyId, searchParams));
      break;
    case 'chart_of_accounts':
      ({ csvContent, filename, capped } = await generateChartOfAccountsCSV(companyId));
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

  if (capped) {
    return NextResponse.json(
      {
        error: `La exportación supera el límite de ${MAX_EXPORT_ROWS.toLocaleString('en-US')} filas. Acotá el rango de fechas e intentá de nuevo.`,
        code: 'EXPORT_TOO_LARGE',
        limit: MAX_EXPORT_ROWS,
      },
      { status: 413 },
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
): Promise<CsvExport> {
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
    take: MAX_EXPORT_ROWS + 1,
  });
  const capped = journalLines.length > MAX_EXPORT_ROWS;

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
      csvCell(entry.code),
      csvCell(entry.name),
      csvCell(entry.accountType),
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
    rowCount: sorted.length,
    capped,
  };
}

/* ─── Transactions CSV ──────────────────────────────────────── */

async function generateTransactionsCSV(
  companyId: string,
  searchParams: URLSearchParams,
): Promise<CsvExport> {
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
    take: MAX_EXPORT_ROWS + 1,
  });
  let capped = entries.length > MAX_EXPORT_ROWS;

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
      if (rows.length > MAX_EXPORT_ROWS) {
        capped = true;
        break;
      }
      rows.push([
        entry.date.toISOString().split('T')[0] ?? '',
        csvCell(entry.reference || ''),
        csvCell(entry.description),
        csvCell(line.glAccount.code),
        csvCell(line.glAccount.name),
        line.description ? csvCell(line.description) : '',
        (line.debit || 0).toFixed(2),
        (line.credit || 0).toFixed(2),
      ]);
    }
  }

  const today = new Date().toISOString().split('T')[0];
  return {
    csvContent: rows.map((r) => r.join(',')).join('\n'),
    filename: `transactions_${today}.csv`,
    rowCount: rows.length - 1,
    capped,
  };
}

/* ─── Reconciliation CSV ────────────────────────────────────── */

async function generateReconciliationCSV(
  companyId: string,
  searchParams: URLSearchParams,
): Promise<CsvExport> {
  const bankAccountId = searchParams.get('bankAccountId');
  if (!bankAccountId) {
    return {
      csvContent: 'Error: bankAccountId is required',
      filename: 'error.csv',
      rowCount: 0,
      capped: false,
    };
  }

  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
    select: { id: true },
  });
  if (!bankAccount) {
    return {
      csvContent: 'Error: Bank account not found',
      filename: 'error.csv',
      rowCount: 0,
      capped: false,
    };
  }

  const transactions = await db.bankTransaction.findMany({
    where: { statement: { bankAccountId } },
    include: { glAccount: { select: { code: true, name: true } } },
    orderBy: { date: 'desc' },
    take: MAX_EXPORT_ROWS + 1,
  });
  const capped = transactions.length > MAX_EXPORT_ROWS;

  const rows: string[][] = [
    ['Date', 'Description', 'Amount', 'Reference', 'GL Account', 'Reconciled'],
  ];

  for (const t of transactions) {
    rows.push([
      t.date.toISOString().split('T')[0] ?? '',
      csvCell(t.description),
      t.amount.toFixed(2),
      csvCell(t.reference || ''),
      t.glAccount ? csvCell(`${t.glAccount.code} - ${t.glAccount.name}`) : '',
      t.isReconciled ? 'Yes' : 'No',
    ]);
  }

  const today = new Date().toISOString().split('T')[0];
  return {
    csvContent: rows.map((r) => r.join(',')).join('\n'),
    filename: `reconciliation_${today}.csv`,
    rowCount: rows.length - 1,
    capped,
  };
}

/* ─── Chart of Accounts CSV ─────────────────────────────────── */

async function generateChartOfAccountsCSV(companyId: string): Promise<CsvExport> {
  const accounts = await db.glAccount.findMany({
    where: { companyId },
    select: { code: true, name: true, accountType: true, normalBalance: true, isActive: true },
    orderBy: { code: 'asc' },
    take: MAX_EXPORT_ROWS + 1,
  });
  const capped = accounts.length > MAX_EXPORT_ROWS;

  const rows: string[][] = [['Account Code', 'Account Name', 'Type', 'Normal Balance', 'Active']];

  for (const acc of accounts) {
    rows.push([
      csvCell(acc.code),
      csvCell(acc.name),
      csvCell(acc.accountType),
      csvCell(acc.normalBalance),
      acc.isActive ? 'Yes' : 'No',
    ]);
  }

  return {
    csvContent: rows.map((r) => r.join(',')).join('\n'),
    filename: 'chart_of_accounts.csv',
    rowCount: accounts.length,
    capped,
  };
}

