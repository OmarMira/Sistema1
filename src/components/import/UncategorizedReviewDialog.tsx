'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ClipboardList, Loader2, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';
import { logger } from '@/lib/logger';

interface UncategorizedTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  direction: 'credit' | 'debit';
  glAccountId: string | null;
  isReconciled: boolean;
  bankAccountId: string;
  bankAccountName: string;
}

interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FetchState = 'loading' | 'loaded' | 'error';

export function UncategorizedReviewDialog({ open, onOpenChange }: ReviewDialogProps) {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const companyId = activeCompany?.id ?? null;

  const [fetchState, setFetchState] = useState<FetchState>('loading');
  const [transactions, setTransactions] = useState<UncategorizedTransaction[]>([]);
  const [accounts, setAccounts] = useState<GlAccountOption[]>([]);
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [selectedGlId, setSelectedGlId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    if (!companyId) return;
    setFetchState('loading');
    try {
      const [queueRes, accountsRes] = await Promise.all([
        fetch('/api/transactions?classificationStatus=uncategorized'),
        fetch(`/api/journal/accounts?companyId=${companyId}`),
      ]);
      if (!queueRes.ok || !accountsRes.ok) {
        throw new Error('Failed to load review data');
      }
      const queueData = await queueRes.json();
      const accountsData = await accountsRes.json();
      setTransactions(queueData.transactions ?? []);
      setAccounts(accountsData.accounts ?? []);
      setFetchState('loaded');
    } catch (error) {
      logger.error('Failed to load uncategorized review data', { error: String(error) });
      setFetchState('error');
    }
  }, [companyId]);

  useEffect(() => {
    if (open) {
      void fetchQueue();
      setSelectedTxId(null);
      setSelectedGlId(null);
    }
  }, [open, fetchQueue]);

  const handleSelectTx = (tx: UncategorizedTransaction) => {
    setSelectedTxId(tx.id);
    setSelectedGlId(null);
  };

  const handleConfirm = async () => {
    if (!selectedTxId || !selectedGlId || submittingId) return;
    setSubmittingId(selectedTxId);
    try {
      // Single authority: the existing PATCH /api/transactions/[id].
      // It performs accounting + journal + learning + confidence + conflicts.
      const res = await fetch(`/api/transactions/${selectedTxId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ glAccountId: selectedGlId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        toast.error(errBody?.error ?? t('importReview.classifyFailed'));
        return;
      }
      toast.success(t('importReview.classified'));
      // Server-authoritative refresh — no optimistic removal.
      setTransactions((prev) => prev.filter((tx) => tx.id !== selectedTxId));
      setSelectedTxId(null);
      setSelectedGlId(null);
    } catch (error) {
      logger.error('Failed to classify transaction', { error: String(error) });
      toast.error(t('importReview.classifyFailed'));
    } finally {
      setSubmittingId(null);
    }
  };

  const selectedTx = transactions.find((tx) => tx.id === selectedTxId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="size-5" />
            {t('importReview.title')}
          </DialogTitle>
          <DialogDescription>{t('importReview.description')}</DialogDescription>
        </DialogHeader>

        {fetchState === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            {t('importReview.loading')}
          </div>
        )}

        {fetchState === 'error' && (
          <div className="py-10 text-center space-y-3">
            <p className="text-sm text-destructive">{t('importReview.loadError')}</p>
            <Button variant="outline" onClick={() => void fetchQueue()}>
              {t('importReview.retry')}
            </Button>
          </div>
        )}

        {fetchState === 'loaded' && transactions.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <CheckCircle2 className="size-10 text-emerald-500" />
            <p className="text-sm text-muted-foreground">{t('importReview.empty')}</p>
          </div>
        )}

        {fetchState === 'loaded' && transactions.length > 0 && (
          <div className="space-y-4">
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('importReview.date')}</TableHead>
                    <TableHead>{t('importReview.description')}</TableHead>
                    <TableHead className="text-right">{t('importReview.amount')}</TableHead>
                    <TableHead>{t('importReview.account')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transactions.map((tx) => (
                    <TableRow
                      key={tx.id}
                      className={
                        selectedTxId === tx.id
                          ? 'bg-primary/5 cursor-pointer'
                          : 'cursor-pointer'
                      }
                      onClick={() => handleSelectTx(tx)}
                    >
                      <TableCell className="whitespace-nowrap">
                        {new Date(tx.date).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        <span className="block truncate">{tx.description}</span>
                        {tx.isReconciled && (
                          <Badge
                            variant="outline"
                            className="mt-0.5 text-[10px]"
                            data-testid={`reconciled-badge-${tx.id}`}
                          >
                            {t('importReview.reconciled')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono ${
                          tx.direction === 'credit' ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {tx.amount.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{tx.bankAccountName}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {selectedTx && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Tag className="size-4" />
                  {t('importReview.classifyTitle')}
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(selectedTx.date).toLocaleDateString()} · {selectedTx.description} ·{' '}
                  {selectedTx.amount.toFixed(2)}
                </p>
                <AccountSelector
                  accounts={accounts}
                  value={selectedGlId}
                  onChange={(id) => setSelectedGlId(id)}
                  placeholder={t('importReview.selectAccount')}
                />
                <DialogFooter>
                  <Button
                    data-testid="confirm-classify-btn"
                    onClick={() => void handleConfirm()}
                    disabled={!selectedGlId || submittingId !== null}
                  >
                    {submittingId ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        {t('importReview.submitting')}
                      </>
                    ) : (
                      t('importReview.confirm')
                    )}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
