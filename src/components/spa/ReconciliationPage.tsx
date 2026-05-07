'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  Download,
  Loader2,
  Landmark,
  Play,
  AlertTriangle,
  Search,
  Undo2,
  PlusCircle,
  FileText,
  Calendar,
  Filter,
  History,
  BookOpen,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';
import { toast } from 'sonner';

/* ─── Types ─── */
interface BankAccountOption {
  id: string;
  accountName: string;
  bankName: string;
}

interface StatementOption {
  id: string;
  startDate: string;
  endDate: string;
  openingBalance: number;
  closingBalance: number;
  format: string;
  fileName: string | null;
}

interface GlAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
}

interface Transaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  glAccountId: string | null;
  glAccount: { id: string; code: string; name: string } | null;
  matchedRule: { id: string; name: string } | null;
  reconciledAt: string | null;
  createdAt: string;
}

interface ReconciliationSummary {
  statementBalance: number;
  bookBalance: number;
  difference: number;
  totalTransactions: number;
  reconciledCount: number;
  unreconciledCount: number;
  depositsTotal: number;
  paymentsTotal: number;
  filteredCount: number;
}

interface BankAccountInfo {
  id: string;
  accountName: string;
  bankName: string;
  balance: number;
  currency: string;
  glAccount: GlAccount;
}

interface ReconPeriod {
  id: string;
  bankAccountId: string;
  userId: string;
  statementBalance: number;
  bookBalance: number;
  difference: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  transactionCount: number;
  notes: string | null;
  user?: { firstName: string; lastName: string };
}

/* ─── Component ─── */
export function ReconciliationPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  // Bank account selector
  const [bankAccounts, setBankAccounts] = useState<BankAccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');

  // Data
  const [bankAccountInfo, setBankAccountInfo] = useState<BankAccountInfo | null>(null);
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [deposits, setDeposits] = useState<Transaction[]>([]);
  const [payments, setPayments] = useState<Transaction[]>([]);
  const [statements, setStatements] = useState<StatementOption[]>([]);
  const [accounts, setAccounts] = useState<GlAccountOption[]>([]);
  const [openPeriod, setOpenPeriod] = useState<ReconPeriod | null>(null);
  const [recentPeriods, setRecentPeriods] = useState<ReconPeriod[]>([]);

  // Loading
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingData, setLoadingData] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState<'unreconciled' | 'reconciled' | 'all'>('unreconciled');
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedStatementId, setSelectedStatementId] = useState<string>('');

  // Options
  const [createJournalEntries, setCreateJournalEntries] = useState(false);

  // Selected transactions for reconciliation
  const [selectedTxIds, setSelectedTxIds] = useState<Set<string>>(new Set());
  const [txGlAssignments, setTxGlAssignments] = useState<Record<string, string>>({});

  // Dialogs
  const [autoMatchDialogOpen, setAutoMatchDialogOpen] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [autoMatchResult, setAutoMatchResult] = useState<{
    matched: number; total: number; matchedByRule: number; matchedByAmount: number;
  } | null>(null);

  const [reconcileDialogOpen, setReconcileDialogOpen] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<number | null>(null);

  const [unreconcileDialogOpen, setUnreconcileDialogOpen] = useState(false);
  const [unreconciling, setUnreconciling] = useState(false);
  const [unreconcileResult, setUnreconcileResult] = useState<number | null>(null);

  const [adjustmentDialogOpen, setAdjustmentDialogOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [adjustForm, setAdjustForm] = useState({
    date: new Date().toISOString().split('T')[0],
    description: '',
    debitAccountId: '',
    creditAccountId: '',
    amount: '',
    notes: '',
  });

  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyPeriods, setHistoryPeriods] = useState<ReconPeriod[]>([]);

  // Build query params
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (selectedAccountId) params.set('bankAccountId', selectedAccountId);
    if (activeCompany?.id) params.set('companyId', activeCompany.id);
    params.set('status', statusFilter);
    if (search) params.set('search', search);
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (selectedStatementId) params.set('statementId', selectedStatementId);
    return params.toString();
  }, [selectedAccountId, activeCompany?.id, statusFilter, search, startDate, endDate, selectedStatementId]);

  // Fetch bank accounts list
  const fetchBankAccounts = useCallback(async () => {
    if (!activeCompany?.id) return;
    setLoadingAccounts(true);
    try {
      const res = await fetch('/api/dashboard', {
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.bankAccounts) {
          setBankAccounts(
            data.bankAccounts.map((ba: { id: string; accountName: string; bankName: string }) => ({
              id: ba.id,
              accountName: ba.accountName,
              bankName: ba.bankName,
            }))
          );
        }
      }
    } catch { /* ignore */ } finally {
      setLoadingAccounts(false);
    }
  }, [activeCompany?.id]);

  // Fetch GL accounts
  const fetchAccounts = useCallback(async () => {
    if (!activeCompany?.id) return;
    try {
      const res = await fetch(`/api/journal/accounts?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.data ?? data);
      }
    } catch { /* ignore */ }
  }, [activeCompany?.id]);

  // Fetch reconciliation data
  const fetchReconciliation = useCallback(async () => {
    if (!activeCompany?.id || !selectedAccountId) return;
    setLoadingData(true);
    setSelectedTxIds(new Set());
    setTxGlAssignments({});
    try {
      const res = await fetch(`/api/reconciliation?${queryParams}`);
      if (res.ok) {
        const data = await res.json();
        setBankAccountInfo(data.bankAccount);
        setSummary(data.summary);
        setDeposits(data.deposits ?? []);
        setPayments(data.payments ?? []);
        setStatements(data.statements ?? []);
        setOpenPeriod(data.openPeriod ?? null);
        setRecentPeriods(data.recentPeriods ?? []);
      }
    } catch { /* ignore */ } finally {
      setLoadingData(false);
    }
  }, [activeCompany?.id, selectedAccountId, queryParams]);

  useEffect(() => {
    fetchBankAccounts();
    fetchAccounts();
  }, [fetchBankAccounts, fetchAccounts]);

  useEffect(() => {
    if (selectedAccountId) {
      fetchReconciliation();
    } else {
      setBankAccountInfo(null);
      setSummary(null);
      setDeposits([]);
      setPayments([]);
      setStatements([]);
      setOpenPeriod(null);
      setRecentPeriods([]);
    }
  }, [selectedAccountId, fetchReconciliation]);

  // Toggle transaction selection
  const toggleTx = (id: string) => {
    setSelectedTxIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (txs: Transaction[]) => {
    const allSelected = txs.every((tx) => selectedTxIds.has(tx.id));
    if (allSelected) {
      setSelectedTxIds((prev) => {
        const next = new Set(prev);
        txs.forEach((tx) => next.delete(tx.id));
        return next;
      });
    } else {
      setSelectedTxIds((prev) => {
        const next = new Set(prev);
        txs.forEach((tx) => next.add(tx.id));
        return next;
      });
    }
  };

  const updateTxGl = (txId: string, glId: string | null) => {
    setTxGlAssignments((prev) => {
      if (glId === null) {
        const next = { ...prev };
        delete next[txId];
        return next;
      }
      return { ...prev, [txId]: glId };
    });
  };

  // Auto-match
  const handleAutoMatch = async () => {
    if (!activeCompany?.id || !selectedAccountId) return;
    setAutoMatching(true);
    setAutoMatchResult(null);
    try {
      const res = await fetch('/api/reconciliation/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          bankAccountId: selectedAccountId,
          createJournalEntries,
          periodId: openPeriod?.id,
          matchByAmount: true,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setAutoMatchResult(data);
        fetchReconciliation();
      }
    } catch { /* ignore */ } finally {
      setAutoMatching(false);
    }
  };

  // Reconcile selected
  const handleReconcile = async () => {
    if (!activeCompany?.id || !selectedAccountId || selectedTxIds.size === 0) return;
    setReconciling(true);
    setReconcileResult(null);
    try {
      const transactions = Array.from(selectedTxIds).map((id) => ({
        id,
        glAccountId: txGlAssignments[id] || undefined,
      }));
      const res = await fetch('/api/reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          bankAccountId: selectedAccountId,
          transactions,
          createJournalEntries,
          periodId: openPeriod?.id,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setReconcileResult(data.reconciled);
        if (data.journalEntriesCreated > 0) {
          toast.success(`${data.journalEntriesCreated} journal entries created`);
        }
        fetchReconciliation();
      }
    } catch { /* ignore */ } finally {
      setReconciling(false);
    }
  };

  // Unreconcile selected
  const handleUnreconcile = async () => {
    if (!activeCompany?.id || !selectedAccountId || selectedTxIds.size === 0) return;
    setUnreconciling(true);
    setUnreconcileResult(null);
    try {
      const res = await fetch('/api/reconciliation/unreconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          bankAccountId: selectedAccountId,
          transactionIds: Array.from(selectedTxIds),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setUnreconcileResult(data.unreconciled);
        fetchReconciliation();
      }
    } catch { /* ignore */ } finally {
      setUnreconciling(false);
    }
  };

  // Create adjustment
  const handleAdjustment = async () => {
    if (!activeCompany?.id || !selectedAccountId) return;
    if (!adjustForm.description || !adjustForm.debitAccountId || !adjustForm.creditAccountId || !adjustForm.amount) return;
    setAdjusting(true);
    try {
      const res = await fetch('/api/reconciliation/adjustment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          bankAccountId: selectedAccountId,
          ...adjustForm,
          amount: parseFloat(adjustForm.amount),
        }),
      });
      if (res.ok) {
        toast.success(t('reconciliation.adjustmentCreated'));
        setAdjustmentDialogOpen(false);
        setAdjustForm({ date: new Date().toISOString().split('T')[0], description: '', debitAccountId: '', creditAccountId: '', amount: '', notes: '' });
        fetchReconciliation();
      }
    } catch { /* ignore */ } finally {
      setAdjusting(false);
    }
  };

  // Start/Complete/Cancel period
  const handlePeriod = async (action: 'start' | 'complete' | 'cancel', periodId?: string) => {
    if (!activeCompany?.id || !selectedAccountId) return;
    try {
      const res = await fetch('/api/reconciliation/periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          bankAccountId: selectedAccountId,
          action,
          periodId,
        }),
      });
      if (res.ok) {
        fetchReconciliation();
      }
    } catch { /* ignore */ }
  };

  // Fetch history
  const fetchHistory = async () => {
    if (!activeCompany?.id || !selectedAccountId) return;
    try {
      const res = await fetch(`/api/reconciliation/periods?bankAccountId=${selectedAccountId}&companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setHistoryPeriods(data.periods ?? []);
      }
    } catch { /* ignore */ }
  };

  // Export
  const handleExport = () => {
    if (!summary || !bankAccountInfo) return;
    const allTxs = [
      ...deposits.map((tx) => ({ ...tx, type: 'Deposit' as const })),
      ...payments.map((tx) => ({ ...tx, type: 'Payment' as const })),
    ];
    const lines = [
      `Bank Reconciliation Report - ${bankAccountInfo.accountName}`,
      `Generated: ${new Date().toLocaleDateString()}`,
      '',
      `Statement Balance: ${formatCurrency(summary.statementBalance)}`,
      `Book Balance: ${formatCurrency(summary.bookBalance)}`,
      `Difference: ${formatCurrency(summary.difference)}`,
      '',
      `Total Transactions: ${summary.totalTransactions}`,
      `Reconciled: ${summary.reconciledCount}`,
      `Unreconciled: ${summary.unreconciledCount}`,
      '',
      `${statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1)} Transactions:`,
      '─'.repeat(80),
      'Date\tType\tDescription\tAmount\tGL Account\tMatched Rule',
      '─'.repeat(80),
      ...allTxs.map(
        (tx) =>
          `${formatDate(tx.date)}\t${tx.type}\t${tx.description}\t${formatCurrency(tx.amount)}\t${tx.glAccount ? `${tx.glAccount.code} - ${tx.glAccount.name}` : '—'}\t${tx.matchedRule?.name ?? '—'}`
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconciliation-${bankAccountInfo.accountName.replace(/\s+/g, '-').toLowerCase()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isReconciledView = statusFilter === 'reconciled' || statusFilter === 'all';

  // Transaction row component
  const TxRow = ({ tx, type }: { tx: Transaction; type: 'deposit' | 'payment' }) => {
    const isSelected = selectedTxIds.has(tx.id);
    const assignedGl = txGlAssignments[tx.id] || tx.glAccountId || null;
    const isReconciled = !!tx.reconciledAt;

    return (
      <TableRow className={cn(isSelected && 'bg-primary/5', isReconciled && 'opacity-75')}>
        <TableCell className="w-10">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => toggleTx(tx.id)}
          />
        </TableCell>
        <TableCell className="text-sm whitespace-nowrap">{formatDate(tx.date)}</TableCell>
        <TableCell className="max-w-[200px]">
          <div className="font-medium text-sm truncate">{tx.description}</div>
          {tx.reference && <div className="text-xs text-muted-foreground">{tx.reference}</div>}
        </TableCell>
        <TableCell
          className={cn(
            'font-mono text-sm text-right whitespace-nowrap',
            type === 'deposit' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
          )}
        >
          {formatCurrency(tx.amount)}
        </TableCell>
        <TableCell className="min-w-[180px]">
          {(!isReconciled || statusFilter === 'all') ? (
            <AccountSelector
              accounts={accounts}
              value={assignedGl}
              onChange={(id) => updateTxGl(tx.id, id)}
              placeholder={t('reconciliation.selectGlAccount')}
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              {tx.glAccount ? `${tx.glAccount.code} - ${tx.glAccount.name}` : '—'}
            </span>
          )}
        </TableCell>
        <TableCell className="w-[120px]">
          {tx.matchedRule ? (
            tx.matchedRule.name === 'Amount Match' ? (
              <Badge variant="outline" className="text-xs gap-1 border-blue-300 text-blue-600">
                <BookOpen className="size-3" />
                {t('reconciliation.amountMatch')}
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs gap-1">
                <Check className="size-3" />
                {tx.matchedRule.name}
              </Badge>
            )
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="w-[100px]">
          {isReconciled && tx.reconciledAt && (
            <Badge variant="outline" className="text-xs gap-1 border-emerald-300 text-emerald-600">
              <Check className="size-3" />
              {formatDate(tx.reconciledAt)}
            </Badge>
          )}
        </TableCell>
      </TableRow>
    );
  };

  /* ─── Render ─── */
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t('reconciliation.title')}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t('reconciliation.reconciliationSubtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedAccountId && (
            <>
              <Button variant="outline" size="sm" onClick={() => { fetchHistory(); setHistoryDialogOpen(true); }} className="gap-2">
                <History className="size-4" />
                {t('reconciliation.history')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleExport} disabled={loadingData} className="gap-2">
                <Download className="size-4" />
                {t('reconciliation.exportReport')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Bank Account Selector */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Landmark className="size-5 text-muted-foreground shrink-0" />
            <div className="flex-1">
              <Label className="text-sm font-medium mb-1 block">{t('reconciliation.selectAccount')}</Label>
              {loadingAccounts ? (
                <Skeleton className="h-9 w-full max-w-sm" />
              ) : (
                <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                  <SelectTrigger className="max-w-sm">
                    <SelectValue placeholder={t('reconciliation.selectAccount')} />
                  </SelectTrigger>
                  <SelectContent>
                    {bankAccounts.length === 0 && (
                      <SelectItem value="__none" disabled>{t('reconciliation.noAccounts')}</SelectItem>
                    )}
                    {bankAccounts.map((ba) => (
                      <SelectItem key={ba.id} value={ba.id}>{ba.accountName} — {ba.bankName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedAccountId && loadingData && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-lg" />)}</div>
          <Skeleton className="h-64 rounded-lg" />
        </div>
      )}

      {selectedAccountId && !loadingData && summary && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">{t('reconciliation.statementBalance')}</p>
                <p className="text-2xl font-bold mt-1">{formatCurrency(summary.statementBalance)}</p>
                <p className="text-xs text-muted-foreground mt-1">{bankAccountInfo?.accountName}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">{t('reconciliation.bookBalance')}</p>
                <p className="text-2xl font-bold mt-1">{formatCurrency(summary.bookBalance)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {bankAccountInfo?.glAccount ? `${bankAccountInfo.glAccount.code} - ${bankAccountInfo.glAccount.name}` : ''}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">{t('reconciliation.difference')}</p>
                <div className="flex items-center gap-2 mt-1">
                  <p className={cn('text-2xl font-bold', Math.abs(summary.difference) < 0.005 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                    {formatCurrency(summary.difference)}
                  </p>
                  {Math.abs(summary.difference) < 0.005 ? (
                    <Check className="size-5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <AlertTriangle className="size-5 text-rose-600 dark:text-rose-400" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {summary.reconciledCount} / {summary.totalTransactions} {t('reconciliation.reconciled').toLowerCase()}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Period Banner */}
          {openPeriod && (
            <Card className="border-teal-300 bg-teal-50/50 dark:bg-teal-950/20 dark:border-teal-700">
              <CardContent className="p-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-teal-100 dark:bg-teal-900/40">
                      <Calendar className="size-5 text-teal-600 dark:text-teal-400" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-teal-700 dark:text-teal-300">{t('reconciliation.periodActive')}</p>
                      <p className="text-xs text-muted-foreground">{t('reconciliation.periodStarted').replace('{date}', formatDate(openPeriod.startedAt))}</p>
                    </div>
                    <Badge variant="outline" className="border-teal-400 text-teal-600">
                      {openPeriod.transactionCount} {t('reconciliation.periodTransactions').toLowerCase()}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handlePeriod('complete', openPeriod.id)} className="gap-2 border-teal-400 text-teal-700 hover:bg-teal-100">
                      <Check className="size-4" />
                      {t('reconciliation.completePeriod')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handlePeriod('cancel', openPeriod.id)} className="text-muted-foreground">
                      <X className="size-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Filters + Actions */}
          <Card>
            <CardContent className="p-4 space-y-4">
              {/* Status Toggle */}
              <div className="flex flex-wrap items-center gap-3">
                <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
                  <TabsList className="h-8">
                    <TabsTrigger value="unreconciled" className="text-xs px-3 h-6">{t('reconciliation.showUnreconciled')} ({summary.unreconciledCount})</TabsTrigger>
                    <TabsTrigger value="reconciled" className="text-xs px-3 h-6">{t('reconciliation.showReconciled')} ({summary.reconciledCount})</TabsTrigger>
                    <TabsTrigger value="all" className="text-xs px-3 h-6">{t('reconciliation.showAll')} ({summary.totalTransactions})</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="flex-1" />
                {!openPeriod && (
                  <Button variant="outline" size="sm" onClick={() => handlePeriod('start')} className="gap-2">
                    <Calendar className="size-3.5" />
                    {t('reconciliation.startPeriod')}
                  </Button>
                )}
              </div>

              {/* Search & Filters */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[200px] max-w-sm">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    placeholder={t('reconciliation.searchPlaceholder')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9 h-8"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Filter className="size-3.5 text-muted-foreground" />
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-8 w-36" />
                  <span className="text-xs text-muted-foreground">—</span>
                  <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-8 w-36" />
                </div>
                {statements.length > 0 && (
                  <Select value={selectedStatementId} onValueChange={setSelectedStatementId}>
                    <SelectTrigger className="h-8 w-48">
                      <SelectValue placeholder={t('reconciliation.allStatements')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{t('reconciliation.allStatements')}</SelectItem>
                      {statements.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {formatDate(s.startDate)} {t('reconciliation.endDateFrom')} {formatDate(s.endDate)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Action Bar */}
              <div className="flex items-center gap-2 flex-wrap">
                {!isReconciledView && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => { setAutoMatchResult(null); setAutoMatchDialogOpen(true); }} className="gap-2">
                      <Play className="size-4" />
                      {t('reconciliation.autoMatch')}
                    </Button>
                    <Button size="sm" onClick={() => { setReconcileResult(null); setReconcileDialogOpen(true); }} disabled={selectedTxIds.size === 0} className="gap-2">
                      <ArrowLeftRight className="size-4" />
                      {t('reconciliation.reconcileSelected')} ({selectedTxIds.size})
                    </Button>
                  </>
                )}
                {isReconciledView && (
                  <Button variant="outline" size="sm" onClick={() => { setUnreconcileResult(null); setUnreconcileDialogOpen(true); }} disabled={selectedTxIds.size === 0} className="gap-2">
                    <Undo2 className="size-4" />
                    {t('reconciliation.unreconcileSelected')} ({selectedTxIds.size})
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setAdjustmentDialogOpen(true)} className="gap-2">
                  <PlusCircle className="size-4" />
                  {t('reconciliation.createAdjustment')}
                </Button>

                <div className="flex items-center gap-2 ml-auto">
                  <div className="flex items-center gap-1.5">
                    <Switch
                      id="createJE"
                      checked={createJournalEntries}
                      onCheckedChange={setCreateJournalEntries}
                    />
                    <Label htmlFor="createJE" className="text-xs whitespace-nowrap">
                      {t('reconciliation.createJournalEntries')}
                    </Label>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Deposits / Credits */}
          <Card>
            <CardContent className="p-0">
              <div className="flex items-center justify-between p-4 pb-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold">{t('reconciliation.depositsCredits')}</h3>
                  <Badge variant="secondary" className="text-xs">{deposits.length}</Badge>
                </div>
                {deposits.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => toggleAll(deposits)} className="text-xs h-7">
                    {deposits.every((tx) => selectedTxIds.has(tx.id)) ? t('reconciliation.deselectAll') : t('reconciliation.selectAll')}
                  </Button>
                )}
              </div>
              {deposits.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">{t('reconciliation.noTransactions')}</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>{t('common.date')}</TableHead>
                        <TableHead>{t('common.description')}</TableHead>
                        <TableHead className="text-right">{t('common.amount')}</TableHead>
                        <TableHead>{t('reconciliation.glAccount')}</TableHead>
                        <TableHead>{t('reconciliation.matchedRule')}</TableHead>
                        {statusFilter !== 'unreconciled' && <TableHead className="w-[100px]">Reconciled</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deposits.map((tx) => (
                        <TxRow key={tx.id} tx={tx} type="deposit" />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {deposits.length > 0 && (
                <div className="flex items-center justify-end px-4 py-3 border-t bg-muted/30">
                  <span className="text-sm text-muted-foreground mr-3">{t('reconciliation.total')}:</span>
                  <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">{formatCurrency(summary.depositsTotal)}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Payments / Debits */}
          <Card>
            <CardContent className="p-0">
              <div className="flex items-center justify-between p-4 pb-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold">{t('reconciliation.paymentsDebits')}</h3>
                  <Badge variant="secondary" className="text-xs">{payments.length}</Badge>
                </div>
                {payments.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => toggleAll(payments)} className="text-xs h-7">
                    {payments.every((tx) => selectedTxIds.has(tx.id)) ? t('reconciliation.deselectAll') : t('reconciliation.selectAll')}
                  </Button>
                )}
              </div>
              {payments.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">{t('reconciliation.noTransactions')}</div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>{t('common.date')}</TableHead>
                        <TableHead>{t('common.description')}</TableHead>
                        <TableHead className="text-right">{t('common.amount')}</TableHead>
                        <TableHead>{t('reconciliation.glAccount')}</TableHead>
                        <TableHead>{t('reconciliation.matchedRule')}</TableHead>
                        {statusFilter !== 'unreconciled' && <TableHead className="w-[100px]">Reconciled</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((tx) => (
                        <TxRow key={tx.id} tx={tx} type="payment" />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {payments.length > 0 && (
                <div className="flex items-center justify-end px-4 py-3 border-t bg-muted/30">
                  <span className="text-sm text-muted-foreground mr-3">{t('reconciliation.total')}:</span>
                  <span className="font-mono font-semibold text-rose-600 dark:text-rose-400">{formatCurrency(summary.paymentsTotal)}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Periods */}
          {recentPeriods.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <History className="size-4" />
                  Recent Reconciliations
                </h3>
                <div className="space-y-2">
                  {recentPeriods.map((p) => (
                    <div key={p.id} className="flex items-center justify-between p-3 rounded-lg border bg-muted/20">
                      <div className="flex items-center gap-3">
                        <Check className="size-4 text-emerald-500" />
                        <div>
                          <p className="text-sm font-medium">
                            {p.transactionCount} {t('reconciliation.transactionsReconciled')}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t('reconciliation.periodCompleted')
                              .replace('{date}', formatDate(p.completedAt!))
                              .replace('{user}', p.user ? `${p.user.firstName} ${p.user.lastName}` : '—')}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={cn('text-xs font-mono', Math.abs(p.difference) < 0.005 ? 'text-emerald-600' : 'text-rose-600')}>
                          Diff: {formatCurrency(p.difference)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {!selectedAccountId && !loadingAccounts && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-muted mb-4">
            <ArrowLeftRight className="size-8 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">{t('reconciliation.selectAccountToStart')}</p>
        </div>
      )}

      {/* ─── DIALOGS ─── */}

      {/* Auto-Match Dialog */}
      <Dialog open={autoMatchDialogOpen} onOpenChange={setAutoMatchDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t('reconciliation.autoMatchTitle')}</DialogTitle>
            <DialogDescription>{t('reconciliation.autoMatchDesc')}</DialogDescription>
          </DialogHeader>
          {createJournalEntries && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <AlertTriangle className="size-4 text-amber-600" />
              <p className="text-xs text-amber-700 dark:text-amber-400">{t('reconciliation.createJournalEntriesDesc')}</p>
            </div>
          )}
          {autoMatchResult ? (
            <div className="space-y-4">
              <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{autoMatchResult.matched}</p>
                  <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">{t('reconciliation.transactionsMatched')}</p>
                  <div className="flex justify-center gap-4 mt-2">
                    <span className="text-xs text-muted-foreground">{t('reconciliation.matchedByRule')}: {autoMatchResult.matchedByRule}</span>
                    <span className="text-xs text-muted-foreground">{t('reconciliation.matchedByAmount')}: {autoMatchResult.matchedByAmount}</span>
                  </div>
                  {autoMatchResult.total > autoMatchResult.matched && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {autoMatchResult.total - autoMatchResult.matched} {t('reconciliation.stillUnmatched')}
                    </p>
                  )}
                </CardContent>
              </Card>
              <DialogFooter><Button onClick={() => setAutoMatchDialogOpen(false)}>{t('common.confirm')}</Button></DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button variant="outline" onClick={() => setAutoMatchDialogOpen(false)}>{t('common.cancel')}</Button>
              <Button onClick={handleAutoMatch} disabled={autoMatching} className="gap-2">
                {autoMatching && <Loader2 className="size-4 animate-spin" />}
                <Play className="size-4" />
                {t('reconciliation.autoMatch')}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Reconcile Confirmation Dialog */}
      <Dialog open={reconcileDialogOpen} onOpenChange={setReconcileDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('reconciliation.confirmReconcile')}</DialogTitle>
            <DialogDescription>{t('reconciliation.confirmReconcileDesc').replace('{count}', String(selectedTxIds.size))}</DialogDescription>
          </DialogHeader>
          {createJournalEntries && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <AlertTriangle className="size-4 text-amber-600" />
              <p className="text-xs text-amber-700 dark:text-amber-400">{t('reconciliation.createJournalEntriesDesc')}</p>
            </div>
          )}
          {reconcileResult !== null ? (
            <div className="space-y-4">
              <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{reconcileResult}</p>
                  <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">{t('reconciliation.transactionsReconciled')}</p>
                </CardContent>
              </Card>
              <DialogFooter><Button onClick={() => setReconcileDialogOpen(false)}>{t('common.confirm')}</Button></DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button variant="outline" onClick={() => setReconcileDialogOpen(false)}>{t('common.cancel')}</Button>
              <Button onClick={handleReconcile} disabled={reconciling} className="gap-2">
                {reconciling && <Loader2 className="size-4 animate-spin" />}
                <Check className="size-4" />
                {t('reconciliation.reconcileSelected')} ({selectedTxIds.size})
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Unreconcile Confirmation Dialog */}
      <Dialog open={unreconcileDialogOpen} onOpenChange={setUnreconcileDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('reconciliation.confirmUnreconcile')}</DialogTitle>
            <DialogDescription>{t('reconciliation.confirmUnreconcileDesc').replace('{count}', String(selectedTxIds.size))}</DialogDescription>
          </DialogHeader>
          {unreconcileResult !== null ? (
            <div className="space-y-4">
              <Card className="bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{unreconcileResult}</p>
                  <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">{t('reconciliation.transactionsUnreconciled')}</p>
                </CardContent>
              </Card>
              <DialogFooter><Button onClick={() => setUnreconcileDialogOpen(false)}>{t('common.confirm')}</Button></DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button variant="outline" onClick={() => setUnreconcileDialogOpen(false)}>{t('common.cancel')}</Button>
              <Button onClick={handleUnreconcile} disabled={unreconciling} className="gap-2" variant="destructive">
                {unreconciling && <Loader2 className="size-4 animate-spin" />}
                <Undo2 className="size-4" />
                {t('reconciliation.unreconcileSelected')} ({selectedTxIds.size})
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Adjustment Dialog */}
      <Dialog open={adjustmentDialogOpen} onOpenChange={setAdjustmentDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PlusCircle className="size-5" />
              {t('reconciliation.adjustmentTitle')}
            </DialogTitle>
            <DialogDescription>{t('reconciliation.adjustmentDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm">{t('reconciliation.adjustmentDate')}</Label>
                <Input type="date" value={adjustForm.date} onChange={(e) => setAdjustForm({ ...adjustForm, date: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">{t('reconciliation.adjustmentAmount')}</Label>
                <Input type="number" step="0.01" placeholder="0.00" value={adjustForm.amount} onChange={(e) => setAdjustForm({ ...adjustForm, amount: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">{t('reconciliation.adjustmentDescription')}</Label>
              <Input placeholder="e.g., Bank fee adjustment" value={adjustForm.description} onChange={(e) => setAdjustForm({ ...adjustForm, description: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm">{t('reconciliation.adjustmentDebitAccount')}</Label>
                <AccountSelector accounts={accounts} value={adjustForm.debitAccountId} onChange={(id) => setAdjustForm({ ...adjustForm, debitAccountId: id })} placeholder="Select debit account" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">{t('reconciliation.adjustmentCreditAccount')}</Label>
                <AccountSelector accounts={accounts} value={adjustForm.creditAccountId} onChange={(id) => setAdjustForm({ ...adjustForm, creditAccountId: id })} placeholder="Select credit account" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">{t('reconciliation.adjustmentNotes')}</Label>
              <Textarea placeholder={t('reconciliation.adjustmentNotes')} value={adjustForm.notes} onChange={(e) => setAdjustForm({ ...adjustForm, notes: e.target.value })} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustmentDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleAdjustment} disabled={adjusting || !adjustForm.description || !adjustForm.debitAccountId || !adjustForm.creditAccountId || !adjustForm.amount} className="gap-2">
              {adjusting && <Loader2 className="size-4 animate-spin" />}
              <PlusCircle className="size-4" />
              {t('reconciliation.createAdjustment')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={historyDialogOpen} onOpenChange={setHistoryDialogOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="size-5" />
              {t('reconciliation.historyTitle')}
            </DialogTitle>
          </DialogHeader>
          {historyPeriods.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="size-12 text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">{t('reconciliation.noHistory')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {historyPeriods.map((p) => (
                <div key={p.id} className="p-4 rounded-lg border space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant={p.status === 'completed' ? 'default' : p.status === 'open' ? 'secondary' : 'outline'}>
                        {p.status === 'completed' ? t('reconciliation.periodCompletedStatus') : p.status === 'open' ? t('reconciliation.periodOpen') : t('reconciliation.periodCancelled')}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {t('reconciliation.startedBy')}: {p.user ? `${p.user.firstName} ${p.user.lastName}` : '—'}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatDate(p.startedAt)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div><span className="text-muted-foreground">Stmt: </span><span className="font-mono">{formatCurrency(p.statementBalance)}</span></div>
                    <div><span className="text-muted-foreground">Book: </span><span className="font-mono">{formatCurrency(p.bookBalance)}</span></div>
                    <div><span className="text-muted-foreground">Diff: </span><span className={cn('font-mono', Math.abs(p.difference) < 0.005 ? 'text-emerald-600' : 'text-rose-600')}>{formatCurrency(p.difference)}</span></div>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{p.transactionCount} {t('reconciliation.transactionsReconciled')}</span>
                    {p.completedAt && <span>{formatDate(p.completedAt)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
