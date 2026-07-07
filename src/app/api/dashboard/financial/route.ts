import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';
import { readJsonConfig } from '@/lib/config-loader';

export const GET = apiHandler(async (req: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  interface DashboardConfig {
    alertThresholds: { balanceMismatchTolerance: number };
    version: string;
  }

  const config = await readJsonConfig<DashboardConfig>('dashboard-config.json');
  const now = new Date();

  // Descubrir el año fiscal activo prioritariamente en base a las transacciones bancarias importadas
  let fiscalYear = now.getUTCFullYear();
  const lastTx = await db.bankTransaction.findFirst({
    where: { statement: { bankAccount: { companyId } } },
    orderBy: { date: 'desc' },
  });
  if (lastTx) {
    fiscalYear = new Date(lastTx.date).getUTCFullYear();
  } else {
    const lastEntry = await db.journalEntry.findFirst({
      where: { companyId, status: 'posted' },
      orderBy: { date: 'desc' },
    });
    if (lastEntry) {
      fiscalYear = new Date(lastEntry.date).getUTCFullYear();
    }
  }

  const fiscalStart = new Date(Date.UTC(fiscalYear, 0, 1));
  const fiscalEnd = new Date(Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999));

  // 1. Obtener todas las líneas de asientos contables posteados para esta compañía
  const postedLines = await db.journalLine.findMany({
    where: {
      entry: {
        companyId,
        status: 'posted',
      },
    },
    select: {
      debit: true,
      credit: true,
      entry: { select: { date: true } },
      glAccount: {
        select: {
          accountType: true,
          normalBalance: true,
        },
      },
    },
  });

  const totals = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };

  const trendMap = new Map<string, { revenue: number; expenses: number }>();

  for (const l of postedLines) {
    const net = (l.debit || 0) - (l.credit || 0);
    const type = l.glAccount.accountType as keyof typeof totals;

    // Acumular totales históricos
    if (type in totals) {
      if (l.glAccount.normalBalance === 'debit') {
        totals[type] += net;
      } else {
        totals[type] -= net;
      }
    }

    // Acumular tendencia mensual YTD para el año fiscal activo
    if (l.entry?.date && l.entry.date >= fiscalStart && l.entry.date <= fiscalEnd) {
      const d = new Date(l.entry.date);
      const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

      if (!trendMap.has(monthKey)) {
        trendMap.set(monthKey, { revenue: 0, expenses: 0 });
      }

      const trendEntry = trendMap.get(monthKey)!;
      if (l.glAccount.accountType === 'revenue') {
        trendEntry.revenue += -net; // Crédito - Débito
      } else if (l.glAccount.accountType === 'expense') {
        trendEntry.expenses += net; // Débito - Crédito
      }
    }
  }

  // En un sistema no cerrado, la ecuación contable considera: Activo = Pasivo + Patrimonio + (Ingresos - Egresos)
  const equationDiff = Math.abs(
    totals.asset - (totals.liability + totals.equity + (totals.revenue - totals.expense)),
  );
  const isEquationBalanced = equationDiff < config.alertThresholds.balanceMismatchTolerance;

  const kpi = {
    assets: Math.round(totals.asset * 100) / 100,
    liabilities: Math.round(totals.liability * 100) / 100,
    equity: Math.round((totals.equity + (totals.revenue - totals.expense)) * 100) / 100, // Patrimonio integrado con P&L
    revenue: Math.round(totals.revenue * 100) / 100,
    expenses: Math.round(totals.expense * 100) / 100,
    accountingEquationCheck: isEquationBalanced ? 'PASS' : 'FAIL',
  };

  // 2. Alertas en tiempo real (Read-Only)
  const lockedPeriods = await db.fiscalPeriod.findMany({ where: { companyId, isLocked: true } });

  const [pendingRecon, unlockedPast, draftsInLocked] = await Promise.all([
    db.bankTransaction.count({
      where: { statement: { bankAccount: { companyId } }, isReconciled: false },
    }),
    db.fiscalPeriod.count({
      where: { companyId, isLocked: false, endDate: { lt: now } },
    }),
    lockedPeriods.length > 0
      ? db.journalEntry.count({
          where: {
            companyId,
            status: 'draft',
            OR: lockedPeriods.map((p) => ({
              date: { gte: p.startDate, lte: p.endDate },
            })),
          },
        })
      : 0,
  ]);

  const alerts = {
    pendingReconciliation: pendingRecon,
    unlockedPastPeriods: unlockedPast,
    draftsInLockedPeriods: draftsInLocked,
    accountingEquation: kpi.accountingEquationCheck,
    status:
      pendingRecon + unlockedPast + draftsInLocked === 0 && isEquationBalanced
        ? 'HEALTHY'
        : 'ATTENTION_REQUIRED',
  };

  const monthlyTrend = Array.from(trendMap.entries())
    .map(([month, val]) => ({
      month,
      revenue: Math.round(val.revenue * 100) / 100,
      expenses: Math.round(val.expenses * 100) / 100,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // 3. Obtener balance inicial e info del banco (para evitar romper la UI)
  const bankAccount = await db.bankAccount.findFirst({
    where: { companyId, isActive: true },
  });

  const initialBalance = bankAccount?.initialBalance ?? 0;
  const bankAccountInfo = bankAccount
    ? {
        accountName: bankAccount.accountName,
        bankName: bankAccount.bankName,
        accountNo: bankAccount.routingNo ? `***${bankAccount.routingNo.slice(-4)}` : '',
      }
    : null;

  // 4. Obtener transacciones del año fiscal en formato exacto i18n
  const bankTransactions = await db.bankTransaction.findMany({
    where: {
      statement: {
        bankAccount: {
          companyId,
        },
      },
      date: {
        gte: fiscalStart,
        lte: fiscalEnd,
      },
    },
    include: {
      glAccount: true,
      matchedRule: {
        include: {
          glAccount: true,
        },
      },
    },
    orderBy: {
      date: 'desc',
    },
  });

  const transactions = bankTransactions.map((tx) => ({
    id: tx.id,
    fecha: tx.date.toISOString().substring(0, 10),
    descripcion: tx.description,
    monto: Math.abs(tx.amount),
    tipo: Number(tx.amount) >= 0 ? 'credito' : 'debito',
    cuenta_contable: tx.glAccount ? `${tx.glAccount.code} ${tx.glAccount.name}` : '',
    conciliado: tx.isReconciled,
    glAccountCode: tx.glAccount?.code ?? null,
    glAccountName: tx.glAccount?.name ?? null,
    glAccountType: tx.glAccount?.accountType ?? null,
    matchedRuleId: tx.matchedRuleId,
    matchedRuleName: tx.matchedRule?.name ?? null,
    matchedRuleGlAccountName: tx.matchedRule?.glAccount?.name ?? null,
  }));

  return NextResponse.json({
    kpi,
    alerts,
    monthlyTrend,
    fiscalYear,
    initialBalance,
    bankAccountInfo,
    revenueTrend: 0,
    expenseTrend: 0,
    transactions,
    timestamp: new Date().toISOString(),
    configVersion: config.version,
  });
});

