import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { apiHandler } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';
import { readJsonConfig } from '@/lib/config-loader';
import { getYearCloseEntryIds } from '@/lib/reports/aggregation';

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

  // 1. Obtener todas las líneas de asientos contables posteados para esta compañía.
  //    Los asientos de cierre anual (identificados estructuralmente vía
  //    AuditLog YEAR_CLOSED → entityId) se EXCLUYEN del desempeño del período:
  //    trasladan el resultado a Retained Earnings y, si se incluyeran, llevan
  //    revenue/expenses a cero (borrando la lectura histórica del año). El
  //    traslado sigue reflejado en el Balance Sheet, que no aplica esta exclusión.
  const yearCloseEntryIds = await getYearCloseEntryIds(companyId);

  // H-2 fix: use GROUP BY for totals and monthly trend instead of loading all lines.
  const yearCloseClause =
    yearCloseEntryIds.length > 0
      ? `AND je.id NOT IN (${yearCloseEntryIds.map((id) => `'${id}'`).join(',')})`
      : '';

  const totalsRows = await db.$queryRaw<
    Array<{ accountType: string; normalBalance: string; totalDebit: bigint; totalCredit: bigint }>
  >`
    SELECT
      ga."accountType" AS "accountType",
      ga."normalBalance" AS "normalBalance",
      COALESCE(SUM(jl."debit"), 0) AS "totalDebit",
      COALESCE(SUM(jl."credit"), 0) AS "totalCredit"
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON jl."entryId" = je.id
    JOIN "GlAccount" ga ON jl."glAccountId" = ga.id
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'posted'
      ${Prisma.raw(yearCloseClause)}
    GROUP BY ga."accountType", ga."normalBalance"
  `;

  const totals = {
    asset: 0,
    liability: 0,
    equity: 0,
    revenue: 0,
    expense: 0,
  };

  for (const row of totalsRows) {
    const type = row.accountType as keyof typeof totals;
    if (type in totals) {
      const totalDebit = Number(row.totalDebit);
      const totalCredit = Number(row.totalCredit);
      const net = totalDebit - totalCredit;
      if (row.normalBalance === 'debit') {
        totals[type] += net;
      } else {
        totals[type] -= net;
      }
    }
  }

  // Monthly trend YTD: GROUP BY month + accountType for revenue/expense
  const trendRows = await db.$queryRaw<
    Array<{ month: string; accountType: string; totalDebit: bigint; totalCredit: bigint }>
  >`
    SELECT
      TO_CHAR(je."date", 'YYYY-MM') AS "month",
      ga."accountType" AS "accountType",
      COALESCE(SUM(jl."debit"), 0) AS "totalDebit",
      COALESCE(SUM(jl."credit"), 0) AS "totalCredit"
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON jl."entryId" = je.id
    JOIN "GlAccount" ga ON jl."glAccountId" = ga.id
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'posted'
      AND je."date" >= ${fiscalStart}
      AND je."date" <= ${fiscalEnd}
      AND ga."accountType" IN ('revenue', 'expense')
      ${Prisma.raw(yearCloseClause)}
    GROUP BY TO_CHAR(je."date", 'YYYY-MM'), ga."accountType"
    ORDER BY "month" ASC
  `;

  const trendMap = new Map<string, { revenue: number; expenses: number }>();

  for (const row of trendRows) {
    if (!trendMap.has(row.month)) {
      trendMap.set(row.month, { revenue: 0, expenses: 0 });
    }
    const trendEntry = trendMap.get(row.month)!;
    const totalDebit = Number(row.totalDebit);
    const totalCredit = Number(row.totalCredit);
    if (row.accountType === 'revenue') {
      trendEntry.revenue += totalCredit - totalDebit; // Crédito - Débito
    } else if (row.accountType === 'expense') {
      trendEntry.expenses += totalDebit - totalCredit; // Débito - Crédito
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
  // H-2 fix: add take limit to prevent loading unbounded result sets.
  const MAX_TRANSACTIONS = 500;
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
    take: MAX_TRANSACTIONS + 1,
  });

  const hasMore = bankTransactions.length > MAX_TRANSACTIONS;
  const limitedTransactions = hasMore ? bankTransactions.slice(0, MAX_TRANSACTIONS) : bankTransactions;

  const transactions = limitedTransactions.map((tx) => ({
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
    hasMore,
    timestamp: new Date().toISOString(),
    configVersion: config.version,
  });
});

