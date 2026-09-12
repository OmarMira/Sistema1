'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';
import { logger } from '@/lib/logger';

interface ReclassifyTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  glAccountId: string | null;
  glAccount: { id: string; code: string; name: string } | null;
}

interface ReclassifyDialogProps {
  transaction: ReclassifyTransaction | null;
  accounts: GlAccountOption[];
  onOpenChange: (open: boolean) => void;
  onReclassified: (transactionId: string, newGlAccountId: string) => void;
}

export function ReclassifyDialog({
  transaction,
  accounts,
  onOpenChange,
  onReclassified,
}: ReclassifyDialogProps) {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const [selectedGlId, setSelectedGlId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Reset selection each time the dialog opens for a (new) transaction.
    setSelectedGlId(null);
  }, [transaction?.id]);

  const currentGlId = transaction?.glAccountId ?? null;
  const isNoOp = selectedGlId !== null && selectedGlId === currentGlId;

  const handleConfirm = async () => {
    if (!transaction || !selectedGlId || submitting || isNoOp) return;
    setSubmitting(true);
    try {
      // Single authority: the existing PATCH /api/transactions/[id] — it voids
      // the previous journal entry, re-posts, recalculates balances and teaches
      // the Knowledge Engine per the already-published contract.
      const res = await fetch(`/api/transactions/${transaction.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ glAccountId: selectedGlId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        toast.error(errBody?.error ?? t('reclassifyTx.failed'));
        return;
      }
      toast.success(t('reclassifyTx.success'));
      onReclassified(transaction.id, selectedGlId);
      onOpenChange(false);
    } catch (error) {
      logger.error('Failed to reclassify transaction', { error: String(error) });
      toast.error(t('reclassifyTx.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={transaction !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCcw className="size-5" />
            {t('reclassifyTx.title')}
          </DialogTitle>
          <DialogDescription>{t('reclassifyTx.description')}</DialogDescription>
        </DialogHeader>

        {transaction && (
          <div className="space-y-4">
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">{transaction.description}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(transaction.date).toLocaleDateString()} ·{' '}
                {transaction.amount.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('reclassifyTx.currentAccount')}:{' '}
                <span data-testid="current-gl-label">
                  {transaction.glAccount
                    ? `${transaction.glAccount.code} ${transaction.glAccount.name}`
                    : t('reclassifyTx.noAccount')}
                </span>
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('reclassifyTx.newAccount')}</label>
              <AccountSelector
                accounts={accounts}
                value={selectedGlId}
                onChange={(id) => setSelectedGlId(id)}
                placeholder={t('reclassifyTx.selectAccount')}
              />
              {isNoOp && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {t('reclassifyTx.sameAccount')}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('reclassifyTx.cancel')}
              </Button>
              <Button
                data-testid="confirm-reclassify-btn"
                onClick={() => void handleConfirm()}
                disabled={!selectedGlId || isNoOp || submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('reclassifyTx.submitting')}
                  </>
                ) : (
                  t('reclassifyTx.confirm')
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
