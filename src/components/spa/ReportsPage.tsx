'use client';

import { useState, useEffect } from 'react';
import {
  BarChart3,
  FileText,
  ArrowLeftRight,
  Download,
  Printer,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { formatCurrency, formatDate } from '@/lib/format';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Card,
  CardContent,
  CardDescription,
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

interface TrialBalanceAccount {
  code: string;
  name: string;
  accountType: string;
  debit: number;
  credit: number;
  balance: number;
}

interface TrialBalanceResponse {
  accounts: TrialBalanceAccount[];
  totalDebits: number;
  totalCredits: number;
  asOfDate: string;
}

interface TransactionEntry {
  id: string;
  date: string;
  description: string;
  reference: string | null;
  status: string;
  lines: {
    id: string;
    glAccountId: string;
    accountCode: string;
    accountName: string;
    accountType: string;
    description: string | null;
    debit: number;
    credit: number;
  }[];
  _totalDebit: number;
  _totalCredit: number;
}

interface TransactionResponse {
  data: TransactionEntry[];
  pagination: { page: number; limit: number; totalCount: number; totalPages: number };
}

interface ReconTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  glAccount: { id: string; code: string; name: string } | null;
}

interface ReconciliationResponse {
  bankAccount: { id: string; accountName: string; bankName: string; balance: number; currency: string };
  summary: {
    totalTransactions: number;
    reconciledCount: number;
    unreconciledCount: number;
    reconciledTotal: number;
    unreconciledTotal: number;
    reconciledPercentage: number;
  };
  reconciledTransactions: ReconTransaction[];
  unreconciledTransactions: ReconTransaction[];
}

interface GlAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
}

interface BankAccount {
  id: string;
  accountName: string;
  bankName: string;
}

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Account Type Colors ─────────────────────────────────────── */

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

/* ─── Reports Page ────────────────────────────────────────────── */

export function ReportsPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('reports.title')}</h1>
        </div>
      </motion.div>

      <Tabs defaultValue="trial-balance" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 lg:w-auto lg:inline-grid lg:grid-cols-3">
          <TabsTrigger value="trial-balance" className="gap-1.5">
            <BarChart3 className="size-4" />
            <span className="hidden sm:inline">{t('reports.trialBalance')}</span>
          </TabsTrigger>
          <TabsTrigger value="transactions" className="gap-1.5">
            <FileText className="size-4" />
            <span className="hidden sm:inline">{t('reports.transactionListing')}</span>
          </TabsTrigger>
          <TabsTrigger value="reconciliation" className="gap-1.5">
            <ArrowLeftRight className="size-4" />
            <span className="hidden sm:inline">{t('reports.reconciliationSummary')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="trial-balance">
          <TrialBalanceTab companyId={activeCompany?.id} />
        </TabsContent>
        <TabsContent value="transactions">
          <TransactionListingTab companyId={activeCompany?.id} />
        </TabsContent>
        <TabsContent value="reconciliation">
          <ReconciliationTab companyId={activeCompany?.id} />
        </TabsContent>
      </Tabs>
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   TAB 1: Trial Balance
   ═══════════════════════════════════════════════════════════════ */

function TrialBalanceTab({ companyId }: { companyId?: string }) {
  const t = useLanguageStore((s) => s.t);
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [data, setData] = useState<TrialBalanceResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  }, [companyId, asOfDate]);

  function handleExport(format: 'csv' | 'pdf') {
    if (!companyId) return;
    const url =
      format === 'csv'
        ? `/api/export/csv?type=trial_balance&companyId=${companyId}&asOfDate=${asOfDate}`
        : `/api/export/pdf?type=trial_balance&companyId=${companyId}&asOfDate=${asOfDate}`;
    window.open(url, '_blank');
  }

  function handlePrint() {
    window.print();
  }

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
                <Input
                  id="asOfDate"
                  type="date"
                  value={asOfDate}
                  onChange={(e) => setAsOfDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <Button variant="outline" size="sm" onClick={fetchReport} disabled={loading}>
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
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
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
                      <TableCell className="text-right font-mono">
                        {acc.debit > 0 ? formatCurrency(acc.debit) : '—'}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {acc.credit > 0 ? formatCurrency(acc.credit) : '—'}
                      </TableCell>
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
                    <TableCell className="text-right font-mono font-bold">
                      {formatCurrency(data.totalDebits - data.totalCredits)}
                    </TableCell>
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

/* ═══════════════════════════════════════════════════════════════
   TAB 2: Transaction Listing
   ═══════════════════════════════════════════════════════════════ */

function TransactionListingTab({ companyId }: { companyId?: string }) {
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

  // Fetch GL accounts for filter
  useEffect(() => {
    if (!companyId) return;
    fetch(`/api/journal/accounts?companyId=${companyId}`)
      .then((r) => r.ok ? r.json() : [])
      .then((accounts) => setGlAccounts(accounts))
      .catch(() => {});
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams({
          companyId,
          startDate,
          endDate,
          page: String(page),
          limit: '25',
        });
        if (glAccountId) params.set('glAccountId', glAccountId);
        const res = await fetch(`/api/reports/transactions?${params}`);
        if (res.ok && !cancelled) setData(await res.json());
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId, startDate, endDate, glAccountId, page]);

  function handleExport(format: 'csv' | 'pdf') {
    if (!companyId) return;
    const base = format === 'csv' ? '/api/export/csv' : '/api/export/pdf';
    const params = new URLSearchParams({
      type: 'transactions',
      companyId,
      startDate,
      endDate,
    });
    if (glAccountId) params.set('glAccountId', glAccountId);
    window.open(`${base}?${params}`, '_blank');
  }

  // Flatten entries for display
  const flatRows = (data?.data ?? []).flatMap((entry) =>
    entry.lines.map((line) => ({
      entryId: entry.id,
      entryDate: entry.date,
      entryRef: entry.reference,
      entryDesc: entry.description,
      ...line,
    }))
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
            <Button variant="outline" size="sm" onClick={fetchReport} disabled={loading}>
              <RefreshCw className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
              {t('common.refresh')}
            </Button>
          </div>

          {/* Table */}
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
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
                      <TableCell className="text-right font-mono">
                        {row.debit > 0 ? formatCurrency(row.debit) : ''}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.credit > 0 ? formatCurrency(row.credit) : ''}
                      </TableCell>
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
                {t('reports.showing')} {((data.pagination.page - 1) * data.pagination.limit) + 1}–
                {Math.min(data.pagination.page * data.pagination.limit, data.pagination.totalCount)}{' '}
                {t('reports.of')} {data.pagination.totalCount}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline" size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {t('common.previous')}
                </Button>
                <span className="px-3 py-1">
                  {t('reports.page')} {page} {t('reports.of')} {data.pagination.totalPages}
                </span>
                <Button
                  variant="outline" size="sm"
                  disabled={page >= data.pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
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

/* ═══════════════════════════════════════════════════════════════
   TAB 3: Reconciliation Summary
   ═══════════════════════════════════════════════════════════════ */

function ReconciliationTab({ companyId }: { companyId?: string }) {
  const t = useLanguageStore((s) => s.t);
  const [bankAccountId, setBankAccountId] = useState('');
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [data, setData] = useState<ReconciliationResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch bank accounts
  useEffect(() => {
    if (!companyId) return;
    fetch(`/api/dashboard?companyId=${companyId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((dash) => {
        if (dash?.bankAccounts) setBankAccounts(dash.bankAccounts);
      })
      .catch(() => {});
  }, [companyId]);

  useEffect(() => {
    if (!companyId || !bankAccountId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
                    <SelectItem key={ba.id} value={ba.id}>
                      {ba.accountName} — {ba.bankName}
                    </SelectItem>
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
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
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
                                <span>
                                  <span className="font-mono text-teal-600 dark:text-teal-400">{tx.glAccount.code}</span>{' '}
                                  — {tx.glAccount.name}
                                </span>
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
