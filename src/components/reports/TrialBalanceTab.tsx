'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart3, Download, Printer, RefreshCw,
} from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { formatCurrency, formatDate } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableFooter,
} from '@/components/ui/table';
import { itemVariants, type TrialBalanceResponse, accountTypeColor } from '@/lib/types/reports';

export function TrialBalanceTab({ companyId }: { companyId?: string }) {
  const t = useLanguageStore((s) => s.t);
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [data, setData] = useState<TrialBalanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const params = new URLSearchParams({ companyId, asOfDate });
        const res = await fetch(`/api/reports/trial-balance?${params}`);
        if (res.ok && !cancelled) setData(await res.json());
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId, asOfDate, refreshKey]);

  function handleExport(format: 'csv' | 'pdf') {
    if (!companyId) return;
    const url =
      format === 'csv'
        ? `/api/export/csv?type=trial_balance&companyId=${companyId}&asOfDate=${asOfDate}`
        : `/api/export/pdf?type=trial_balance&companyId=${companyId}&asOfDate=${asOfDate}`;
    window.open(url, '_blank');
  }

  function handlePrint() { window.print(); }

  return (
    <motion.div variants={itemVariants} className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>{t('reports.trialBalance')}</CardTitle>
              <CardDescription>{t('reports.asOf')}: {formatDate(asOfDate)}</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="asOfDate" className="whitespace-nowrap text-sm">{t('reports.asOfDate')}</Label>
                <Input id="asOfDate" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="w-40" />
              </div>
              <Button variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}>
                <RefreshCw className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                {t('common.refresh')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleExport('csv')}>
                <Download className="size-4 mr-1" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleExport('pdf')}>
                <Download className="size-4 mr-1" /> PDF
              </Button>
              <Button variant="outline" size="sm" onClick={handlePrint}>
                <Printer className="size-4 mr-1" /> {t('reports.print')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (<Skeleton key={i} className="h-8 w-full" />))}
            </div>
          ) : data && data.accounts.length > 0 ? (
            <div className="rounded-md border overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">{t('reports.accountCode')}</TableHead>
                    <TableHead>{t('reports.accountName')}</TableHead>
                    <TableHead>{t('reports.accountType')}</TableHead>
                    <TableHead className="text-right">{t('reports.debit')}</TableHead>
                    <TableHead className="text-right">{t('reports.credit')}</TableHead>
                    <TableHead className="text-right">{t('reports.netBalance')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.accounts.map((acc) => (
                    <TableRow key={acc.code}>
                      <TableCell className="font-mono text-teal-600 dark:text-teal-400">{acc.code}</TableCell>
                      <TableCell className="font-medium">{acc.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className={accountTypeColor(acc.accountType)}>
                          {t(`accounts.${acc.accountType}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{acc.debit > 0 ? formatCurrency(acc.debit) : '—'}</TableCell>
                      <TableCell className="text-right font-mono">{acc.credit > 0 ? formatCurrency(acc.credit) : '—'}</TableCell>
                      <TableCell className={`text-right font-mono font-semibold ${acc.balance >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                        {formatCurrency(acc.balance)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow className="bg-teal-50/50 dark:bg-teal-950/20">
                    <TableCell colSpan={3} className="font-bold">{t('common.total')}</TableCell>
                    <TableCell className="text-right font-mono font-bold">{formatCurrency(data.totalDebits)}</TableCell>
                    <TableCell className="text-right font-mono font-bold">{formatCurrency(data.totalCredits)}</TableCell>
                    <TableCell className="text-right font-mono font-bold">{formatCurrency(data.totalDebits - data.totalCredits)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <BarChart3 className="size-12 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">{t('reports.noData')}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
