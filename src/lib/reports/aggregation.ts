import { db } from '@/lib/db';

/**
 * IDs de los asientos de cierre anual de una empresa, resueltos estructuralmente:
 * cada cierre registra un AuditLog(action='YEAR_CLOSED', entity='JournalEntry',
 * entityId=<id del asiento de cierre>). No usamos heurística textual sobre
 * description/reference para identificarlos.
 */
export async function getYearCloseEntryIds(companyId: string): Promise<string[]> {
  const closeLogs = await db.auditLog.findMany({
    where: { companyId, action: 'YEAR_CLOSED', entity: 'JournalEntry', entityId: { not: null } },
    select: { entityId: true },
  });
  return closeLogs.map((l) => l.entityId).filter((id): id is string => Boolean(id));
}

export async function aggregateFinancialData(
  companyId: string,
  startDate: Date,
  endDate: Date,
  type: string,
) {
  // Obtener todas las líneas de asientos contables posteados
  // Para balances acumulados (Trial Balance y Balance Sheet), vamos desde el inicio de los tiempos hasta endDate.
  // Para el Estado de Resultados (Income Statement), vamos estrictamente en el rango [startDate, endDate].
  const isPeriodBased = type === 'income_statement';

  // El Income Statement mide el desempeño del período: los asientos de cierre anual
  // (que trasladan el resultado a Retained Earnings) NO deben borrar esa lectura histórica.
  // El Balance Sheet, en cambio, SÍ debe seguir incluyéndolos porque el patrimonio
  // refleja el cierre. Por eso la exclusión aplica únicamente al P&L.
  const yearCloseEntryIds = isPeriodBased ? await getYearCloseEntryIds(companyId) : [];

  const journalLines = await db.journalLine.findMany({
    where: {
      entry: {
        companyId,
        status: 'posted',
        date: isPeriodBased ? { gte: startDate, lte: endDate } : { lte: endDate },
        ...(isPeriodBased && yearCloseEntryIds.length > 0
          ? { id: { notIn: yearCloseEntryIds } }
          : {}),
      },
    },
    include: {
      glAccount: true,
    },
  });

  // Consolidar saldos por cuenta contable
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
    const key = acc.code;
    if (!accountBalances.has(key)) {
      accountBalances.set(key, {
        code: acc.code,
        name: acc.name,
        accountType: acc.accountType,
        debitTotal: 0,
        creditTotal: 0,
        normalBalance: acc.normalBalance,
      });
    }
    const entry = accountBalances.get(key)!;
    entry.debitTotal += Number(line.debit) || 0;
    entry.creditTotal += Number(line.credit) || 0;
  }

  const accountsList: {
    code: string;
    name: string;
    accountType: string;
    debit: number;
    credit: number;
    balance: number;
    normalBalance: string;
  }[] = [];

  let totalDebits = 0;
  let totalCredits = 0;

  for (const entry of accountBalances.values()) {
    const netBalance =
      entry.normalBalance === 'debit'
        ? entry.debitTotal - entry.creditTotal
        : entry.creditTotal - entry.debitTotal;

    accountsList.push({
      code: entry.code,
      name: entry.name,
      accountType: entry.accountType,
      debit: Math.round(entry.debitTotal * 100) / 100,
      credit: Math.round(entry.creditTotal * 100) / 100,
      balance: Math.round(netBalance * 100) / 100,
      normalBalance: entry.normalBalance,
    });

    totalDebits += entry.debitTotal;
    totalCredits += entry.creditTotal;
  }

  // Ordenar cuentas por código
  accountsList.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  if (type === 'trial_balance') {
    return {
      type: 'trial_balance',
      accounts: accountsList,
      totalDebits: Math.round(totalDebits * 100) / 100,
      totalCredits: Math.round(totalCredits * 100) / 100,
      balanced: Math.abs(totalDebits - totalCredits) < 0.01,
    };
  }

  if (type === 'income_statement') {
    const revenues = accountsList.filter((a) => a.accountType === 'revenue');
    const expenses = accountsList.filter((a) => a.accountType === 'expense');

    const totalRevenue = revenues.reduce((sum, r) => sum + r.balance, 0);
    const totalExpense = expenses.reduce((sum, e) => sum + e.balance, 0);
    const netIncome = totalRevenue - totalExpense;

    return {
      type: 'income_statement',
      revenues,
      expenses,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalExpense: Math.round(totalExpense * 100) / 100,
      netIncome: Math.round(netIncome * 100) / 100,
    };
  }

  if (type === 'balance_sheet') {
    // Para Balance Sheet, necesitamos también calcular la Utilidad Neta del Ejercicio histórica (hasta endDate)
    // para integrarla en el patrimonio.
    const allHistoricalLines = await db.journalLine.findMany({
      where: {
        entry: {
          companyId,
          status: 'posted',
          date: { lte: endDate },
        },
      },
      include: { glAccount: true },
    });

    let historicalRevenue = 0;
    let historicalExpense = 0;

    for (const l of allHistoricalLines) {
      const net = (l.debit || 0) - (l.credit || 0);
      if (l.glAccount.accountType === 'revenue') {
        historicalRevenue -= net; // normal balance is credit
      } else if (l.glAccount.accountType === 'expense') {
        historicalExpense += net; // normal balance is debit
      }
    }

    const netIncome = historicalRevenue - historicalExpense;

    const assets = accountsList.filter((a) => a.accountType === 'asset');
    const liabilities = accountsList.filter((a) => a.accountType === 'liability');
    const equities = accountsList.filter((a) => a.accountType === 'equity');

    const totalAssets = assets.reduce((sum, a) => sum + a.balance, 0);
    const totalLiabilities = liabilities.reduce((sum, l) => sum + l.balance, 0);
    const totalEquitiesWithoutIncome = equities.reduce((sum, e) => sum + e.balance, 0);
    const totalEquity = totalEquitiesWithoutIncome + netIncome;

    return {
      type: 'balance_sheet',
      assets,
      liabilities,
      equities: [
        ...equities,
        {
          code: '3030',
          name: 'Utilidad del Ejercicio',
          accountType: 'equity',
          debit: 0,
          credit: netIncome,
          balance: netIncome,
          normalBalance: 'credit',
        },
      ],
      totalAssets: Math.round(totalAssets * 100) / 100,
      totalLiabilities: Math.round(totalLiabilities * 100) / 100,
      totalEquity: Math.round(totalEquity * 100) / 100,
      balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    };
  }

  throw new Error(`Tipo de reporte no soportado: ${type}`);
}

