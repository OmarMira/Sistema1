'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeftRight, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { formatCurrency, formatDate } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { itemVariants, type ReconciliationResponse, type BankAccount } from '@/lib/types/reports';

export function ReconciliationTab({ companyId }: { companyId?: string }) {
  const t = useLanguageStore((s) => s.t);
  const [bankAccountId, setBankAccountId] = useState('');
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [data, setData] = useState<ReconciliationResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch bank accounts
  useEffect(() => {
    if (!companyId) return;
    fetch(`/api/dashboard?companyId=${companyId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((dash) => { if (dash?.bankAccounts) setBankAccounts(dash.bankAccounts); })
      .catch(() => {});
  }, [companyId]);

  useEffect(() => {
    if (!companyId || !bankAccountId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/reports/reconciliation?bankAccountId=${bankAccountId}`);
        if (res.ok && !cancelled) setData(await res.json());
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId, bankAccountId]);

  function handleExport(format: 'csv' | 'pdf') {
    if (!companyId || !bankAccountId) return;
    const base = format === 'csv' ? '/api/export/csv' : '/api/export/pdf';
    const params = new URLSearchParams({ type: 'reconciliation', companyId, bankAccountId });
    window.open(`${base}?${params}`, '_blank');
  }

  return (
    <motion.div variants={itemVariants} className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>{t('reports.reconciliationSummary')}</CardTitle>
              <CardDescription>{t('reports.selectBankAccount')}</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={bankAccountId} onValueChange={setBankAccountId}>
                <SelectTrigger className="w-56">
                  <SelectValue placeholder={t('reports.selectBankAccount')} />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((ba) => (
                    <SelectItem key={ba.id} value={ba.id}>{ba.accountName} — {ba.bankName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => handleExport('csv')} disabled={!bankAccountId}>
                <Download className="size-4 mr-1" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleExport('pdf')} disabled={!bankAccountId}>
                <Download className="size-4 mr-1" /> PDF
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!bankAccountId ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <ArrowLeftRight className="size-12 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">{t('reports.selectBankAccount')}</p>
            </div>
          ) : loading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (<Skeleton key={i} className="h-8 w-full" />))}
            </div>
          ) : data ? (
            <div className="space-y-6">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Card className="border-teal-200 dark:border-teal-800">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground">{t('reports.totalTransactions')}</p>
                    <p className="text-2xl font-bold text-teal-600 dark:text-teal-400">{data.summary.totalTransactions}</p>
                  </CardContent>
                </Card>
                <Card className="border-emerald-200 dark:border-emerald-800">
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-1">
                      <CheckCircle2 className="size-4 text-emerald-500" />
                      <p className="text-xs text-muted-foreground">{t('reports.reconciledCount')}</p>
                    </div>
                    <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{data.summary.reconciledCount}</p>
                    <p className="text-xs text-muted-foreground">{formatCurrency(data.summary.reconciledTotal)}</p>
                  </CardContent>
                </Card>
                <Card className="border-amber-200 dark:border-amber-800">
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-1">
                      <AlertTriangle className="size-4 text-amber-500" />
                      <p className="text-xs text-muted-foreground">{t('reports.unreconciledCount')}</p>
                    </div>
                    <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{data.summary.unreconciledCount}</p>
                    <p className="text-xs text-muted-foreground">{formatCurrency(data.summary.unreconciledTotal)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground">{t('reports.reconciledPercentage')}</p>
                    <p className="text-2xl font-bold">{data.summary.reconciledPercentage}%</p>
                  </CardContent>
                </Card>
              </div>

              {/* Unreconciled Transactions */}
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <AlertTriangle className="size-4 text-amber-500" />
                  {t('reports.unreconciledCount')} ({data.unreconciledTransactions.length})
                </h3>
                {data.unreconciledTransactions.length > 0 ? (
                  <div className="rounded-md border overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[100px]">{t('common.date')}</TableHead>
                          <TableHead>{t('common.description')}</TableHead>
                          <TableHead className="text-right w-[110px]">{t('common.amount')}</TableHead>
                          <TableHead className="w-[100px]">{t('common.reference')}</TableHead>
                          <TableHead className="hidden md:table-cell">{t('journal.account')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.unreconciledTransactions.map((tx) => (
                          <TableRow key={tx.id}>
                            <TableCell className="whitespace-nowrap">{formatDate(tx.date)}</TableCell>
                            <TableCell className="max-w-[250px] truncate">{tx.description}</TableCell>
                            <TableCell className={`text-right font-mono ${tx.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                              {formatCurrency(tx.amount)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{tx.reference || '—'}</TableCell>
                            <TableCell className="hidden md:table-cell text-muted-foreground">
                              {tx.glAccount ? (
                                <span><span className="font-mono text-teal-600 dark:text-teal-400">{tx.glAccount.code}</span> — {tx.glAccount.name}</span>
                              ) : '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    <CheckCircle2 className="inline size-4 text-emerald-500 mr-1" />
                    All transactions reconciled!
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <ArrowLeftRight className="size-12 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">{t('reports.noReconciledData')}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
