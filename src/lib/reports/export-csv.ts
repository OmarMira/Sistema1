interface AccountRow {
  code: string;
  name: string;
  accountType?: string;
  debit?: number;
  credit?: number;
  balance: number;
}

export interface TrialBalanceData {
  accounts: AccountRow[];
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
}

export interface IncomeStatementData {
  revenues: AccountRow[];
  expenses: AccountRow[];
  totalRevenue: number;
  totalExpense: number;
  netIncome: number;
  balanced: boolean;
}

export interface BalanceSheetData {
  assets: AccountRow[];
  liabilities: AccountRow[];
  equities: AccountRow[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
}

export function exportToCSVContent(
  data: TrialBalanceData | IncomeStatementData | BalanceSheetData,
  companyId: string,
  type: string,
  hash: string,
): string {
  let content = '\uFEFF'; // BOM UTF-8
  content += `LQ&OM LLC - REPORTE FINANCIERO INTERNO (${type.toUpperCase()})\n`;
  content += `Empresa ID,${companyId}\n`;
  content += `Generado el,${new Date().toISOString()}\n`;
  content += `ADVERTENCIA,DOCUMENTO PARA USO INTERNO. NO VÁLIDO PARA PRESENTACIÓN ANTE ENTIDADES GUBERNAMENTALES O FISCALES.\n\n`;

  if (type === 'trial_balance') {
    const tb = data as TrialBalanceData;
    content += 'Código,Cuenta,Tipo,Débito,Crédito,Saldo Neto\n';
    for (const acc of tb.accounts) {
      content += `"${acc.code}","${acc.name}","${acc.accountType}",${acc.debit},${acc.credit},${acc.balance}\n`;
    }
    content += `,,,${tb.totalDebits},${tb.totalCredits},\n`;
    content += `Cuadrado,${tb.balanced ? 'SÍ' : 'NO'}\n`;
  } else if (type === 'income_statement') {
    const isData = data as IncomeStatementData;
    content += 'INGRESOS\n';
    content += 'Código,Cuenta,Saldo\n';
    for (const r of isData.revenues) {
      content += `"${r.code}","${r.name}",${r.balance}\n`;
    }
    content += `TOTAL INGRESOS,,${isData.totalRevenue}\n\n`;

    content += 'EGRESOS / GASTOS\n';
    content += 'Código,Cuenta,Saldo\n';
    for (const e of isData.expenses) {
      content += `"${e.code}","${e.name}",${e.balance}\n`;
    }
    content += `TOTAL GASTOS,,${isData.totalExpense}\n\n`;
    content += `UTILIDAD NETO DEL EJERCICIO,,${isData.netIncome}\n`;
  } else if (type === 'balance_sheet') {
    const bs = data as BalanceSheetData;
    content += 'ACTIVOS (ASSETS)\n';
    content += 'Código,Cuenta,Saldo\n';
    for (const a of bs.assets) {
      content += `"${a.code}","${a.name}",${a.balance}\n`;
    }
    content += `TOTAL ACTIVOS,,${bs.totalAssets}\n\n`;

    content += 'PASIVOS (LIABILITIES)\n';
    content += 'Código,Cuenta,Saldo\n';
    for (const l of bs.liabilities) {
      content += `"${l.code}","${l.name}",${l.balance}\n`;
    }
    content += `TOTAL PASIVOS,,${bs.totalLiabilities}\n\n`;

    content += 'PATRIMONIO (EQUITY)\n';
    content += 'Código,Cuenta,Saldo\n';
    for (const eq of bs.equities) {
      content += `"${eq.code}","${eq.name}",${eq.balance}\n`;
    }
    content += `TOTAL PATRIMONIO,,${bs.totalEquity}\n\n`;
    content += `TOTAL PASIVO + PATRIMONIO,,${bs.totalLiabilities + bs.totalEquity}\n`;
    content += `Cuadrado,${bs.balanced ? 'SÍ' : 'NO'}\n`;
  }

  content += `\nHash_Integridad_SHA256,${hash}\n`;
  return content;
}
