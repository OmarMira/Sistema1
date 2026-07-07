'use client';

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeftRight,
  Check,
  Download,
  Landmark,
  Play,
  AlertTriangle,
  Search,
  Undo2,
  PlusCircle,
  Calendar,
  X,
  Scissors,
  History as HistoryIcon,
  BookOpen,
  Filter,
  Upload,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import {
  SplitTransactionDialog,
  AutoMatchDialog,
  ReconcileDialog,
  UnreconcileDialog,
  AdjustmentDialog,
  HistoryDialog,
} from '@/components/reconciliation/ReconciliationDialogs';
import type {
  BankAccountOption,
  StatementOption,
  Transaction,
  ReconciliationSummary,
  BankAccountInfo,
  ReconPeriod,
} from '@/lib/types/reconciliation';

/* ─── Component ─── */
export function ReconciliationPage() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);
  const startProcessing = useAuthStore((s) => s.startProcessing);
  const stopProcessing = useAuthStore((s) => s.stopProcessing);

  // Bank account selector - auto-select first account
  const [bankAccounts, setBankAccounts] = useState<BankAccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [initialAutoSelect, setInitialAutoSelect] = useState(true);

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
  const [statusFilter, setStatusFilter] = useState<
    'unreconciled' | 'reconciled' | 'all' | 'pending_review'
  >('unreconciled');
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedStatementId, setSelectedStatementId] = useState<string>('all');

  // Options
  const [createJournalEntries, setCreateJournalEntries] = useState(true);

  // Selected transactions for reconciliation
  const [selectedTxIds, setSelectedTxIds] = useState<Set<string>>(new Set());
  const [txGlAssignments, setTxGlAssignments] = useState<Record<string, string>>({});
  const [txSplits, setTxSplits] = useState<
    Record<string, { glAccountId: string; amount: number; description: string }[]>
  >({});

  // Dialogs
  const [autoMatchDialogOpen, setAutoMatchDialogOpen] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [autoMatchResult, setAutoMatchResult] = useState<{
    matched: number;
    total: number;
    matchedByRule: number;
    matchedByAmount: number;
  } | null>(null);
  const [autoMatchPreviewCount, setAutoMatchPreviewCount] = useState<number | null>(null);

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

  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [splittingTx, setSplittingTx] = useState<Transaction | null>(null);
  const [currentSplits, setCurrentSplits] = useState<
    { glAccountId: string; amount: number; description: string }[]
  >([]);

  // Refs & Virtualizers for table virtualization
  const depositsParentRef = useRef<HTMLDivElement>(null);
   
  const depositsVirtualizer = useVirtualizer({
    count: deposits.length,
    getScrollElement: () => depositsParentRef.current,
    estimateSize: () => 53, // Estimated height of TableRow (53px)
    overscan: 5,
  });

  const paymentsParentRef = useRef<HTMLDivElement>(null);
  const paymentsVirtualizer = useVirtualizer({
    count: payments.length,
    getScrollElement: () => paymentsParentRef.current,
    estimateSize: () => 53, // Estimated height of TableRow (53px)
    overscan: 5,
  });

  // Build query params
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (selectedAccountId) params.set('bankAccountId', selectedAccountId);
    if (activeCompany?.id) params.set('companyId', activeCompany.id);
    params.set('status', statusFilter);
    if (search) params.set('search', search);
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (selectedStatementId && selectedStatementId !== 'all')
      params.set('statementId', selectedStatementId);
    return params.toString();
  }, [
    selectedAccountId,
    activeCompany?.id,
    statusFilter,
    search,
    startDate,
    endDate,
    selectedStatementId,
  ]);

  // Fetch bank accounts list and auto-select first one
  const fetchBankAccounts = useCallback(async () => {
    if (!activeCompany?.id) return;
    setLoadingAccounts(true);
    try {
      const res = await fetch(`/api/dashboard?companyId=${activeCompany.id}`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.bankAccounts) {
          const accounts = data.bankAccounts.map(
            (ba: { id: string; accountName: string; bankName: string }) => ({
              id: ba.id,
              accountName: ba.accountName,
              bankName: ba.bankName,
            }),
          );
          setBankAccounts(accounts);
          // Auto-select the first bank account if none selected yet
          if (initialAutoSelect && accounts.length > 0 && !selectedAccountId) {
            setSelectedAccountId(accounts[0].id);
            setInitialAutoSelect(false);
          }
        }
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingAccounts(false);
    }
  }, [activeCompany?.id, initialAutoSelect, selectedAccountId]);

  // Fetch GL accounts
  const fetchAccounts = useCallback(async () => {
    if (!activeCompany?.id) return;
    try {
      const res = await fetch(`/api/journal/accounts?companyId=${activeCompany.id}`);
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.data ?? data);
      }
    } catch {
      /* ignore */
    }
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
    } catch {
      /* ignore */
    } finally {
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
    }
  }, [selectedAccountId, fetchReconciliation]);

  useEffect(() => {
    if (!activeCompany?.id || !selectedAccountId) return;
    if (!summary || summary.unreconciledCount === 0) {
      setAutoMatchPreviewCount(null);
      return;
    }
    let isMounted = true;
    const fetchPreview = async () => {
      try {
        const res = await fetch('/api/reconciliation/auto-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId: activeCompany.id,
            bankAccountId: selectedAccountId,
            matchByAmount: true,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.success) {
            setAutoMatchPreviewCount(data.matched);
          }
        }
      } catch (err) {
        logger.error('Failed to fetch auto-preview', { error: String(err) });
      }
    };
    fetchPreview();
    return () => {
      isMounted = false;
    };
  }, [activeCompany?.id, selectedAccountId, summary]);

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
    // Remove splits if manual GL is selected
    setTxSplits((prev) => {
      const next = { ...prev };
      delete next[txId];
      return next;
    });
  };

  // Auto-match
  const handleAutoMatch = async () => {
    if (!activeCompany?.id || !selectedAccountId) return;
    setAutoMatching(true);
    setAutoMatchResult(null);
    startProcessing('Emparejando transacciones automáticamente...');
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
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || err.message || 'Error al emparejar automáticamente');
        console.error('AutoMatch error:', err);
      }
    } catch (err) {
      console.error('Network error during autoMatch:', err);
      toast.error('Error de red al emparejar');
    } finally {
      setAutoMatching(false);
      stopProcessing();
    }
  };

  // Reconcile selected
  const handleReconcile = async () => {
    if (!activeCompany?.id || !selectedAccountId || selectedTxIds.size === 0) return;
    setReconciling(true);
    setReconcileResult(null);
    startProcessing('Conciliando transacciones seleccionadas...');
    try {
      const transactions = Array.from(selectedTxIds).map((id) => ({
        id,
        glAccountId: txGlAssignments[id] || undefined,
        splits: txSplits[id] || undefined,
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
    } catch {
      /* ignore */
    } finally {
      setReconciling(false);
      stopProcessing();
    }
  };

  // Unreconcile selected
  const handleUnreconcile = async () => {
    if (!activeCompany?.id || !selectedAccountId || selectedTxIds.size === 0) return;
    setUnreconciling(true);
    setUnreconcileResult(null);
    startProcessing('Revirtiendo conciliación de transacciones...');
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
    } catch {
      /* ignore */
    } finally {
      setUnreconciling(false);
      stopProcessing();
    }
  };

  // Approve pending review transaction
  const handleApproveReview = async (transactionId: string) => {
    try {
      const res = await fetch('/api/reconciliation/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany?.id,
          transactionId,
          action: 'approve',
        }),
      });
      if (res.ok) {
        toast.success(t('reconciliation.approveSuccess'));
        fetchReconciliation();
      } else {
        const err = await res.json();
        toast.error(err.error || t('reconciliation.approveError'));
      }
    } catch {
      toast.error(t('reconciliation.approveError'));
    }
  };

  // Reject pending review transaction
  const handleRejectReview = async (transactionId: string) => {
    try {
      const res = await fetch('/api/reconciliation/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany?.id,
          transactionId,
          action: 'reject',
        }),
      });
      if (res.ok) {
        toast.success(t('reconciliation.rejectSuccess'));
        fetchReconciliation();
      } else {
        const err = await res.json();
        toast.error(err.error || t('reconciliation.rejectError'));
      }
    } catch {
      toast.error(t('reconciliation.rejectError'));
    }
  };

  // Create adjustment
  const handleAdjustment = async () => {
    if (!activeCompany?.id || !selectedAccountId) return;
    if (
      !adjustForm.description ||
      !adjustForm.debitAccountId ||
      !adjustForm.creditAccountId ||
      !adjustForm.amount
    )
      return;
    setAdjusting(true);
    startProcessing('Creando asiento de ajuste...');
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
        setAdjustForm({
          date: new Date().toISOString().split('T')[0],
          description: '',
          debitAccountId: '',
          creditAccountId: '',
          amount: '',
          notes: '',
        });
        fetchReconciliation();
      }
    } catch {
      /* ignore */
    } finally {
      setAdjusting(false);
      stopProcessing();
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
    } catch {
      /* ignore */
    }
  };

  // Fetch history
  const fetchHistory = async () => {
    if (!activeCompany?.id || !selectedAccountId) return;
    try {
      const res = await fetch(
        `/api/reconciliation/periods?bankAccountId=${selectedAccountId}&companyId=${activeCompany.id}`,
      );
      if (res.ok) {
        const data = await res.json();
        setHistoryPeriods(data.periods ?? []);
      }
    } catch {
      /* ignore */
    }
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
          `${formatDate(tx.date)}\t${tx.type}\t${tx.description}\t${formatCurrency(tx.amount)}\t${tx.glAccount ? `${tx.glAccount.code} - ${tx.glAccount.name}` : '—'}\t${tx.matchedRule?.name ?? '—'}`,
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

  // Split management
  const openSplitDialog = (tx: Transaction) => {
    setSplittingTx(tx);
    const existingSplits = txSplits[tx.id];
    if (existingSplits) {
      setCurrentSplits([...existingSplits]);
    } else {
      setCurrentSplits([
        {
          glAccountId: tx.glAccountId || '',
          amount: Math.abs(tx.amount),
          description: tx.description,
        },
      ]);
    }
    setSplitDialogOpen(true);
  };

  const saveSplits = () => {
    if (!splittingTx) return;
    const totalSplit = currentSplits.reduce((sum, s) => sum + s.amount, 0);
    if (Math.abs(totalSplit - Math.abs(splittingTx.amount)) > 0.01) {
      toast.error(
        t('reconciliation.splitAmountMismatch') || 'Total splits must equal transaction amount',
      );
      return;
    }
    setTxSplits((prev) => ({ ...prev, [splittingTx.id]: currentSplits }));
    setTxGlAssignments((prev) => {
      const next = { ...prev };
      delete next[splittingTx.id];
      return next;
    });
    setSelectedTxIds((prev) => new Set(prev).add(splittingTx.id));
    setSplitDialogOpen(false);
  };

  // Transaction row component
  const TxRow = ({
    tx,
    type,
    style,
  }: {
    tx: Transaction;
    type: 'deposit' | 'payment';
    style?: React.CSSProperties;
  }) => {
    const isSelected = selectedTxIds.has(tx.id);
    const assignedGl = txGlAssignments[tx.id] || tx.glAccountId || null;
    const isReconciled = !!tx.reconciledAt;

    return (
      <TableRow
        className={cn(isSelected && 'bg-primary/5', isReconciled && 'opacity-75')}
        style={style}
      >
        <TableCell className="w-10">
          <Checkbox checked={isSelected} onCheckedChange={() => toggleTx(tx.id)} />
        </TableCell>
        <TableCell className="text-sm whitespace-nowrap">{formatDate(tx.date)}</TableCell>
        <TableCell className="max-w-[200px]">
          <div className="font-medium text-sm truncate">{tx.description}</div>
          {tx.reference && <div className="text-xs text-muted-foreground">{tx.reference}</div>}
        </TableCell>
        <TableCell
          className={cn(
            'font-mono text-sm text-right whitespace-nowrap',
            type === 'deposit'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-rose-600 dark:text-rose-400',
          )}
        >
          {formatCurrency(tx.amount)}
        </TableCell>
        <TableCell className="min-w-[180px]">
          {!isReconciled || statusFilter === 'all' ? (
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
        <TableCell className="w-[140px] text-right">
          {!isReconciled && statusFilter !== 'pending_review' && (
            <Button
              variant="ghost"
              size="icon"
              className={cn('size-8', txSplits[tx.id] ? 'text-primary' : 'text-muted-foreground')}
              onClick={() => openSplitDialog(tx)}
              title={t('reconciliation.splitTransaction') || 'Split Transaction'}
            >
              <Scissors className="size-4" />
            </Button>
          )}
          {statusFilter === 'pending_review' && (
            <div className="flex items-center gap-1 justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950"
                onClick={() => handleApproveReview(tx.id)}
              >
                <Check className="size-3 mr-1" />
                Approve
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950"
                onClick={() => handleRejectReview(tx.id)}
              >
                <X className="size-3 mr-1" />
                Reject
              </Button>
            </div>
          )}
          {isReconciled && tx.reconciledAt && statusFilter !== 'pending_review' && (
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
          <p className="text-sm text-muted-foreground mt-1">
            {t('reconciliation.reconciliationSubtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => setCurrentView('import')}
            className="gap-2 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600 text-white border-none shadow-sm hover:shadow transition-all"
          >
            <Upload className="size-4" />
            {t('banks.uploadStatement')}
          </Button>
          {selectedAccountId && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  fetchHistory();
                  setHistoryDialogOpen(true);
                }}
                className="gap-2"
              >
                <HistoryIcon className="size-4" />
                {t('reconciliation.history')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={loadingData}
                className="gap-2"
              >
                <Download className="size-4" />
                {t('reconciliation.exportReport')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Bank Account Selector - compact inline */}
      <div className="flex items-center gap-3">
        <Landmark className="size-4 text-muted-foreground shrink-0" />
        {loadingAccounts ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
            <SelectTrigger className="w-64 sm:w-80">
              <SelectValue placeholder={t('reconciliation.selectAccount')} />
            </SelectTrigger>
            <SelectContent>
              {bankAccounts.length === 0 && (
                <SelectItem value="__none" disabled>
                  {t('reconciliation.noAccounts')}
                </SelectItem>
              )}
              {bankAccounts.map((ba) => (
                <SelectItem key={ba.id} value={ba.id}>
                  {ba.accountName} — {ba.bankName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {selectedAccountId && loadingData && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-lg" />
        </div>
      )}

      {selectedAccountId && !loadingData && summary && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">
                  {t('reconciliation.statementBalance')}
                </p>
                <p className="text-2xl font-bold mt-1">
                  {formatCurrency(summary.statementBalance)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{bankAccountInfo?.accountName}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">{t('reconciliation.bookBalance')}</p>
                <p className="text-2xl font-bold mt-1">{formatCurrency(summary.bookBalance)}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {bankAccountInfo?.glAccount
                    ? `${bankAccountInfo.glAccount.code} - ${bankAccountInfo.glAccount.name}`
                    : ''}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">{t('reconciliation.difference')}</p>
                <div className="flex items-center gap-2 mt-1">
                  <p
                    className={cn(
                      'text-2xl font-bold',
                      Math.abs(summary.difference) < 0.005
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400',
                    )}
                  >
                    {formatCurrency(summary.difference)}
                  </p>
                  {Math.abs(summary.difference) < 0.005 ? (
                    <Check className="size-5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <AlertTriangle className="size-5 text-rose-600 dark:text-rose-400" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {summary.reconciledCount} / {summary.totalTransactions}{' '}
                  {t('reconciliation.reconciled').toLowerCase()}
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
                      <p className="text-sm font-semibold text-teal-700 dark:text-teal-300">
                        {t('reconciliation.periodActive')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('reconciliation.periodStarted').replace(
                          '{date}',
                          formatDate(openPeriod.startedAt),
                        )}
                      </p>
                    </div>
                    <Badge variant="outline" className="border-teal-400 text-teal-600">
                      {openPeriod.transactionCount}{' '}
                      {t('reconciliation.periodTransactions').toLowerCase()}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePeriod('complete', openPeriod.id)}
                      className="gap-2 border-teal-400 text-teal-700 hover:bg-teal-100"
                    >
                      <Check className="size-4" />
                      {t('reconciliation.completePeriod')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handlePeriod('cancel', openPeriod.id)}
                      className="text-muted-foreground"
                    >
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
                <Tabs
                  value={statusFilter}
                  onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
                >
                  <TabsList className="h-8">
                    <TabsTrigger value="unreconciled" className="text-xs px-3 h-6">
                      {t('reconciliation.showUnreconciled')} ({summary.unreconciledCount})
                    </TabsTrigger>
                    <TabsTrigger value="pending_review" className="text-xs px-3 h-6">
                      <AlertTriangle className="size-3 mr-1 text-amber-500" />
                      {summary.pendingReviewCount}
                    </TabsTrigger>
                    <TabsTrigger value="reconciled" className="text-xs px-3 h-6">
                      {t('reconciliation.showReconciled')} ({summary.reconciledCount})
                    </TabsTrigger>
                    <TabsTrigger value="all" className="text-xs px-3 h-6">
                      {t('reconciliation.showAll')} ({summary.totalTransactions})
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="flex-1" />
                {!openPeriod && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePeriod('start')}
                    className="gap-2"
                  >
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
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="h-8 w-36"
                  />
                  <span className="text-xs text-muted-foreground">—</span>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="h-8 w-36"
                  />
                </div>
                {statements.length > 0 && (
                  <Select value={selectedStatementId} onValueChange={setSelectedStatementId}>
                    <SelectTrigger className="h-8 w-48">
                      <SelectValue placeholder={t('reconciliation.allStatements')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('reconciliation.allStatements')}</SelectItem>
                      {statements.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {formatDate(s.startDate)} {t('reconciliation.endDateFrom')}{' '}
                          {formatDate(s.endDate)}
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (autoMatchPreviewCount === 0) {
                          toast.info(
                            t('reconciliation.noAutoMatches') ||
                              'No hay reglas ni montos que coincidan.',
                          );
                          return;
                        }
                        setAutoMatchResult(null);
                        setAutoMatchDialogOpen(true);
                      }}
                      className={cn(
                        'gap-2 transition-all',
                        autoMatchPreviewCount && autoMatchPreviewCount > 0
                          ? 'animate-pulse border-emerald-500 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-950/30 dark:hover:bg-emerald-900/50 shadow-sm'
                          : '',
                      )}
                    >
                      <Play
                        className={cn(
                          'size-4',
                          autoMatchPreviewCount && autoMatchPreviewCount > 0 && 'fill-emerald-500',
                        )}
                      />
                      {t('reconciliation.autoMatch')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setReconcileResult(null);
                        setReconcileDialogOpen(true);
                      }}
                      disabled={selectedTxIds.size === 0}
                      className="gap-2"
                    >
                      <ArrowLeftRight className="size-4" />
                      {t('reconciliation.reconcileSelected')} ({selectedTxIds.size})
                    </Button>
                  </>
                )}
                {isReconciledView && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setUnreconcileResult(null);
                      setUnreconcileDialogOpen(true);
                    }}
                    disabled={selectedTxIds.size === 0}
                    className="gap-2"
                  >
                    <Undo2 className="size-4" />
                    {t('reconciliation.unreconcileSelected')} ({selectedTxIds.size})
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAdjustmentDialogOpen(true)}
                  className="gap-2"
                >
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

          <SplitTransactionDialog
            open={splitDialogOpen}
            onOpenChange={setSplitDialogOpen}
            splittingTx={splittingTx}
            currentSplits={currentSplits}
            setCurrentSplits={setCurrentSplits}
            accounts={accounts}
            onSave={saveSplits}
          />

          {/* Deposits / Credits */}
          <Card>
            <CardContent className="p-0">
              <div className="flex items-center justify-between p-4 pb-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold">{t('reconciliation.depositsCredits')}</h3>
                  <Badge variant="secondary" className="text-xs">
                    {deposits.length}
                  </Badge>
                </div>
                {deposits.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleAll(deposits)}
                    className="text-xs h-7"
                  >
                    {deposits.every((tx) => selectedTxIds.has(tx.id))
                      ? t('reconciliation.deselectAll')
                      : t('reconciliation.selectAll')}
                  </Button>
                )}
              </div>
              {deposits.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {t('reconciliation.noTransactions')}
                </div>
              ) : (
                <div
                  ref={depositsParentRef}
                  className="max-h-[400px] overflow-y-auto overflow-x-auto relative"
                >
                  <Table>
                    <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>{t('common.date')}</TableHead>
                        <TableHead>{t('common.description')}</TableHead>
                        <TableHead className="text-right">{t('common.amount')}</TableHead>
                        <TableHead>{t('reconciliation.glAccount')}</TableHead>
                        <TableHead>{t('reconciliation.matchedRule')}</TableHead>
                        {statusFilter !== 'unreconciled' && (
                          <TableHead className="w-[100px]">Reconciled</TableHead>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody
                      style={{
                        height: `${depositsVirtualizer.getTotalSize()}px`,
                        position: 'relative',
                      }}
                    >
                      {depositsVirtualizer.getVirtualItems().map((virtualRow) => {
                        const tx = deposits[virtualRow.index];
                        return (
                          <TxRow
                            key={tx.id}
                            tx={tx}
                            type="deposit"
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: `${virtualRow.size}px`,
                              transform: `translateY(${virtualRow.start}px)`,
                            }}
                          />
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {deposits.length > 0 && (
                <div className="flex items-center justify-end px-4 py-3 border-t bg-muted/30">
                  <span className="text-sm text-muted-foreground mr-3">
                    {t('reconciliation.total')}:
                  </span>
                  <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(summary.depositsTotal)}
                  </span>
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
                  <Badge variant="secondary" className="text-xs">
                    {payments.length}
                  </Badge>
                </div>
                {payments.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleAll(payments)}
                    className="text-xs h-7"
                  >
                    {payments.every((tx) => selectedTxIds.has(tx.id))
                      ? t('reconciliation.deselectAll')
                      : t('reconciliation.selectAll')}
                  </Button>
                )}
              </div>
              {payments.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {t('reconciliation.noTransactions')}
                </div>
              ) : (
                <div
                  ref={paymentsParentRef}
                  className="max-h-[400px] overflow-y-auto overflow-x-auto relative"
                >
                  <Table>
                    <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>{t('common.date')}</TableHead>
                        <TableHead>{t('common.description')}</TableHead>
                        <TableHead className="text-right">{t('common.amount')}</TableHead>
                        <TableHead>{t('reconciliation.glAccount')}</TableHead>
                        <TableHead>{t('reconciliation.matchedRule')}</TableHead>
                        {statusFilter !== 'unreconciled' && (
                          <TableHead className="w-[100px]">Reconciled</TableHead>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody
                      style={{
                        height: `${paymentsVirtualizer.getTotalSize()}px`,
                        position: 'relative',
                      }}
                    >
                      {paymentsVirtualizer.getVirtualItems().map((virtualRow) => {
                        const tx = payments[virtualRow.index];
                        return (
                          <TxRow
                            key={tx.id}
                            tx={tx}
                            type="payment"
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              height: `${virtualRow.size}px`,
                              transform: `translateY(${virtualRow.start}px)`,
                            }}
                          />
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {payments.length > 0 && (
                <div className="flex items-center justify-end px-4 py-3 border-t bg-muted/30">
                  <span className="text-sm text-muted-foreground mr-3">
                    {t('reconciliation.total')}:
                  </span>
                  <span className="font-mono font-semibold text-rose-600 dark:text-rose-400">
                    {formatCurrency(summary.paymentsTotal)}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Periods */}
          {recentPeriods.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <HistoryIcon className="size-4" />
                  Recent Reconciliations
                </h3>
                <div className="space-y-2">
                  {recentPeriods.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-muted/20"
                    >
                      <div className="flex items-center gap-3">
                        <Check className="size-4 text-emerald-500" />
                        <div>
                          <p className="text-sm font-medium">
                            {p.transactionCount} {t('reconciliation.transactionsReconciled')}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t('reconciliation.periodCompleted')
                              .replace('{date}', formatDate(p.completedAt!))
                              .replace(
                                '{user}',
                                p.user ? `${p.user.firstName} ${p.user.lastName}` : '—',
                              )}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'text-xs font-mono',
                            Math.abs(p.difference) < 0.005 ? 'text-emerald-600' : 'text-rose-600',
                          )}
                        >
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

      {!selectedAccountId && !loadingAccounts && bankAccounts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-muted mb-4">
            <ArrowLeftRight className="size-8 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">{t('reconciliation.noAccounts')}</p>
        </div>
      )}

      <AutoMatchDialog
        open={autoMatchDialogOpen}
        onOpenChange={setAutoMatchDialogOpen}
        autoMatching={autoMatching}
        autoMatchResult={autoMatchResult}
        createJournalEntries={createJournalEntries}
        onConfirm={handleAutoMatch}
      />

      <ReconcileDialog
        open={reconcileDialogOpen}
        onOpenChange={setReconcileDialogOpen}
        reconciling={reconciling}
        reconcileResult={reconcileResult}
        selectedCount={selectedTxIds.size}
        createJournalEntries={createJournalEntries}
        onConfirm={handleReconcile}
      />

      <UnreconcileDialog
        open={unreconcileDialogOpen}
        onOpenChange={setUnreconcileDialogOpen}
        unreconciling={unreconciling}
        unreconcileResult={unreconcileResult}
        selectedCount={selectedTxIds.size}
        onConfirm={handleUnreconcile}
      />

      <AdjustmentDialog
        open={adjustmentDialogOpen}
        onOpenChange={setAdjustmentDialogOpen}
        adjusting={adjusting}
        adjustForm={adjustForm}
        onFormChange={setAdjustForm}
        accounts={accounts}
        onSave={handleAdjustment}
      />

      <HistoryDialog
        open={historyDialogOpen}
        onOpenChange={setHistoryDialogOpen}
        historyPeriods={historyPeriods}
      />
    </div>
  );
}
