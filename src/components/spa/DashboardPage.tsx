'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { formatCurrency, formatDate } from '@/lib/format';
import { useAccountingFlow } from '@/hooks/useAccountingFlow';
import { FlowKpiCards } from '@/components/accounting-flow/FlowKpiCards';
import { FlowErrorBoundary } from '@/components/accounting-flow/FlowErrorBoundary';
import { AuditSection } from '@/components/audit/AuditSection';
import { FinancialAssistantPanel } from '@/components/assistant/FinancialAssistantPanel';
import { UtcEducationalModal } from '@/components/spa/UtcEducationalModal';
import { StatCard, SummaryMiniCards, BalanceChartCard, MonthlyTrendChartCard, RecentTransactionsTable, BankAccountsCard, QuickActionsCard, containerVariants, itemVariants } from '@/components/dashboard/DashboardPageBlocks';

/* ─── Types ─── */
interface DashboardData {
  totalBankBalance: number;
  bankAccountCount: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  totalRevenue: number;
  totalExpenses: number;
  postedEntries: number;
  reconciledCount: number;
  unreconciledCount: number;
  recentTransactions: {
    id: string;
    date: string;
    description: string;
    amount: number;
    reference: string | null;
    isReconciled: boolean;
    glAccount: { name: string } | null;
  }[];
  accountBalances: {
    accountType: string;
    balance: number;
  }[];
  bankAccounts: {
    id: string;
    accountName: string;
    bankName: string;
    balance: number;
    currency: string;
  }[];
  upcomingPeriodEnds: {
    id: string;
    name: string;
    endDate: string;
  }[];
  monthlyTrend?: { month: string; income: number; expenses: number }[];
  period: {
    startDate: string;
    endDate: string;
    prevStartDate: string;
    prevEndDate: string;
    name: string | null;
  } | null;
  periodRevenue: number;
  periodExpenses: number;
  deltas: {
    assets: number | null;
    liabilities: number | null;
    revenue: number | null;
    expenses: number | null;
  };
}

/* ─── Empty fallback data ─── */
const EMPTY_DATA: DashboardData = {
  totalBankBalance: 0,
  bankAccountCount: 0,
  totalAssets: 0,
  totalLiabilities: 0,
  totalEquity: 0,
  totalRevenue: 0,
  totalExpenses: 0,
  postedEntries: 0,
  reconciledCount: 0,
  unreconciledCount: 0,
  recentTransactions: [],
  accountBalances: [],
  bankAccounts: [],
  upcomingPeriodEnds: [],
  period: null,
  periodRevenue: 0,
  periodExpenses: 0,
  deltas: { assets: null, liabilities: null, revenue: null, expenses: null },
};

/* ─── Current UTC calendar month as a YYYY-MM-DD range (fallback window) ─── */
function currentUtcMonthRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
  );
  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  };
}

/* ─── Main DashboardPage ─── */
export function DashboardPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const d = data ?? EMPTY_DATA;

  // Flow/audit window derives from the API-resolved period (fiscal period or
  // current calendar month) — never a hardcoded date range.
  const flowRange = d.period
    ? { startDate: d.period.startDate.slice(0, 10), endDate: d.period.endDate.slice(0, 10) }
    : currentUtcMonthRange();

  // Hook de Accounting Flow (Fase 2)
  const {
    data: flowData,
    isLoading: flowLoading,
    refetch: refetchFlow,
  } = useAccountingFlow({
    companyId: activeCompany?.id,
    startDate: flowRange.startDate,
    endDate: flowRange.endDate,
  });

  const fetchDashboard = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/dashboard?companyId=${activeCompany.id}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        throw new Error('API error');
      }
    } catch {
      setError(true);
      setData(EMPTY_DATA);
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const handleNewEntry = () => setCurrentView('journal');
  const handleImportStatement = () => setCurrentView('banks');
  const handleRunReports = () => setCurrentView('reports');

  return (
    <motion.div className="space-y-6" variants={containerVariants} initial="hidden" animate="show">
      {/* ── Header ── */}
      <motion.div
        variants={itemVariants}
        className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t('dashboard.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('dashboard.overview')}</p>
        </div>
        {error && !loading && (
          <Badge variant="secondary" className="w-fit gap-1 text-amber-600 border-amber-300">
            <AlertTriangle className="size-3" />
            {t('common.warning')} — {t('dashboard.loadError')}
          </Badge>
        )}
      </motion.div>

      {/* ── Top Cards Row ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t('dashboard.totalAssets')}
          value={formatCurrency(d.totalAssets)}
          icon={<TrendingUp className="size-5 text-emerald-700" />}
          iconBg="bg-emerald-100 dark:bg-emerald-950"
          delta={d.deltas.assets}
          deltaUpIsGood
          loading={loading}
        />
        <StatCard
          title={t('dashboard.totalLiabilities')}
          value={formatCurrency(Math.abs(d.totalLiabilities))}
          icon={<TrendingDown className="size-5 text-amber-700" />}
          iconBg="bg-amber-100 dark:bg-amber-950"
          delta={d.deltas.liabilities}
          deltaUpIsGood={false}
          loading={loading}
        />
        <StatCard
          title={t('dashboard.currentRevenue')}
          value={formatCurrency(d.periodRevenue)}
          icon={<ArrowUpRight className="size-5 text-teal-700" />}
          iconBg="bg-teal-100 dark:bg-teal-950"
          delta={d.deltas.revenue}
          deltaUpIsGood
          loading={loading}
        />
        <StatCard
          title={t('dashboard.currentExpenses')}
          value={formatCurrency(Math.abs(d.periodExpenses))}
          icon={<ArrowDownRight className="size-5 text-rose-700" />}
          iconBg="bg-rose-100 dark:bg-rose-950"
          delta={d.deltas.expenses}
          deltaUpIsGood={false}
          loading={loading}
        />
      </div>

      {/* ── Asistente Financiero Contextual (V2.4) ── */}
      {activeCompany && (
        <motion.div variants={itemVariants}>
          <FinancialAssistantPanel companyId={activeCompany.id} />
        </motion.div>
      )}

      {/* ── Accounting Flow KPIs (Fase 2) ── */}
      <motion.div variants={itemVariants}>
        <FlowErrorBoundary>
          {flowData && (
            <FlowKpiCards
              summary={flowData.summary}
              companyId={activeCompany?.id}
              startDate={flowRange.startDate}
              endDate={flowRange.endDate}
              isLoading={flowLoading}
              onRefresh={refetchFlow}
            />
          )}
        </FlowErrorBoundary>
      </motion.div>

      {/* ── Módulo de Auditoría de Flujo (Fase 3) ── */}
      {flowData && (
        <motion.div variants={itemVariants}>
          <AuditSection
            transactions={flowData.transactions}
            companyId={activeCompany?.id}
            isLoading={flowLoading}
            onRefresh={refetchFlow}
          />
        </motion.div>
      )}

      <SummaryMiniCards t={t} loading={loading} data={d} />

      {/* ── Charts Section ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BalanceChartCard t={t} loading={loading} accountBalances={d.accountBalances} />
        <MonthlyTrendChartCard t={t} loading={loading} data={d.monthlyTrend} />
      </div>

      {/* ── Period Alerts ── */}
      {d.upcomingPeriodEnds.length > 0 && (
        <motion.div variants={itemVariants}>
          <UtcEducationalModal>
            <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40 cursor-pointer hover:bg-amber-100/50 dark:hover:bg-amber-950/60 transition-all select-none hover:shadow-sm">
              <AlertTriangle className="size-5 shrink-0 text-amber-600" />
              <div className="flex-1 text-sm flex items-center justify-between gap-4">
                <span className="font-medium text-amber-800 dark:text-amber-300">
                  {d.upcomingPeriodEnds
                    .map((p) => {
                      const template = t('dashboard.periodEnds');
                      return template
                        .replace('{name}', p.name)
                        .replace('{date}', formatDate(p.endDate));
                    })
                    .join(', ')}
                </span>
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1 border border-amber-200 dark:border-amber-800/60 rounded-md px-2.5 py-1 bg-white/50 dark:bg-black/20 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors shrink-0">
                  <Info className="size-3.5" />
                  <span>{t('common.didacticSupport')}</span>
                </span>
              </div>
            </div>
          </UtcEducationalModal>
        </motion.div>
      )}

      {/* ── Bottom Section ── */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <motion.div variants={itemVariants} className="xl:col-span-2">
          <RecentTransactionsTable t={t} loading={loading} transactions={d.recentTransactions} />
        </motion.div>

        <motion.div variants={itemVariants} className="space-y-6">
          <BankAccountsCard t={t} loading={loading} accounts={d.bankAccounts} />
          <QuickActionsCard t={t} onNewEntry={handleNewEntry} onImportStatement={handleImportStatement} onRunReports={handleRunReports} />
        </motion.div>
      </div>
    </motion.div>
  );
}
