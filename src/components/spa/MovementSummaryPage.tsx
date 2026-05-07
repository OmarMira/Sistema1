'use client';

import { useState, useEffect } from 'react';
import {
  TrendingUp,
  TrendingDown,
  ArrowUpDown,
  Receipt,
  Filter,
  RefreshCw,
  Activity,
  AlertCircle,
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from 'recharts';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { formatCurrency, formatDate } from '@/lib/format';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableFooter,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

/* ─── Types ───────────────────────────────────────────────────── */

interface MovementSummary {
  totalDebits: number;
  totalCredits: number;
  netMovement: number;
  transactionCount: number;
}

interface ByAccount {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  debits: number;
  credits: number;
  net: number;
}

interface ByType {
  type: string;
  debits: number;
  credits: number;
  net: number;
}

interface RecentMovement {
  id: string;
  date: string;
  description: string;
  debit: number;
  credit: number;
  account: string;
  reference: string;
}

interface MovementSummaryResponse {
  summary: MovementSummary;
  byAccount: ByAccount[];
  byType: ByType[];
  recentMovements: RecentMovement[];
}

interface GlAccount {
  id: string;
  code: string;
  name: string;
}

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Chart Colors ────────────────────────────────────────────── */

const TYPE_COLORS: Record<string, { debit: string; credit: string }> = {
  asset: { debit: '#0891b2', credit: '#06b6d4' },
  liability: { debit: '#d97706', credit: '#f59e0b' },
  equity: { debit: '#7c3aed', credit: '#8b5cf6' },
  revenue: { debit: '#059669', credit: '#10b981' },
  expense: { debit: '#dc2626', credit: '#ef4444' },
};

const TYPE_CHART_COLORS = ['#0891b2', '#d97706', '#7c3aed', '#059669', '#dc2626'];

function accountTypeColor(type: string): string {
  switch (type) {
    case 'asset': return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400';
    case 'liability': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    case 'equity': return 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400';
    case 'revenue': return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
    case 'expense': return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400';
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400';
  }
}

/* ─── Custom Tooltip for Chart ────────────────────────────────── */

function CustomChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const t = useLanguageStore.getState().t;
  return (
    <div className="rounded-lg border bg-background p-3 shadow-md">
      <p className="text-sm font-semibold mb-1">{label}</p>
      {payload.map((entry, index) => (
        <p key={index} className="text-xs" style={{ color: entry.color }}>
          {entry.name}: {formatCurrency(entry.value)}
        </p>
      ))}
    </div>
  );
}

/* ─── Main Component ──────────────────────────────────────────── */

export function MovementSummaryPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  // Date defaults: current month
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const defaultFrom = firstOfMonth.toISOString().split('T')[0];
  const defaultTo = today.toISOString().split('T')[0];

  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [accountId, setAccountId] = useState('');
  const [data, setData] = useState<MovementSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);

  // Fetch GL accounts for the dropdown
  useEffect(() => {
    if (!activeCompany?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/journal/accounts?companyId=${activeCompany.id}`
        );
        if (res.ok && !cancelled) {
          const json = await res.json();
          const list: GlAccount[] = Array.isArray(json) ? json : json.data ?? [];
          setGlAccounts(list);
        }
      } catch {
        // non-critical – dropdown will just be empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCompany?.id]);

  // Fetch summary data
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!activeCompany?.id) return;
    const controller = new AbortController();

    const doFetch = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          companyId: activeCompany.id,
          fromDate,
          toDate,
        });
        if (accountId && accountId !== '__all__') {
          params.set('accountId', accountId);
        }
        const res = await fetch(`/api/movement-summary?${params}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          if (res.ok) {
            const json = await res.json();
            if (json.error) {
              setError(json.error);
              setData(null);
            } else {
              setData(json);
            }
          } else {
            setError(t('common.error'));
            setData(null);
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : t('common.error'));
          setData(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void doFetch();
    return () => controller.abort();
  }, [activeCompany?.id, fromDate, toDate, accountId, refreshKey, t]);

  // Chart data: by type
  const chartData = (data?.byType ?? []).map((item) => ({
    name: t(`accounts.${item.type}`),
    [t('movementSummary.debit')]: item.debits,
    [t('movementSummary.credit')]: item.credits,
    type: item.type,
  }));

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t('movementSummary.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('movementSummary.subtitle')}
          </p>
        </div>
      </motion.div>

      {/* Error Banner */}
      {error && (
        <motion.div variants={itemVariants}>
          <div className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <AlertCircle className="size-5 text-destructive shrink-0" />
            <p className="text-sm text-destructive">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto shrink-0"
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              <RefreshCw className="size-3 mr-1" />
              {t('common.retry')}
            </Button>
          </div>
        </motion.div>
      )}

      {/* Filters Row */}
      <motion.div variants={itemVariants}>
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:flex-wrap">
              <div className="flex items-center gap-2">
                <Label className="text-sm whitespace-nowrap">
                  {t('movementSummary.fromDate')}
                </Label>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-sm whitespace-nowrap">
                  {t('movementSummary.toDate')}
                </Label>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-sm whitespace-nowrap">
                  {t('movementSummary.account')}
                </Label>
                <Select
                  value={accountId || '__all__'}
                  onValueChange={setAccountId}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder={t('movementSummary.allAccounts')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">
                      {t('movementSummary.allAccounts')}
                    </SelectItem>
                    {glAccounts.map((acc) => (
                      <SelectItem key={acc.id} value={acc.id}>
                        <span className="font-mono text-teal-600 dark:text-teal-400">
                          {acc.code}
                        </span>{' '}
                        — {acc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setRefreshKey((k) => k + 1); }}
                disabled={loading}
              >
                <RefreshCw
                  className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`}
                />
                {t('common.filter')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Summary Cards */}
      <motion.div
        variants={itemVariants}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {/* Total Debits */}
        <Card className="border-emerald-200 dark:border-emerald-800">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                <TrendingUp className="size-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('movementSummary.totalDebits')}
              </p>
            </div>
            {loading ? (
              <Skeleton className="h-8 w-32 mt-1" />
            ) : (
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                {formatCurrency(data?.summary.totalDebits ?? 0)}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Total Credits */}
        <Card className="border-amber-200 dark:border-amber-800">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex size-8 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <TrendingDown className="size-4 text-amber-600 dark:text-amber-400" />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('movementSummary.totalCredits')}
              </p>
            </div>
            {loading ? (
              <Skeleton className="h-8 w-32 mt-1" />
            ) : (
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                {formatCurrency(data?.summary.totalCredits ?? 0)}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Net Movement */}
        <Card className="border-teal-200 dark:border-teal-800">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex size-8 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-900/30">
                <ArrowUpDown className="size-4 text-teal-600 dark:text-teal-400" />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('movementSummary.netMovement')}
              </p>
            </div>
            {loading ? (
              <Skeleton className="h-8 w-32 mt-1" />
            ) : (
              <p
                className={`text-2xl font-bold ${
                  (data?.summary.netMovement ?? 0) >= 0
                    ? 'text-teal-600 dark:text-teal-400'
                    : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                {formatCurrency(data?.summary.netMovement ?? 0)}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Total Transactions */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex size-8 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
                <Receipt className="size-4 text-gray-600 dark:text-gray-400" />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('movementSummary.totalTransactions')}
              </p>
            </div>
            {loading ? (
              <Skeleton className="h-8 w-32 mt-1" />
            ) : (
              <p className="text-2xl font-bold">
                {data?.summary.transactionCount ?? 0}
              </p>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Two-column: Recent Movements + Chart */}
      <motion.div
        variants={itemVariants}
        className="grid grid-cols-1 gap-6 lg:grid-cols-3"
      >
        {/* Recent Movements Table (2/3 width) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="size-4" />
              {t('movementSummary.recentMovements')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : data && data.recentMovements.length > 0 ? (
              <div className="rounded-md border overflow-auto max-h-96">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">
                        {t('common.date')}
                      </TableHead>
                      <TableHead>{t('common.description')}</TableHead>
                      <TableHead className="hidden md:table-cell">
                        {t('movementSummary.account')}
                      </TableHead>
                      <TableHead className="text-right w-[110px]">
                        {t('movementSummary.debit')}
                      </TableHead>
                      <TableHead className="text-right w-[110px]">
                        {t('movementSummary.credit')}
                      </TableHead>
                      <TableHead className="hidden sm:table-cell w-[100px]">
                        {t('common.reference')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.recentMovements.map((mv) => (
                      <TableRow key={`${mv.id}-${mv.account}`}>
                        <TableCell className="whitespace-nowrap">
                          {formatDate(mv.date)}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate">
                          {mv.description}
                        </TableCell>
                        <TableCell className="hidden md:table-cell font-mono text-teal-600 dark:text-teal-400 text-xs">
                          {mv.account}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {mv.debit > 0
                            ? formatCurrency(mv.debit)
                            : ''}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {mv.credit > 0
                            ? formatCurrency(mv.credit)
                            : ''}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-muted-foreground text-xs">
                          {mv.reference || '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Filter className="size-12 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground">
                  {t('movementSummary.noData')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* By Account Type Chart (1/3 width) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t('movementSummary.byType')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart
                  data={chartData}
                  margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    className="fill-muted-foreground"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    className="fill-muted-foreground"
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
                    }
                  />
                  <Tooltip content={<CustomChartTooltip />} />
                  <Legend
                    wrapperStyle={{ fontSize: 12 }}
                  />
                  <Bar
                    dataKey={t('movementSummary.debit')}
                    fill="#0891b2"
                    radius={[4, 4, 0, 0]}
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`debit-${index}`}
                        fill={TYPE_COLORS[entry.type]?.debit ?? TYPE_CHART_COLORS[index % TYPE_CHART_COLORS.length]}
                      />
                    ))}
                  </Bar>
                  <Bar
                    dataKey={t('movementSummary.credit')}
                    fill="#f59e0b"
                    radius={[4, 4, 0, 0]}
                  >
                    {chartData.map((entry, index) => (
                      <Cell
                        key={`credit-${index}`}
                        fill={TYPE_COLORS[entry.type]?.credit ?? TYPE_CHART_COLORS[index % TYPE_CHART_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Filter className="size-12 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground">
                  {t('movementSummary.noData')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Detailed Table by Account */}
      <motion.div variants={itemVariants}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t('movementSummary.byAccount')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : data && data.byAccount.length > 0 ? (
              <div className="rounded-md border overflow-auto max-h-96">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">
                        {t('accounts.accountCode')}
                      </TableHead>
                      <TableHead>{t('accounts.accountName')}</TableHead>
                      <TableHead className="w-[110px]">
                        {t('accounts.accountType')}
                      </TableHead>
                      <TableHead className="text-right w-[120px]">
                        {t('movementSummary.debit')}
                      </TableHead>
                      <TableHead className="text-right w-[120px]">
                        {t('movementSummary.credit')}
                      </TableHead>
                      <TableHead className="text-right w-[120px]">
                        {t('movementSummary.netMovement')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byAccount.map((acc) => (
                      <TableRow key={acc.accountId}>
                        <TableCell className="font-mono text-teal-600 dark:text-teal-400">
                          {acc.accountCode}
                        </TableCell>
                        <TableCell className="font-medium">
                          {acc.accountName}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={accountTypeColor(acc.accountType)}
                          >
                            {t(`accounts.${acc.accountType}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {acc.debits > 0 ? formatCurrency(acc.debits) : '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {acc.credits > 0 ? formatCurrency(acc.credits) : '—'}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono font-semibold ${
                            acc.net >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {formatCurrency(acc.net)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow className="bg-teal-50/50 dark:bg-teal-950/20">
                      <TableCell colSpan={3} className="font-bold">
                        {t('common.total')}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {formatCurrency(data?.summary.totalDebits ?? 0)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {formatCurrency(data?.summary.totalCredits ?? 0)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {formatCurrency(data?.summary.netMovement ?? 0)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Filter className="size-12 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground">
                  {t('movementSummary.noData')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
