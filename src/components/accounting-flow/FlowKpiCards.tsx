'use client';

import { motion, type Variants } from 'framer-motion';
import { ArrowUpRight, ArrowDownRight, Layers, Activity, RefreshCw, Download } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { useLanguageStore } from '@/store/language-store';

interface FlowKpiCardsProps {
  summary: {
    totalInflows: number;
    totalOutflows: number;
    netFlow: number;
    transactionCount: number;
  };
  companyId?: string | null;
  startDate?: string;
  endDate?: string;
  isLoading?: boolean;
  onRefresh?: () => void;
}

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

export function FlowKpiCards({
  summary,
  companyId,
  startDate,
  endDate,
  isLoading = false,
  onRefresh,
}: FlowKpiCardsProps) {
  const { totalInflows, totalOutflows, netFlow, transactionCount } = summary;
  const language = useLanguageStore((s) => s.language) || 'es';
  const isEn = language === 'en';

  const dt = {
    title: isEn ? 'Real Cash Flow in Staging' : 'Flujo de Caja Real en Staging',
    subtitle: isEn
      ? 'Based on posted journal entries and reconciled non-duplicated movements'
      : 'Basado en asientos contables y movimientos conciliados no duplicados',
    exportCsv: isEn ? 'Export CSV' : 'Exportar CSV',
    refreshFlow: isEn ? 'Refresh flow' : 'Actualizar flujo',
    inflows: isEn ? 'Inflows' : 'Entradas (Inflows)',
    outflows: isEn ? 'Outflows' : 'Salidas (Outflows)',
    netFlow: isEn ? 'Net Flow' : 'Flujo Neto',
    transactions: isEn ? 'Transactions' : 'Transacciones',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
            {dt.title}
          </h3>
          <p className="text-xs text-muted-foreground">{dt.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {companyId && startDate && endDate && (
            <a
              href={`/api/accounting-flow/export?companyId=${companyId}&startDate=${startDate}&endDate=${endDate}`}
              download
              className="flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground transition-all hover:bg-accent hover:text-accent-foreground"
            >
              <Download className="size-3 text-muted-foreground" />
              {dt.exportCsv}
            </a>
          )}
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={isLoading}
              className="flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground transition-all hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              <RefreshCw className={`size-3 ${isLoading ? 'animate-spin' : ''}`} />
              {dt.refreshFlow}
            </button>
          )}
        </div>
      </div>

      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {/* Inflows */}
        <motion.div variants={cardVariants}>
          <Card className="relative overflow-hidden border-emerald-500/10 dark:border-emerald-500/5 bg-gradient-to-br from-card to-emerald-500/[0.02]">
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {dt.inflows}
                  </p>
                  <p className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(totalInflows)}
                  </p>
                </div>
                <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400">
                  <ArrowUpRight className="size-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Outflows */}
        <motion.div variants={cardVariants}>
          <Card className="relative overflow-hidden border-rose-500/10 dark:border-rose-500/5 bg-gradient-to-br from-card to-rose-500/[0.02]">
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {dt.outflows}
                  </p>
                  <p className="text-2xl font-bold tracking-tight text-rose-600 dark:text-rose-400">
                    {formatCurrency(totalOutflows)}
                  </p>
                </div>
                <div className="flex size-9 items-center justify-center rounded-lg bg-rose-100 dark:bg-rose-950/50 text-rose-600 dark:text-rose-400">
                  <ArrowDownRight className="size-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Net Flow */}
        <motion.div variants={cardVariants}>
          <Card
            className={`relative overflow-hidden border-primary/10 bg-gradient-to-br from-card to-primary/[0.01]`}
          >
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {dt.netFlow}
                  </p>
                  <p
                    className={`text-2xl font-bold tracking-tight ${netFlow >= 0 ? 'text-primary' : 'text-rose-500'}`}
                  >
                    {formatCurrency(netFlow)}
                  </p>
                </div>
                <div
                  className={`flex size-9 items-center justify-center rounded-lg ${netFlow >= 0 ? 'bg-primary/10 text-primary' : 'bg-rose-100 dark:bg-rose-950/50 text-rose-600'}`}
                >
                  <Layers className="size-4" />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Tx Count */}
        <motion.div variants={cardVariants}>
          <Card className="relative overflow-hidden border-sky-500/10 dark:border-sky-500/5 bg-gradient-to-br from-card to-sky-500/[0.01]">
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {dt.transactions}
                  </p>
                  <p className="text-2xl font-bold tracking-tight text-sky-600 dark:text-sky-400">
                    {transactionCount}
                  </p>
                </div>
                <div className="flex size-9 items-center justify-center rounded-lg bg-sky-100 dark:bg-sky-950/50 text-sky-600 dark:text-sky-400">
                  <Activity className="size-4" />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  );
}
