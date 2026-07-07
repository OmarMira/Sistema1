'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Filter, AlertCircle } from 'lucide-react';
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
} from 'recharts';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { formatCurrency } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { MovementSummaryCards } from '@/components/reports/MovementSummaryCards';
import { RecentMovementsTable } from '@/components/reports/RecentMovementsTable';
import { ByAccountTable } from '@/components/reports/ByAccountTable';
import {
  containerVariants,
  itemVariants,
  CustomChartTooltip,
  type MovementSummaryResponse,
  type GlAccount,
} from '@/lib/types/movement-summary';

/* ─── Main Component ──────────────────────────────────────────── */

export function MovementSummaryPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [datesInitialized, setDatesInitialized] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [data, setData] = useState<MovementSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);

  // Fetch date boundaries for the company transactions
  useEffect(() => {
    if (!activeCompany?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/movement-summary?companyId=${activeCompany.id}&rangeOnly=true`);
        if (res.ok && !cancelled) {
          const json = await res.json();
          // Fallback to current month if there are no transactions
          const today = new Date();
          const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
          const defaultFrom = firstOfMonth.toISOString().split('T')[0];
          const defaultTo = today.toISOString().split('T')[0];

          setFromDate(json.minDate || defaultFrom);
          setToDate(json.maxDate || defaultTo);
          setDatesInitialized(true);
        }
      } catch {
        const today = new Date();
        const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        setFromDate(firstOfMonth.toISOString().split('T')[0]);
        setToDate(today.toISOString().split('T')[0]);
        setDatesInitialized(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCompany?.id]);

  // Fetch GL accounts for the dropdown
  useEffect(() => {
    if (!activeCompany?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/journal/accounts?companyId=${activeCompany.id}`);
        if (res.ok && !cancelled) {
          const json = await res.json();
          const list: GlAccount[] = Array.isArray(json) ? json : (json.data ?? []);
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
    if (!activeCompany?.id || !datesInitialized) return;
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
          <h1 className="text-2xl font-bold tracking-tight">{t('movementSummary.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('movementSummary.subtitle')}</p>
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
                <Label className="text-sm whitespace-nowrap">{t('movementSummary.fromDate')}</Label>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-sm whitespace-nowrap">{t('movementSummary.toDate')}</Label>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-sm whitespace-nowrap">{t('movementSummary.account')}</Label>
                <Select value={accountId || '__all__'} onValueChange={setAccountId}>
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder={t('movementSummary.allAccounts')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">{t('movementSummary.allAccounts')}</SelectItem>
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
                onClick={() => {
                  setRefreshKey((k) => k + 1);
                }}
                disabled={loading}
              >
                <RefreshCw className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                {t('common.filter')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <MovementSummaryCards data={data} loading={loading} />

      {/* Two-column: Recent Movements + Chart */}
      <motion.div variants={itemVariants} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <RecentMovementsTable data={data} loading={loading} />

        {/* By Account Type Chart (1/3 width) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('movementSummary.byType')}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-64 w-full" />
            ) : chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    className="fill-muted-foreground"
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`
                    }
                  />
                  <Tooltip content={<CustomChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey={t('movementSummary.debit')} fill="#0891b2" radius={[4, 4, 0, 0]} />
                  <Bar dataKey={t('movementSummary.credit')} fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Filter className="size-12 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground">{t('movementSummary.noData')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <ByAccountTable data={data} loading={loading} />
    </motion.div>
  );
}
