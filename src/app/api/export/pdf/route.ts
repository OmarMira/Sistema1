import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { escapeHtml } from '@/lib/html-escape';

/**
 * GET /api/export/pdf?type=trial_balance|transactions|reconciliation&companyId=xxx&...
 * Returns a well-formatted HTML table as a PDF-downloadable file.
 * Content-Type is set to allow "Print to PDF" from the browser.
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');

  // Get company name and logo for header
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { legalName: true, logo: true },
  });

  // Get user name/email for footer
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true },
  });
  const userName = user
    ? `${user.firstName} ${user.lastName}`.trim() || user.email
    : 'Unknown user';

  let htmlContent: string;
  let filename: string;

  switch (type) {
    case 'trial_balance':
      ({ htmlContent, filename } = await generateTrialBalanceHTML(
        companyId,
        searchParams,
        company?.legalName ?? '',
        userName,
      ));
      break;
    case 'transactions':
      ({ htmlContent, filename } = await generateTransactionsHTML(
        companyId,
        searchParams,
        company?.legalName ?? '',
        userName,
      ));
      break;
    case 'reconciliation':
      ({ htmlContent, filename } = await generateReconciliationHTML(
        companyId,
        searchParams,
        company?.legalName ?? '',
        userName,
      ));
      break;
    default:
      return NextResponse.json(
        { error: 'Invalid type. Use: trial_balance, transactions, reconciliation' },
        { status: 400 },
      );
  }

  // Inject company logo if present
  const baseUrl =
    process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const logoHtml = company?.logo
    ? `<img src="${escapeHtml(company.logo.startsWith('http') ? company.logo : `${baseUrl}${company.logo}`)}" style="max-height: 48px; max-width: 150px; object-fit: contain;" />`
    : '';
  htmlContent = htmlContent.replace('<!--COMPANY_LOGO_PLACEHOLDER-->', logoHtml);

  return new NextResponse(htmlContent, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

/* ─── HTML Template ─────────────────────────────────────────── */

function buildHTML(
  title: string,
  subtitle: string,
  tableHTML: string,
  userName = 'System',
): string {
  const now = new Date();
  const today = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 1cm; size: landscape; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a2e;
    padding: 2rem;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  .content { flex: 1; }
  .header {
    border-bottom: 3px solid #0d9488;
    padding-bottom: 1rem;
    margin-bottom: 1.5rem;
  }
  .header h1 {
    font-size: 1.5rem;
    font-weight: 700;
    color: #0d9488;
  }
  .header .subtitle {
    font-size: 0.875rem;
    color: #64748b;
    margin-top: 0.25rem;
  }
  .header .meta {
    font-size: 0.75rem;
    color: #94a3b8;
    margin-top: 0.5rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  thead th {
    background-color: #f0fdfa;
    color: #0d9488;
    font-weight: 600;
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 2px solid #0d9488;
  }
  thead th.num {
    text-align: right;
  }
  tbody td {
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid #e2e8f0;
  }
  tbody td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  tbody tr:nth-child(even) {
    background-color: #fafafa;
  }
  .total-row td {
    font-weight: 700;
    border-top: 2px solid #0d9488;
    background-color: #f0fdfa;
    padding-top: 0.5rem;
  }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .badge-yes { background-color: #d1fae5; color: #065f46; }
  .badge-no { background-color: #fee2e2; color: #991b1b; }
  .empty {
    text-align: center;
    padding: 3rem;
    color: #94a3b8;
    font-style: italic;
  }
  .report-footer {
    margin-top: 2.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.7rem;
    color: #94a3b8;
  }
  .report-footer .user-info {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  @media print {
    body { padding: 0; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="content">
<div class="header" style="display: flex; justify-content: space-between; align-items: flex-start;">
  <div>
    <h1>${escapeHtml(title)}</h1>
    <div class="subtitle">${escapeHtml(subtitle)}</div>
    <div class="meta">Generated on ${today} at ${timeStr}</div>
  </div>
  <!--COMPANY_LOGO_PLACEHOLDER-->
</div>
${tableHTML}
</div>
<div class="report-footer">
  <div class="user-info">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    <span>Generated by: <strong>${escapeHtml(userName)}</strong></span>
  </div>
  <div>${today} &mdash; ${timeStr}</div>
</div>
</body>
</html>`;
}

/* ─── Trial Balance HTML ────────────────────────────────────── */

async function generateTrialBalanceHTML(
  companyId: string,
  searchParams: URLSearchParams,
  companyName: string,
  userName = 'System',
): Promise<{ htmlContent: string; filename: string }> {
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

  let totalDebit = 0;
  let totalCredit = 0;
  let rows = '';

  const sorted = Array.from(accountBalances.values()).sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  );

  if (sorted.length === 0) {
    rows = '<tr><td colspan="6" class="empty">No data available</td></tr>';
  } else {
    for (const entry of sorted) {
      const netBalance =
        entry.normalBalance === 'debit'
          ? entry.debitTotal - entry.creditTotal
          : entry.creditTotal - entry.debitTotal;

      if (Math.abs(netBalance) < 0.005) continue;

      rows += `<tr>
        <td><code>${escapeHtml(entry.code)}</code></td>
        <td>${escapeHtml(entry.name)}</td>
        <td>${escapeHtml(entry.accountType)}</td>
        <td class="num">${entry.debitTotal.toFixed(2)}</td>
        <td class="num">${entry.creditTotal.toFixed(2)}</td>
        <td class="num">${netBalance.toFixed(2)}</td>
      </tr>`;
      totalDebit += entry.debitTotal;
      totalCredit += entry.creditTotal;
    }

    rows += `<tr class="total-row">
      <td></td><td></td><td>TOTALS</td>
      <td class="num">${totalDebit.toFixed(2)}</td>
      <td class="num">${totalCredit.toFixed(2)}</td>
      <td></td>
    </tr>`;
  }

  const dateStr = asOfDate.toISOString().split('T')[0];
  const tableHTML = `<table>
    <thead><tr>
      <th>Account Code</th><th>Account Name</th><th>Type</th>
      <th class="num">Debit</th><th class="num">Credit</th><th class="num">Net Balance</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  return {
    htmlContent: buildHTML(
      'Trial Balance',
      `${escapeHtml(companyName)} — As of ${dateStr}`,
      tableHTML,
      userName,
    ),
    filename: `trial_balance_${dateStr}.html`,
  };
}

/* ─── Transactions HTML ─────────────────────────────────────── */

async function generateTransactionsHTML(
  companyId: string,
  searchParams: URLSearchParams,
  companyName: string,
  userName = 'System',
): Promise<{ htmlContent: string; filename: string }> {
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
        include: { glAccount: { select: { code: true, name: true } } },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: { date: 'desc' },
  });

  let rows = '';
  if (entries.length === 0) {
    rows = '<tr><td colspan="8" class="empty">No transactions found</td></tr>';
  } else {
    for (const entry of entries) {
      for (const line of entry.lines) {
        rows += `<tr>
          <td>${entry.date.toISOString().split('T')[0]}</td>
          <td>${escapeHtml(entry.reference || '—')}</td>
          <td>${escapeHtml(entry.description)}</td>
          <td><code>${escapeHtml(line.glAccount.code)}</code></td>
          <td>${escapeHtml(line.glAccount.name)}</td>
          <td>${escapeHtml(line.description || '—')}</td>
          <td class="num">${(line.debit || 0).toFixed(2)}</td>
          <td class="num">${(line.credit || 0).toFixed(2)}</td>
        </tr>`;
      }
    }
  }

  const dateRange =
    startDateParam && endDateParam ? `${startDateParam} to ${endDateParam}` : 'All dates';

  const tableHTML = `<table>
    <thead><tr>
      <th>Date</th><th>Reference</th><th>Description</th>
      <th>Account Code</th><th>Account Name</th><th>Line Description</th>
      <th class="num">Debit</th><th class="num">Credit</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  return {
    htmlContent: buildHTML(
      'Transaction Detail',
      `${escapeHtml(companyName)} — ${dateRange}`,
      tableHTML,
      userName,
    ),
    filename: `transactions_report.html`,
  };
}

/* ─── Reconciliation HTML ───────────────────────────────────── */

async function generateReconciliationHTML(
  companyId: string,
  searchParams: URLSearchParams,
  companyName: string,
  userName = 'System',
): Promise<{ htmlContent: string; filename: string }> {
  const bankAccountId = searchParams.get('bankAccountId');
  if (!bankAccountId) {
    return {
      htmlContent: buildHTML('Reconciliation Report', 'Error', '<p>bankAccountId is required.</p>'),
      filename: 'error.html',
    };
  }

  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
    select: { accountName: true, bankName: true, balance: true },
  });

  if (!bankAccount) {
    return {
      htmlContent: buildHTML('Reconciliation Report', 'Error', '<p>Bank account not found.</p>'),
      filename: 'error.html',
    };
  }

  const transactions = await db.bankTransaction.findMany({
    where: { statement: { bankAccountId } },
    include: { glAccount: { select: { code: true, name: true } } },
    orderBy: { date: 'desc' },
  });

  const reconciled = transactions.filter((t) => t.isReconciled);
  const unreconciled = transactions.filter((t) => !t.isReconciled);
  const reconciledTotal = reconciled.reduce((s, t) => s + (t.amount || 0), 0);
  const unreconciledTotal = unreconciled.reduce((s, t) => s + (t.amount || 0), 0);

  let rows = '';
  if (transactions.length === 0) {
    rows = '<tr><td colspan="6" class="empty">No transactions found</td></tr>';
  } else {
    for (const t of transactions) {
      const badgeClass = t.isReconciled ? 'badge-yes' : 'badge-no';
      const badgeText = t.isReconciled ? 'Yes' : 'No';
      rows += `<tr>
        <td>${t.date.toISOString().split('T')[0]}</td>
        <td>${escapeHtml(t.description)}</td>
        <td class="num">${t.amount.toFixed(2)}</td>
        <td>${escapeHtml(t.reference || '—')}</td>
        <td>${t.glAccount ? `${escapeHtml(t.glAccount.code)} — ${escapeHtml(t.glAccount.name)}` : '—'}</td>
        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      </tr>`;
    }
  }

  const summaryHTML = `<div style="display: flex; gap: 2rem; margin-bottom: 1.5rem;">
    <div style="background: #f0fdfa; padding: 1rem; border-radius: 0.5rem; flex: 1;">
      <div style="font-size: 0.75rem; color: #64748b;">Total Transactions</div>
      <div style="font-size: 1.5rem; font-weight: 700; color: #0d9488;">${transactions.length}</div>
    </div>
    <div style="background: #d1fae5; padding: 1rem; border-radius: 0.5rem; flex: 1;">
      <div style="font-size: 0.75rem; color: #065f46;">Reconciled</div>
      <div style="font-size: 1.5rem; font-weight: 700; color: #065f46;">${reconciled.length}</div>
      <div style="font-size: 0.75rem; color: #065f46;">$${reconciledTotal.toFixed(2)}</div>
    </div>
    <div style="background: #fee2e2; padding: 1rem; border-radius: 0.5rem; flex: 1;">
      <div style="font-size: 0.75rem; color: #991b1b;">Unreconciled</div>
      <div style="font-size: 1.5rem; font-weight: 700; color: #991b1b;">${unreconciled.length}</div>
      <div style="font-size: 0.75rem; color: #991b1b;">$${unreconciledTotal.toFixed(2)}</div>
    </div>
  </div>`;

  const tableHTML = `${summaryHTML}<table>
    <thead><tr>
      <th>Date</th><th>Description</th><th class="num">Amount</th>
      <th>Reference</th><th>GL Account</th><th>Reconciled</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  const accountLabel = bankAccount
    ? `${escapeHtml(bankAccount.accountName)} — ${escapeHtml(bankAccount.bankName)}`
    : 'Bank Account';

  return {
    htmlContent: buildHTML(
      'Reconciliation Report',
      `${escapeHtml(companyName)} — ${accountLabel}`,
      tableHTML,
      userName,
    ),
    filename: `reconciliation_report.html`,
  };
}

