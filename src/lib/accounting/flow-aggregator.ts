import type {
  AccountingFlowResponse,
  FlowTransaction,
  FlowByPeriod,
  FlowByAccount,
  FlowSummary,
} from '../../types/accounting-flow';
import { logger } from '../logger';

export interface AggregatorFilters {
  companyId: string;
  startDate: Date;
  endDate: Date;
}

 
export async function aggregateAccountingFlow(
  prisma: any,
  filters: AggregatorFilters,
): Promise<AccountingFlowResponse> {
  const { companyId, startDate, endDate } = filters;

  const fallbackResponse: AccountingFlowResponse = {
    summary: {
      periodStart: startDate.toISOString().substring(0, 10),
      periodEnd: endDate.toISOString().substring(0, 10),
      totalInflows: 0,
      totalOutflows: 0,
      netFlow: 0,
      transactionCount: 0,
    },
    byPeriod: [],
    byAccount: [],
    transactions: [],
  };

  try {
    // 1. Obtener cuentas de banco de la empresa y sus glAccountIds correspondientes (cuentas de efectivo)
    const bankAccounts = await prisma.bankAccount.findMany({
      where: { companyId, isActive: true },
      select: { glAccountId: true },
    });

    const cashAccountIds = bankAccounts.map((ba: { glAccountId: string | null }) => ba.glAccountId);

    if (cashAccountIds.length === 0) {
      return fallbackResponse;
    }

    const aggregatedTransactions: FlowTransaction[] = [];

    // 2. Obtener asientos publicados (JournalEntries en estado 'posted')
    const journalEntries = await prisma.journalEntry.findMany({
      where: {
        companyId,
        status: 'posted',
        date: { gte: startDate, lte: endDate },
      },
      include: {
        lines: {
          include: {
            glAccount: true,
          },
        },
      },
    });

    for (const entry of journalEntries) {
      // Filtrar las líneas del asiento que tocan la cuenta de efectivo
      const cashLines = entry.lines.filter((line: { glAccountId: string | null }) => cashAccountIds.includes(line.glAccountId));

      // Las líneas de contrapartida (las que no tocan efectivo)
      const offsetLines = entry.lines.filter((line: { glAccountId: string | null }) => !cashAccountIds.includes(line.glAccountId));

      // Determinar la contrapartida principal (la de mayor monto absoluto)
      let primaryOffset = { code: '9999', name: 'Contrapartida Múltiple' };
      if (offsetLines.length === 1) {
        primaryOffset = {
          code: offsetLines[0]!.glAccount.code,
          name: offsetLines[0]!.glAccount.name,
        };
      } else if (offsetLines.length > 1) {
        const sortedOffset = [...offsetLines].sort(
          (a, b) => Math.max(b.debit, b.credit) - Math.max(a.debit, a.credit),
        );
        primaryOffset = {
          code: sortedOffset[0]!.glAccount.code,
          name: sortedOffset[0]!.glAccount.name,
        };
      }

      for (const cashLine of cashLines) {
        const debit = cashLine.debit || 0;
        const credit = cashLine.credit || 0;

        if (debit > 0) {
          aggregatedTransactions.push({
            id: `jl-${cashLine.id}-debit`,
            date: entry.date.toISOString().substring(0, 10),
            description: entry.description || 'Asiento Contable',
            account: primaryOffset.name,
            accountCode: primaryOffset.code,
            amount: debit,
            type: 'inflow',
            source: 'journal',
          });
        }

        if (credit > 0) {
          aggregatedTransactions.push({
            id: `jl-${cashLine.id}-credit`,
            date: entry.date.toISOString().substring(0, 10),
            description: entry.description || 'Asiento Contable',
            account: primaryOffset.name,
            accountCode: primaryOffset.code,
            amount: -credit,
            type: 'outflow',
            source: 'journal',
          });
        }
      }
    }

    // 3. Obtener transacciones bancarias conciliadas pero no vinculadas (journalLineId es NULL)
    const bankTransactions = await prisma.bankTransaction.findMany({
      where: {
        statement: {
          bankAccount: {
            companyId,
          },
        },
        date: { gte: startDate, lte: endDate },
        isReconciled: true,
        journalLineId: null,
      },
      include: {
        glAccount: true,
      },
    });

    for (const tx of bankTransactions) {
      const amount = tx.amount;
      const type = amount >= 0 ? 'inflow' : 'outflow';

      // Contrapartida asignada a la transacción bancaria
      const offsetAccount = tx.glAccount
        ? { code: tx.glAccount.code, name: tx.glAccount.name }
        : { code: '9999', name: 'Sin Clasificar' };

      aggregatedTransactions.push({
        id: `bt-${tx.id}`,
        date: tx.date.toISOString().substring(0, 10),
        description: tx.description,
        account: offsetAccount.name,
        accountCode: offsetAccount.code,
        amount: amount,
        type,
        source: 'bank_transaction',
      });
    }

    // 4. Ordenar transacciones por fecha
    aggregatedTransactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // 5. Calcular resumen (Summary)
    let totalInflows = 0;
    let totalOutflows = 0;

    for (const t of aggregatedTransactions) {
      if (t.amount > 0) {
        totalInflows += t.amount;
      } else {
        totalOutflows += Math.abs(t.amount);
      }
    }

    // Formatear a 2 decimales para evitar floating point issues
    totalInflows = Math.round(totalInflows * 100) / 100;
    totalOutflows = Math.round(totalOutflows * 100) / 100;
    const netFlow = Math.round((totalInflows - totalOutflows) * 100) / 100;

    const summary: FlowSummary = {
      periodStart: startDate.toISOString().substring(0, 10),
      periodEnd: endDate.toISOString().substring(0, 10),
      totalInflows,
      totalOutflows,
      netFlow,
      transactionCount: aggregatedTransactions.length,
    };

    // 6. Agrupar por Período (byPeriod)
    const periodMap = new Map<string, { inflows: number; outflows: number }>();
    for (const t of aggregatedTransactions) {
      const period = t.date.substring(0, 7); // YYYY-MM
      const current = periodMap.get(period) || { inflows: 0, outflows: 0 };
      if (t.amount > 0) {
        current.inflows += t.amount;
      } else {
        current.outflows += Math.abs(t.amount);
      }
      periodMap.set(period, current);
    }

    const byPeriod: FlowByPeriod[] = Array.from(periodMap.entries())
      .map(([period, data]) => {
        const inflows = Math.round(data.inflows * 100) / 100;
        const outflows = Math.round(data.outflows * 100) / 100;
        return {
          period,
          inflows,
          outflows,
          net: Math.round((inflows - outflows) * 100) / 100,
        };
      })
      .sort((a, b) => a.period.localeCompare(b.period));

    // 7. Agrupar por Cuenta de Contrapartida (byAccount)
    const accountMap = new Map<string, { name: string; debit: number; credit: number }>();
    for (const t of aggregatedTransactions) {
      const key = t.accountCode;
      const current = accountMap.get(key) || { name: t.account, debit: 0, credit: 0 };
      if (t.amount > 0) {
        // Para la contrapartida en un inflow, es un crédito
        current.credit += t.amount;
      } else {
        // Para la contrapartida en un outflow, es un débito
        current.debit += Math.abs(t.amount);
      }
      accountMap.set(key, current);
    }

    const byAccount: FlowByAccount[] = Array.from(accountMap.entries())
      .map(([code, data]) => {
        const debit = Math.round(data.debit * 100) / 100;
        const credit = Math.round(data.credit * 100) / 100;
        // Net flow para la cuenta de contrapartida (debit - credit) o según balance
        return {
          code,
          name: data.name,
          type: code === '9999' ? 'unclassified' : 'contra',
          debit,
          credit,
          net: Math.round((debit - credit) * 100) / 100,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));

    return {
      summary,
      byPeriod,
      byAccount,
      transactions: aggregatedTransactions,
    };
  } catch (error) {
    logger.error('Error calculating accounting flow:', { error: String(error) });
    return fallbackResponse;
  }
}
