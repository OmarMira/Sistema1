import { db } from '@/lib/db';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export type Insight = {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  context?: Record<string, unknown>;
};

export async function generateInsights(companyId: string, role: string): Promise<Insight[]> {
  const configPath = join(process.cwd(), 'rules/assistant-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const insights: Insight[] = [];

  // Usar estrictamente fechas UTC para todos los cálculos
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  // 1. Flujo de caja (últimos 3 períodos)
  if (config.healthChecks.cashFlowTrend.enabled) {
    const threeMonthsAgo = new Date(Date.UTC(year, month - 3, 1));

    // Buscar la cuenta bancaria de la compañía
    const bankAcc = await db.bankAccount.findFirst({
      where: { companyId, isActive: true },
    });

    if (bankAcc) {
      const trendLines = await db.journalLine.findMany({
        where: {
          glAccountId: bankAcc.glAccountId,
          entry: {
            companyId,
            status: 'posted',
            date: { gte: threeMonthsAgo },
          },
        },
        select: {
          debit: true,
          credit: true,
          entry: { select: { date: true } },
        },
      });

      // Agrupar por mes en memoria
      const trendMap = new Map<string, number>();
      for (const l of trendLines) {
        if (!l.entry?.date) continue;
        const d = new Date(l.entry.date);
        const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

        const net = (l.debit || 0) - (l.credit || 0); // Débito - Crédito es flujo de efectivo
        trendMap.set(monthKey, Math.round(((trendMap.get(monthKey) || 0) + net) * 100) / 100);
      }

      insights.push({
        id: 'cash_trend',
        type: 'cash_trend',
        severity: 'info',
        message: `Tendencia de flujo de caja: ${trendMap.size} períodos analizados.`,
        context: Object.fromEntries(trendMap),
      });
    }
  }

  // 2. Alertas de presupuesto (V2.1)
  if (config.healthChecks.budgetVarianceAlert.enabled) {
    const budgetsPath = join(process.cwd(), 'data/budgets.json');
    if (existsSync(budgetsPath)) {
      const budgets = JSON.parse(readFileSync(budgetsPath, 'utf-8'));
      const activeYear = year;
      const activeMonth = month;

      const monthBudgets = budgets[activeYear]?.[activeMonth] || {};
      const start = new Date(Date.UTC(activeYear, activeMonth - 1, 1));
      const end = new Date(Date.UTC(activeYear, activeMonth, 0, 23, 59, 59, 999));

      for (const [code, budgetVal] of Object.entries(monthBudgets)) {
        const actual = await db.journalLine.aggregate({
          _sum: { debit: true, credit: true },
          where: {
            entry: { companyId, status: 'posted', date: { gte: start, lte: end } },
            glAccount: { code },
          },
        });

        const actualVal = (actual._sum.debit ?? 0) - (actual._sum.credit ?? 0);
        const variance =
          Math.abs(actualVal - (budgetVal as number)) / Math.max(1, Math.abs(budgetVal as number));

        if (variance > config.healthChecks.budgetVarianceAlert.thresholdPercent / 100) {
          insights.push({
            id: `budget_${code}`,
            type: 'budget_alert',
            severity: 'warning',
            message: config.templates.anomalyAlert.replace(
              '{issue}',
              `Desviación del ${(variance * 100).toFixed(0)}% respecto al presupuesto en cuenta ${code}`,
            ),
            context: {
              code,
              budget: budgetVal,
              actual: actualVal,
              variance: Math.round(variance * 100) / 100,
            },
          });
        }
      }
    }
  }

  // 3. Ítems no conciliados (V1.4/V2.3)
  if (config.healthChecks.unreconciledItems.enabled) {
    const count = await db.bankTransaction.count({
      where: { statement: { bankAccount: { companyId } }, isReconciled: false },
    });
    if (count > config.healthChecks.unreconciledItems.maxAllowed) {
      insights.push({
        id: 'unreconciled',
        type: 'recon_alert',
        severity: 'critical',
        message: config.templates.anomalyAlert.replace(
          '{issue}',
          `${count} transacciones bancarias sin conciliar`,
        ),
        context: { count },
      });
    }
  }

  // 4. Resumen ejecutivo (plantilla dinámica)
  const activeYear = year;
  const activeMonth = month;
  const period = `${activeYear}-${String(activeMonth).padStart(2, '0')}`;

  const start = new Date(Date.UTC(activeYear, activeMonth - 1, 1));
  const end = new Date(Date.UTC(activeYear, activeMonth, 0, 23, 59, 59, 999));

  const financials = await db.journalLine.findMany({
    where: {
      entry: { companyId, status: 'posted', date: { gte: start, lte: end } },
      glAccount: { accountType: { in: ['revenue', 'expense'] } },
    },
    include: { glAccount: true },
  });

  let income = 0;
  let expenses = 0;

  for (const l of financials) {
    const net = (l.debit || 0) - (l.credit || 0);
    if (l.glAccount.accountType === 'revenue') {
      income -= net; // normal balance is credit
    } else if (l.glAccount.accountType === 'expense') {
      expenses += net; // normal balance is debit
    }
  }

  const net = income - expenses;
  const budgetAlert = insights.some((i) => i.type === 'budget_alert')
    ? '⚠️ Revisa alertas de presupuesto. '
    : '';
  const reconAlert = insights.some((i) => i.type === 'recon_alert')
    ? '⚠️ Hay conciliaciones pendientes. '
    : '';

  insights.push({
    id: 'exec_summary',
    type: 'summary',
    severity: 'info',
    message: config.templates.executiveSummary
      .replace('{period}', period)
      .replace('${net}', net.toFixed(2))
      .replace('${income}', income.toFixed(2))
      .replace('${expenses}', expenses.toFixed(2))
      .replace('{budgetAlert}', budgetAlert)
      .replace('{reconAlert}', reconAlert),
  });

  return insights;
}
