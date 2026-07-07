'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Download, FileText, RefreshCw } from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { formatCurrency, formatDate } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { itemVariants, type TransactionResponse, type GlAccount } from '@/lib/types/reports';

export function TransactionListingTab({ companyId }: { companyId?: string }) {
  const t = useLanguageStore((s) => s.t);
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [glAccountId, setGlAccountId] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TransactionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [glAccounts, setGlAccounts] = useState<GlAccount[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch GL accounts for filter
  useEffect(() => {
    if (!companyId) return;
    fetch(`/api/journal/accounts?companyId=${companyId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((json) => {
        const list = Array.isArray(json) ? json : (json.data ?? []);
        setGlAccounts(list);
      })
      .catch(() => {});
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({ companyId, startDate, endDate, page: String(page), limit: '25' });
        if (glAccountId) params.set('glAccountId', glAccountId);
        const res = await fetch(`/api/reports/transactions?${params}`);
        if (res.ok && !cancelled) setData(await res.json());
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId, startDate, endDate, glAccountId, page, refreshKey]);

  function handleExport(format: 'csv' | 'pdf') {
    if (!companyId) return;
    const base = format === 'csv' ? '/api/export/csv' : '/api/export/pdf';
    const params = new URLSearchParams({ type: 'transactions', companyId, startDate, endDate });
    if (glAccountId) params.set('glAccountId', glAccountId);
    window.open(`${base}?${params}`, '_blank');
  }

  const flatRows = (data?.data ?? []).flatMap((entry) =>
    entry.lines.map((line) => ({
      entryId: entry.id, entryDate: entry.date, entryRef: entry.reference, entryDesc: entry.description,
      ...line,
    })),
  );

  return (
    <motion.div variants={itemVariants} className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>{t('reports.transactionListing')}</CardTitle>
              <CardDescription>{startDate} — {endDate}</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => handleExport('csv')}>
                <Download className="size-4 mr-1" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleExport('pdf')}>
                <Download className="size-4 mr-1" /> PDF
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Label className="text-sm">{t('reports.from')}</Label>
              <Input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setPage(1); }} className="w-36" />
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-sm">{t('reports.to')}</Label>
              <Input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setPage(1); }} className="w-36" />
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-sm">{t('reports.glAccountFilter')}</Label>
              <Select value={glAccountId} onValueChange={(v) => { setGlAccountId(v === '__all__' ? '' : v); setPage(1); }}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder={t('reports.allAccounts')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t('reports.allAccounts')}</SelectItem>
                  {glAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="font-mono text-teal-600 dark:text-teal-400">{a.code}</span> — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}>
              <RefreshCw className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
              {t('common.refresh')}
            </Button>
          </div>

          {/* Table */}
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (<Skeleton key={i} className="h-8 w-full" />))}
            </div>
          ) : flatRows.length > 0 ? (
            <div className="rounded-md border overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[100px]">{t('common.date')}</TableHead>
                    <TableHead className="w-[100px]">{t('common.reference')}</TableHead>
                    <TableHead>{t('common.description')}</TableHead>
                    <TableHead className="w-[100px]">{t('accounts.accountCode')}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t('accounts.accountName')}</TableHead>
                    <TableHead className="text-right w-[110px]">{t('accounts.debit')}</TableHead>
                    <TableHead className="text-right w-[110px]">{t('accounts.credit')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flatRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap">{formatDate(row.entryDate)}</TableCell>
                      <TableCell className="font-mono text-muted-foreground">{row.entryRef || '—'}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{row.entryDesc}</TableCell>
                      <TableCell className="font-mono text-teal-600 dark:text-teal-400">{row.accountCode}</TableCell>
                      <TableCell className="hidden lg:table-cell max-w-[180px] truncate">{row.accountName}</TableCell>
                      <TableCell className="text-right font-mono">{row.debit > 0 ? formatCurrency(row.debit) : ''}</TableCell>
                      <TableCell className="text-right font-mono">{row.credit > 0 ? formatCurrency(row.credit) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="size-12 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">{t('reports.noData')}</p>
            </div>
          )}

          {/* Pagination */}
          {data && data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {t('reports.showing')} {(data.pagination.page - 1) * data.pagination.limit + 1}–
                {Math.min(data.pagination.page * data.pagination.limit, data.pagination.totalCount)} {t('reports.of')} {data.pagination.totalCount}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  {t('common.previous')}
                </Button>
                <span className="px-3 py-1">{t('reports.page')} {page} {t('reports.of')} {data.pagination.totalPages}</span>
                <Button variant="outline" size="sm" disabled={page >= data.pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
                  {t('common.next')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
