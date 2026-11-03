import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { toUTCRange } from '@/lib/reports/date-filter';
import { aggregateFinancialData } from '@/lib/reports/aggregation';
import { exportToCSVContent, type TrialBalanceData, type IncomeStatementData, type BalanceSheetData } from '@/lib/reports/export-csv';
import { generateHash } from '@/lib/reports/integrity';
import { escapeHtml } from '@/lib/html-escape';

/**
 * S23b — the "PDF" export used to answer `Content-Type: application/pdf` with
 * plain text and the UI labelled it "PDF Firmado", which is false twice over:
 * it was not a PDF and nothing was ever signed. There is no PDF generator in
 * this deployment (no server-side renderer, no signing key), so the honest
 * action is a real browser print flow: this endpoint renders the report as a
 * printable HTML document and the browser's print dialog produces the PDF.
 */
const PRINT_FORMATS = new Set(['print', 'pdf']);

export const GET = apiHandler(async (req: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();
  await requireModuleEntitlement('accounting');

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') || '';
  const format = searchParams.get('format') || 'csv';
  const startDateStr = searchParams.get('startDate');
  const endDateStr = searchParams.get('endDate');

  if (!type) {
    return NextResponse.json({ error: 'companyId y type son requeridos' }, { status: 400 });
  }

  try {
    const { startDate, endDate } = toUTCRange(startDateStr, endDateStr);

    // 1. Obtener datos agregados
    const data = await aggregateFinancialData(companyId, startDate, endDate, type);

    // 2. Generar el payload del reporte a firmar
    const reportPayload = {
      type,
      format,
      companyId,
      dateRange: { start: startDate.toISOString(), end: endDate.toISOString() },
      data,
      exportedAt: new Date().toISOString(),
    };

    // 3. Generar el hash de integridad criptográfico pre-render
    const hash = generateHash(reportPayload);

    // 4. Registrar auditoría
    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'REPORT_EXPORTED',
        entity: 'Company',
        entityId: companyId,
        details: JSON.stringify({
          type,
          format,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          hash,
        }),
      },
    });

    if (format === 'csv') {
      const csvContent = exportToCSVContent(data as TrialBalanceData | IncomeStatementData | BalanceSheetData, companyId, type, hash);
      const response = new NextResponse(csvContent);
      response.headers.set('Content-Type', 'text/csv; charset=utf-8');
      response.headers.set(
        'Content-Disposition',
        `attachment; filename="reporte-${type}-${companyId}-${Date.now()}.csv"`,
      );
      response.headers.set('X-Integrity-Hash', hash);
      return response;
    }

    // PDF Mock o exportación nativa
    if (PRINT_FORMATS.has(format)) {
      const html = renderPrintableReport({
        type,
        companyId,
        data: data as TrialBalanceData | IncomeStatementData | BalanceSheetData,
        hash,
        startDate,
        endDate,
      });

      const response = new NextResponse(html);
      response.headers.set('Content-Type', 'text/html; charset=utf-8');
      response.headers.set(
        'Content-Disposition',
        `inline; filename="reporte-${type}-${companyId}-${Date.now()}.html"`,
      );
      response.headers.set('X-Integrity-Hash', hash);
      return response;
    }

    throw new Error('Formato no soportado');
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
});

const REPORT_TITLES: Record<string, string> = {
  trial_balance: 'Balanza de Comprobación',
  income_statement: 'Estado de Resultados (P&L)',
  balance_sheet: 'Balance General',
};

interface PrintRow {
  code: string;
  name: string;
  balance: number;
  debit?: number;
  credit?: number;
  accountType?: string;
}

function rowsTable(rows: PrintRow[], withDebitCredit = false): string {
  const head = withDebitCredit
    ? '<tr><th>Código</th><th>Cuenta</th><th>Débito</th><th>Crédito</th><th>Saldo</th></tr>'
    : '<tr><th>Código</th><th>Cuenta</th><th>Saldo</th></tr>';
  const body = rows
    .map((row) =>
      withDebitCredit
        ? `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td class="num">${fmt(row.debit)}</td><td class="num">${fmt(row.credit)}</td><td class="num">${fmt(row.balance)}</td></tr>`
        : `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td class="num">${fmt(row.balance)}</td></tr>`,
    )
    .join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function fmt(value: number | undefined): string {
  return Number(value ?? 0).toFixed(2);
}

function renderReportSections(
  type: string,
  data: TrialBalanceData | IncomeStatementData | BalanceSheetData,
): string {
  if (type === 'trial_balance') {
    const tb = data as TrialBalanceData;
    return `${rowsTable(tb.accounts as PrintRow[], true)}
      <p class="totals">Totales: débito ${fmt(tb.totalDebits)} · crédito ${fmt(tb.totalCredits)} · ${
        tb.balanced ? 'cuadra' : 'NO cuadra'
      }</p>`;
  }
  if (type === 'income_statement') {
    const is = data as IncomeStatementData;
    return `<h2>Ingresos</h2>${rowsTable(is.revenues as PrintRow[])}
      <p class="totals">Total ingresos: ${fmt(is.totalRevenue)}</p>
      <h2>Gastos</h2>${rowsTable(is.expenses as PrintRow[])}
      <p class="totals">Total gastos: ${fmt(is.totalExpense)}</p>
      <p class="totals">Utilidad neta: ${fmt(is.netIncome)}</p>`;
  }
  const bs = data as BalanceSheetData;
  return `<h2>Activos</h2>${rowsTable(bs.assets as PrintRow[])}
    <p class="totals">Total activos: ${fmt(bs.totalAssets)}</p>
    <h2>Pasivos</h2>${rowsTable(bs.liabilities as PrintRow[])}
    <p class="totals">Total pasivos: ${fmt(bs.totalLiabilities)}</p>
    <h2>Patrimonio</h2>${rowsTable(bs.equities as PrintRow[])}
    <p class="totals">Total patrimonio: ${fmt(bs.totalEquity)}</p>`;
}

function renderPrintableReport(params: {
  type: string;
  companyId: string;
  data: TrialBalanceData | IncomeStatementData | BalanceSheetData;
  hash: string;
  startDate: Date;
  endDate: Date;
}): string {
  const { type, companyId, data, hash, startDate, endDate } = params;
  const title = REPORT_TITLES[type] ?? type;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #111827; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 20px 0 6px; }
  .meta { font-size: 12px; color: #4b5563; margin-bottom: 16px; }
  .notice { font-size: 11px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; padding: 8px 10px; border-radius: 6px; margin: 16px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 4px 6px; text-align: left; }
  th { background: #f3f4f6; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { font-size: 12px; font-weight: 600; margin: 6px 0 0; }
  .actions { margin-top: 24px; }
  button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid #d1d5db; background: #111827; color: #fff; cursor: pointer; }
  @media print { .actions { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Empresa: ${escapeHtml(companyId)} · Período: ${escapeHtml(
    startDate.toISOString().slice(0, 10),
  )} a ${escapeHtml(endDate.toISOString().slice(0, 10))} · Generado: ${escapeHtml(
    new Date().toISOString(),
  )}</p>
  <p class="meta">Huella de integridad SHA-256: ${escapeHtml(hash)}</p>
  ${renderReportSections(type, data)}
  <p class="notice">Documento de uso interno. NO está firmado digitalmente ni es válido para presentación ante entidades fiscales o gubernamentales. La huella SHA-256 permite verificar que el contenido no fue alterado después de generarse.</p>
  <div class="actions">
    <button type="button" onclick="window.print()">Imprimir / Guardar como PDF</button>
  </div>
</body>
</html>`;
}
