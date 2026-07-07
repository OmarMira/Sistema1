'use client';

import { useState } from 'react';
import {
  Activity,
  RefreshCw,
  Database,
  BookOpen,
  Landmark,
  CreditCard,
  ArrowLeftRight,
  Settings,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Types ───────────────────────────────────────────────────── */

interface DiagnosticsData {
  database: {
    status: string;
    size: string;
    tables: number;
  };
  accounts: {
    total: number;
    active: number;
  };
  journalEntries: {
    total: number;
    posted: number;
    draft: number;
  };
  bankAccounts: {
    total: number;
  };
  bankRules: {
    total: number;
    active: number;
  };
  transactions: {
    total: number;
    reconciled: number;
    unreconciled: number;
  };
  system: {
    uptime: string;
    version: string;
  };
}

/* ─── Stat Card ───────────────────────────────────────────────── */

function StatCard({
  icon: Icon,
  iconColor,
  label,
  value,
  subValue,
}: {
  icon: React.ElementType;
  iconColor: string;
  label: string;
  value: string | number;
  subValue?: string;
}) {
  return (
    <div className="rounded-lg border p-4 flex items-start gap-3">
      <div className={`flex items-center justify-center size-9 rounded-lg ${iconColor}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-bold">{value}</p>
        {subValue && <p className="text-xs text-muted-foreground">{subValue}</p>}
      </div>
    </div>
  );
}

/* ─── DiagnosticsTab ─────────────────────────────────────────── */

export function DiagnosticsTab() {
  const t = useLanguageStore((s) => s.t);

  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDiagnostic() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/diagnostics');
      if (res.ok) {
        const result = await res.json();
        setData(result);
      } else {
        setError(t('common.error'));
      }
    } catch {
      setError(t('common.error'));
    }
    setLoading(false);
  }

  const hasData = !!data;
  const allChecksPassed = hasData && data.database.status === 'connected';

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Activity className="size-5" />
              {t('settings.diag.title')}
            </h2>
          </div>
          <Button onClick={runDiagnostic} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="size-4 mr-1 animate-spin" />
                {t('settings.diag.running')}
              </>
            ) : (
              <>
                <RefreshCw className="size-4 mr-1" />
                {t('settings.diag.runDiagnostic')}
              </>
            )}
          </Button>
        </div>
      </motion.div>

      {/* Status Banner */}
      {hasData && (
        <motion.div variants={itemVariants}>
          <div
            className={`rounded-lg border p-4 flex items-center gap-3 ${
              allChecksPassed
                ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
                : 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
            }`}
          >
            {allChecksPassed ? (
              <CheckCircle2 className="size-5 text-emerald-500 shrink-0" />
            ) : (
              <AlertTriangle className="size-5 text-amber-500 shrink-0" />
            )}
            <p
              className={`text-sm ${
                allChecksPassed
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-amber-700 dark:text-amber-300'
              }`}
            >
              {allChecksPassed
                ? t('settings.diag.allChecksPassed')
                : t('settings.diag.issuesFound').replace('{count}', '1')}
            </p>
          </div>
        </motion.div>
      )}

      {/* Error */}
      {error && (
        <motion.div variants={itemVariants}>
          <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30 p-4 flex items-center gap-3">
            <AlertTriangle className="size-5 text-rose-500 shrink-0" />
            <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>
          </div>
        </motion.div>
      )}

      {/* Stats Grid */}
      {hasData && (
        <motion.div variants={itemVariants}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              icon={Database}
              iconColor="bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
              label={t('settings.diag.database')}
              value={
                data.database.status === 'connected'
                  ? t('settings.diag.connected')
                  : data.database.status
              }
              subValue={`${t('settings.diag.size')}: ${data.database.size} · ${data.database.tables} ${t('settings.diag.tables')}`}
            />
            <StatCard
              icon={BookOpen}
              iconColor="bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400"
              label={t('settings.diag.accounts')}
              value={data.accounts.total}
              subValue={`${data.accounts.active} ${t('settings.diag.active')}`}
            />
            <StatCard
              icon={Settings}
              iconColor="bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
              label={t('settings.diag.journalEntries')}
              value={data.journalEntries.total}
              subValue={`${data.journalEntries.posted} ${t('settings.diag.posted')} · ${data.journalEntries.draft} ${t('settings.diag.draft')}`}
            />
            <StatCard
              icon={Landmark}
              iconColor="bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
              label={t('settings.diag.bankAccounts')}
              value={data.bankAccounts.total}
              subValue={t('settings.diag.total')}
            />
            <StatCard
              icon={CreditCard}
              iconColor="bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400"
              label={t('settings.diag.bankRules')}
              value={data.bankRules.total}
              subValue={`${data.bankRules.active} ${t('settings.diag.active')}`}
            />
            <StatCard
              icon={ArrowLeftRight}
              iconColor="bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400"
              label={t('settings.diag.transactions')}
              value={data.transactions.total}
              subValue={`${data.transactions.reconciled} ${t('settings.diag.reconciled')} · ${data.transactions.unreconciled} ${t('settings.diag.unreconciled')}`}
            />
          </div>
        </motion.div>
      )}

      {/* System Info */}
      {hasData && (
        <motion.div variants={itemVariants}>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('settings.diag.system')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">{t('settings.diag.uptime')}</p>
                  <p className="text-lg font-bold">{data.system.uptime}</p>
                </div>
                <div className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">{t('settings.diag.version')}</p>
                  <p className="text-lg font-bold">{data.system.version}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Empty State (initial) */}
      {!hasData && !loading && !error && (
        <motion.div variants={itemVariants} className="text-center py-16">
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center justify-center size-16 rounded-full bg-muted">
              <Activity className="size-8 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{t('settings.diag.runDiagnostic')}</p>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
