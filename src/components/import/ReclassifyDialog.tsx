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
import type { EntityType } from '@/internal/company-knowledge/entity/types';

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

const ENTITY_TYPE_OPTIONS: EntityType[] = [
  'person',
  'company',
  'financial_product',
  'platform',
  'asset',
];

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
  // Identity confirmation is opt-in: the section only appears when the
  // status GET reports entityStatus === 'UNKNOWN'.
  const [entityStatus, setEntityStatus] = useState<'UNKNOWN' | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [canonicalName, setCanonicalName] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('company');

  useEffect(() => {
    // Reset selection and identity state each time the dialog opens for a
    // (new) transaction — identity decisions never leak across transactions.
    setSelectedGlId(null);
    setEntityStatus(null);
    setIdentityConfirmed(false);
    setCanonicalName('');
    setEntityType('company');

    if (!transaction) return;
    let cancelled = false;

    // Entity-status probe: any failure, non-200, or non-UNKNOWN result keeps
    // the identity section hidden — the dialog degrades to GL-only.
    (async () => {
      try {
        const res = await fetch(`/api/transactions/${transaction.id}`);
        if (cancelled || !res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          entityStatus?: string;
        } | null;
        if (!cancelled && data?.entityStatus === 'UNKNOWN') {
          setEntityStatus('UNKNOWN');
        }
      } catch {
        // Network failure → stay GL-only; nothing to show.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transaction?.id]);

  const currentGlId = transaction?.glAccountId ?? null;
  const isNoOp = selectedGlId !== null && selectedGlId === currentGlId;
  const trimmedName = canonicalName.trim();
  // While identity confirmation is checked, an empty/whitespace name blocks
  // submission — identity must be typed explicitly, never inferred.
  const identityIncomplete = identityConfirmed && trimmedName === '';

  const handleConfirm = async () => {
    if (!transaction || !selectedGlId || submitting || isNoOp || identityIncomplete) return;
    setSubmitting(true);
    try {
      // Single authority: the existing PATCH /api/transactions/[id] — it voids
      // the previous journal entry, re-posts, recalculates balances and teaches
      // the Knowledge Engine per the already-published contract.
      // confirmedEntity is added ONLY on explicit confirmation (toggle checked
      // AND a non-empty typed name); otherwise the body stays GL-only.
      const patchBody: Record<string, unknown> = { glAccountId: selectedGlId };
      if (identityConfirmed && trimmedName !== '') {
        patchBody.confirmedEntity = {
          canonicalName: trimmedName,
          entityType,
        };
      }
      const res = await fetch(`/api/transactions/${transaction.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
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

            {entityStatus === 'UNKNOWN' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">{t('reclassifyTx.identityTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('reclassifyTx.identityHelp')}</p>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="identity-confirm-toggle"
                    checked={identityConfirmed}
                    onChange={(e) => setIdentityConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{t('reclassifyTx.identityToggle')}</span>
                </label>
                {identityConfirmed && (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <label className="text-sm font-medium" htmlFor="identity-canonical-name">
                        {t('reclassifyTx.canonicalNameLabel')}
                      </label>
                      <input
                        id="identity-canonical-name"
                        data-testid="identity-canonical-name"
                        type="text"
                        value={canonicalName}
                        onChange={(e) => setCanonicalName(e.target.value)}
                        placeholder={t('reclassifyTx.canonicalNamePlaceholder')}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium" htmlFor="identity-entity-type">
                        {t('reclassifyTx.entityTypeLabel')}
                      </label>
                      <select
                        id="identity-entity-type"
                        data-testid="identity-entity-type"
                        value={entityType}
                        onChange={(e) => setEntityType(e.target.value as EntityType)}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {ENTITY_TYPE_OPTIONS.map((type) => (
                          <option key={type} value={type}>
                            {t(`reclassifyTx.entityTypes.${type}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('reclassifyTx.cancel')}
              </Button>
              <Button
                data-testid="confirm-reclassify-btn"
                onClick={() => void handleConfirm()}
                disabled={!selectedGlId || isNoOp || submitting || identityIncomplete}
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
