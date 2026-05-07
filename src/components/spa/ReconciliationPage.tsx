'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  Download,
  Loader2,
  Landmark,
  Play,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCurrency, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';

/* ─── Types ─── */
interface BankAccountOption {
  id: string;
  accountName: string;
  bankName: string;
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
}

interface BankAccountInfo {
  id: string;
  accountName: string;
  bankName: string;
  balance: number;
  currency: string;
  glAccount: GlAccount;
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
  const [accounts, setAccounts] = useState<GlAccountOption[]>([]);

  // Loading
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingData, setLoadingData] = useState(false);

  // Selected transactions for reconciliation
  const [selectedTxIds, setSelectedTxIds] = useState<Set<string>>(new Set());
  const [txGlAssignments, setTxGlAssignments] = useState<Record<string, string>>({});

  // Dialogs
  const [autoMatchDialogOpen, setAutoMatchDialogOpen] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [autoMatchResult, setAutoMatchResult] = useState<{
    matched: number;
    total: number;
  } | null>(null);

  const [reconcileDialogOpen, setReconcileDialogOpen] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<number | null>(null);

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
    } catch {
      // Silently fail
    } finally {
      setLoadingAccounts(false);
    }
  }, [activeCompany?.id]);

  // Fetch GL accounts
  const fetchAccounts = useCallback(async () => {
    if (!activeCompany?.id) return;
    try {
      const res = await fetch(
        `/api/journal/accounts?companyId=${activeCompany.id}`
      );
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.data ?? data);
      }
    } catch {
      // Silently fail
    }
  }, [activeCompany?.id]);

  // Fetch reconciliation data
  const fetchReconciliation = useCallback(async () => {
    if (!activeCompany?.id || !selectedAccountId) return;
    setLoadingData(true);
    setSelectedTxIds(new Set());
    setTxGlAssignments({});
    try {
      const res = await fetch(
        `/api/reconciliation?bankAccountId=${selectedAccountId}&companyId=${activeCompany.id}`
      );
      if (res.ok) {
        const data = await res.json();
        setBankAccountInfo(data.bankAccount);
        setSummary(data.summary);
        setDeposits(data.deposits ?? []);
        setPayments(data.payments ?? []);
      }
    } catch {
      // Silently fail
    } finally {
      setLoadingData(false);
    }
  }, [activeCompany?.id, selectedAccountId]);

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

  // Toggle all visible
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

  // Update GL assignment for a transaction
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
          createJournalEntries: false,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setAutoMatchResult(data);
        fetchReconciliation();
      }
    } catch {
      // Silently fail
    } finally {
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
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setReconcileResult(data.reconciled);
        fetchReconciliation();
      }
    } catch {
      // Silently fail
    } finally {
      setReconciling(false);
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
      'Unreconciled Transactions:',
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

  // Transaction row component
  const TxRow = ({ tx, type }: { tx: Transaction; type: 'deposit' | 'payment' }) => {
    const isSelected = selectedTxIds.has(tx.id);
    const assignedGl = txGlAssignments[tx.id] || tx.glAccountId || null;

    return (
      <TableRow className={cn(isSelected && 'bg-primary/5')}>
        <TableCell className="w-10">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => toggleTx(tx.id)}
          />
        </TableCell>
        <TableCell className="text-sm whitespace-nowrap">
          {formatDate(tx.date)}
        </TableCell>
        <TableCell className="max-w-[200px]">
          <div className="font-medium text-sm truncate">{tx.description}</div>
          {tx.reference && (
            <div className="text-xs text-muted-foreground">{tx.reference}</div>
          )}
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
          <AccountSelector
            accounts={accounts}
            value={assignedGl}
            onChange={(id) => updateTxGl(tx.id, id)}
            placeholder={t('reconciliation.selectGlAccount')}
          />
        </TableCell>
        <TableCell className="w-[120px]">
          {tx.matchedRule ? (
            <Badge variant="secondary" className="text-xs gap-1">
              <Check className="size-3" />
              {tx.matchedRule.name}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
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
          <h2 className="text-2xl font-bold tracking-tight">
            {t('reconciliation.title')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t('reconciliation.reconciliationSubtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedAccountId && (
            <>
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

      {/* Bank Account Selector */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <Landmark className="size-5 text-muted-foreground shrink-0" />
            <div className="flex-1">
              <Label className="text-sm font-medium mb-1 block">
                {t('reconciliation.selectAccount')}
              </Label>
              {loadingAccounts ? (
                <Skeleton className="h-9 w-full max-w-sm" />
              ) : (
                <Select
                  value={selectedAccountId}
                  onValueChange={setSelectedAccountId}
                >
                  <SelectTrigger className="max-w-sm">
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
          </div>
        </CardContent>
      </Card>

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
            {/* Statement Balance */}
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">
                  {t('reconciliation.statementBalance')}
                </p>
                <p className="text-2xl font-bold mt-1">
                  {formatCurrency(summary.statementBalance)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {bankAccountInfo?.accountName}
                </p>
              </CardContent>
            </Card>

            {/* Book Balance */}
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">
                  {t('reconciliation.bookBalance')}
                </p>
                <p className="text-2xl font-bold mt-1">
                  {formatCurrency(summary.bookBalance)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {bankAccountInfo?.glAccount
                    ? `${bankAccountInfo.glAccount.code} - ${bankAccountInfo.glAccount.name}`
                    : ''}
                </p>
              </CardContent>
            </Card>

            {/* Difference */}
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">
                  {t('reconciliation.difference')}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <p
                    className={cn(
                      'text-2xl font-bold',
                      Math.abs(summary.difference) < 0.005
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
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

          {/* Action Bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAutoMatchResult(null);
                setAutoMatchDialogOpen(true);
              }}
              className="gap-2"
            >
              <Play className="size-4" />
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
            <div className="flex-1" />
            <Badge variant="outline" className="text-xs">
              {summary.unreconciledCount} {t('reconciliation.unreconciled').toLowerCase()}
            </Badge>
          </div>

          {/* Deposits / Credits */}
          <Card>
            <CardContent className="p-0">
              <div className="flex items-center justify-between p-4 pb-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold">
                    {t('reconciliation.depositsCredits')}
                  </h3>
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
                  <h3 className="text-sm font-semibold">
                    {t('reconciliation.paymentsDebits')}
                  </h3>
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
        </>
      )}

      {!selectedAccountId && !loadingAccounts && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-muted mb-4">
            <ArrowLeftRight className="size-8 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            {t('reconciliation.selectAccountToStart')}
          </p>
        </div>
      )}

      {/* Auto-Match Dialog */}
      <Dialog open={autoMatchDialogOpen} onOpenChange={setAutoMatchDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('reconciliation.autoMatchTitle')}</DialogTitle>
            <DialogDescription>
              {t('reconciliation.autoMatchDesc')}
            </DialogDescription>
          </DialogHeader>

          {autoMatchResult ? (
            <div className="space-y-4">
              <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                    {autoMatchResult.matched}
                  </p>
                  <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">
                    {t('reconciliation.transactionsMatched')}
                  </p>
                  {autoMatchResult.total > autoMatchResult.matched && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {autoMatchResult.total - autoMatchResult.matched}{' '}
                      {t('reconciliation.stillUnmatched')}
                    </p>
                  )}
                </CardContent>
              </Card>
              <DialogFooter>
                <Button onClick={() => setAutoMatchDialogOpen(false)}>
                  {t('common.confirm')}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setAutoMatchDialogOpen(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleAutoMatch}
                disabled={autoMatching}
                className="gap-2"
              >
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
            <DialogDescription>
              {t('reconciliation.confirmReconcileDesc').replace('{count}', String(selectedTxIds.size))}
            </DialogDescription>
          </DialogHeader>

          {reconcileResult !== null ? (
            <div className="space-y-4">
              <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                    {reconcileResult}
                  </p>
                  <p className="text-sm text-emerald-600 dark:text-emerald-400 mt-1">
                    {t('reconciliation.transactionsReconciled')}
                  </p>
                </CardContent>
              </Card>
              <DialogFooter>
                <Button onClick={() => setReconcileDialogOpen(false)}>
                  {t('common.confirm')}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setReconcileDialogOpen(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleReconcile}
                disabled={reconciling}
                className="gap-2"
              >
                {reconciling && <Loader2 className="size-4 animate-spin" />}
                <Check className="size-4" />
                {t('reconciliation.reconcileSelected')} ({selectedTxIds.size})
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Inline label component for the bank account selector
function Label({ className, children }: { className?: string; children: React.ReactNode }) {
  return <label className={className}>{children}</label>;
}
