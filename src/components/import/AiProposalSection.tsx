'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useLanguageStore } from '@/store/language-store';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';
import { logger } from '@/lib/logger';
import type { EntityType } from '@/internal/company-knowledge/entity/types';

// JSON-serialized shape of PendingAiProposalItem returned by
// GET /api/import/ai-proposals (dates arrive as ISO strings).
interface AiProposalItem {
  approvalId: string;
  requestedBy: string;
  requestedAt: string;
  bankAccountId: string;
  deterministicResult: unknown;
  aiProposal: {
    role?: string;
    glAccountCode?: string;
    glAccountId?: string | null;
    conditions?: { field: string; operator: string; value: string | number }[];
    suggestSubAccount?: boolean;
    subAccountName?: string | null;
    proposedEntity?: { canonicalName: string; entityType: string } | null;
    [key: string]: unknown;
  };
  proposedEntity: unknown;
  proposedGlAccount: { id: string; code: string; name: string } | null;
  transaction: {
    id: string;
    importHash: string;
    date: string;
    amount: number;
    description: string;
  };
}

interface AiProposalSectionProps {
  companyId: string;
  accounts: GlAccountOption[];
  /** Reports the BankTransaction ids that currently hold a pending proposal
   *  so the host can suppress the legacy PATCH action for those rows. */
  onPendingProposalsChange?: (transactionIds: string[]) => void;
  /** Fired after a server-authoritative refresh (decision applied or
   *  proposal already consumed) so the host can re-fetch its queue. */
  onProposalResolved?: () => void;
}

type FetchState = 'loading' | 'loaded' | 'error';

const ENTITY_TYPE_OPTIONS: EntityType[] = [
  'person',
  'company',
  'financial_product',
  'platform',
  'asset',
];

export function AiProposalSection({
  companyId,
  accounts,
  onPendingProposalsChange,
  onProposalResolved,
}: AiProposalSectionProps) {
  const t = useLanguageStore((s) => s.t);
  // Callbacks live in refs so an inline (unstable) parent callback can never
  // re-trigger the GET loop via the fetchProposals dependency array.
  const onPendingChangeRef = useRef(onPendingProposalsChange);
  onPendingChangeRef.current = onPendingProposalsChange;
  const onResolvedRef = useRef(onProposalResolved);
  onResolvedRef.current = onProposalResolved;
  const [fetchState, setFetchState] = useState<FetchState>('loading');
  const [items, setItems] = useState<AiProposalItem[]>([]);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  // Correct form state (single open form at a time).
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [correctGlId, setCorrectGlId] = useState<string | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [canonicalName, setCanonicalName] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('company');

  const fetchProposals = useCallback(async () => {
    setFetchState('loading');
    try {
      const res = await fetch(`/api/import/ai-proposals?companyId=${companyId}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { proposals?: AiProposalItem[] };
      const proposals = Array.isArray(data.proposals) ? data.proposals : [];
      setItems(proposals);
      setFetchState('loaded');
      onPendingChangeRef.current?.(proposals.map((p) => p.transaction.id));
    } catch (error) {
      logger.error('Failed to load AI proposals', { error: String(error) });
      setFetchState('error');
    }
  }, [companyId]);

  useEffect(() => {
    void fetchProposals();
  }, [fetchProposals]);

  const closeCorrectForm = () => {
    setCorrectingId(null);
    setCorrectGlId(null);
    setIdentityConfirmed(false);
    setCanonicalName('');
    setEntityType('company');
  };

  const openCorrectForm = (item: AiProposalItem) => {
    setCorrectingId(item.approvalId);
    setCorrectGlId(null);
    // Identity is NEVER pre-filled from the AI proposal: it must be
    // confirmed explicitly by the human (T7).
    setIdentityConfirmed(false);
    setCanonicalName('');
    setEntityType('company');
  };

  const decide = async (
    item: AiProposalItem,
    decision: 'ACCEPT' | 'CORRECT' | 'REJECT',
    extra?: { glAccountId?: string; confirmedEntity?: { canonicalName: string; entityType: EntityType } },
  ) => {
    if (submittingId) return;
    setSubmittingId(item.approvalId);
    try {
      const body: Record<string, unknown> = { approvalId: item.approvalId, decision };
      if (decision === 'CORRECT') {
        body.glAccountId = extra?.glAccountId;
        if (extra?.confirmedEntity) body.confirmedEntity = extra.confirmedEntity;
      }
      const res = await fetch(`/api/import/ai-proposals?companyId=${companyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(
          t(
            decision === 'ACCEPT'
              ? 'aiProposals.accepted'
              : decision === 'CORRECT'
                ? 'aiProposals.corrected'
                : 'aiProposals.rejected',
          ),
        );
        closeCorrectForm();
        // Server-authoritative refresh — no optimistic removal.
        await fetchProposals();
        onResolvedRef.current?.();
        return;
      }

      const status = res.status;
      const errBody = (await res.json().catch(() => null)) as { error?: string } | null;

      if (status === 409) {
        toast.error(t('aiProposals.alreadyResolved'));
        await fetchProposals();
        onResolvedRef.current?.();
        return;
      }
      if (status === 404) {
        toast.error(t('aiProposals.notFound'));
        await fetchProposals();
        onResolvedRef.current?.();
        return;
      }
      if (status === 401 || status === 403) {
        toast.error(t('aiProposals.accessError'));
        return;
      }
      // 400 / 422 / other: keep the proposal visible, surface the error.
      toast.error(errBody?.error ?? t('aiProposals.decisionFailed'));
    } catch (error) {
      logger.error('Failed to decide AI proposal', { error: String(error) });
      toast.error(t('aiProposals.decisionFailed'));
    } finally {
      setSubmittingId(null);
    }
  };

  const trimmedName = canonicalName.trim();
  // While identity confirmation is checked, an empty/whitespace name blocks
  // submission — identity must be typed explicitly, never inferred.
  const identityIncomplete = identityConfirmed && trimmedName === '';

  const confirmCorrect = (item: AiProposalItem) => {
    if (!correctGlId || submittingId || identityIncomplete) return;
    const confirmedEntity = identityConfirmed
      ? { canonicalName: trimmedName, entityType }
      : undefined;
    void decide(item, 'CORRECT', { glAccountId: correctGlId, confirmedEntity });
  };

  if (fetchState === 'loading') {
    return (
      <div
        data-testid="ai-proposals-loading"
        className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" />
        {t('aiProposals.loading')}
      </div>
    );
  }

  if (fetchState === 'error') {
    return (
      <div data-testid="ai-proposals-error" className="space-y-2 py-4 text-center">
        <p className="text-sm text-destructive">{t('aiProposals.loadError')}</p>
        <Button
          data-testid="ai-proposals-retry"
          variant="outline"
          size="sm"
          onClick={() => void fetchProposals()}
        >
          {t('importReview.retry')}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div data-testid="ai-proposals-empty" className="py-4 text-center">
        <p className="text-sm text-muted-foreground">{t('aiProposals.empty')}</p>
      </div>
    );
  }

  return (
    <section data-testid="ai-proposal-section" className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4" />
        {t('aiProposals.title')}
      </div>

      {items.map((item) => {
        const proposedAccount = item.proposedGlAccount
          ? `${item.proposedGlAccount.code} ${item.proposedGlAccount.name}`
          : typeof item.aiProposal.glAccountCode === 'string'
            ? item.aiProposal.glAccountCode
            : null;
        const proposedEntityName =
          item.proposedEntity &&
          typeof item.proposedEntity === 'object' &&
          'canonicalName' in item.proposedEntity &&
          typeof (item.proposedEntity as { canonicalName?: unknown }).canonicalName === 'string'
            ? ((item.proposedEntity as { canonicalName: string }).canonicalName)
            : null;
        const submitting = submittingId !== null;

        return (
          <div
            key={item.approvalId}
            data-testid="ai-proposal-item"
            data-approval-id={item.approvalId}
            className="space-y-3 rounded-md border p-3"
          >
            <div className="space-y-1">
              <p className="text-sm font-medium">{item.transaction.description}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(item.transaction.date).toLocaleDateString()} ·{' '}
                {item.transaction.amount.toFixed(2)}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {proposedAccount && (
                <span className="text-muted-foreground">
                  {t('aiProposals.proposedAccount')}:{' '}
                  <span data-testid="ai-proposed-account">{proposedAccount}</span>
                </span>
              )}
              {typeof item.aiProposal.role === 'string' && item.aiProposal.role !== '' && (
                <Badge variant="outline" data-testid="ai-proposal-role">
                  {t('aiProposals.role')}: {item.aiProposal.role}
                </Badge>
              )}
              {proposedEntityName && (
                <Badge variant="outline" data-testid="ai-proposed-entity">
                  {t('aiProposals.proposedEntity')}: {proposedEntityName}
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                data-testid="ai-accept-btn"
                size="sm"
                disabled={submitting}
                onClick={() => void decide(item, 'ACCEPT')}
              >
                {submittingId === item.approvalId ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {t('aiProposals.accept')}
              </Button>
              <Button
                data-testid="ai-correct-btn"
                size="sm"
                variant="outline"
                disabled={submitting}
                onClick={() => (correctingId === item.approvalId ? closeCorrectForm() : openCorrectForm(item))}
              >
                {t('aiProposals.correct')}
              </Button>
              <Button
                data-testid="ai-reject-btn"
                size="sm"
                variant="ghost"
                disabled={submitting}
                onClick={() => void decide(item, 'REJECT')}
              >
                {t('aiProposals.reject')}
              </Button>
            </div>

            {correctingId === item.approvalId && (
              <div data-testid="ai-correct-form" className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">{t('aiProposals.correctTitle')}</p>
                <AccountSelector
                  accounts={accounts}
                  value={correctGlId}
                  onChange={setCorrectGlId}
                  placeholder={t('importReview.selectAccount')}
                />

                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">{t('reclassifyTx.identityTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('reclassifyTx.identityHelp')}</p>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid="ai-identity-toggle"
                      checked={identityConfirmed}
                      onChange={(e) => setIdentityConfirmed(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>{t('reclassifyTx.identityToggle')}</span>
                  </label>
                  {identityConfirmed && (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <label
                          className="text-sm font-medium"
                          htmlFor="ai-identity-canonical-name"
                        >
                          {t('reclassifyTx.canonicalNameLabel')}
                        </label>
                        <input
                          id="ai-identity-canonical-name"
                          data-testid="ai-canonical-name"
                          type="text"
                          value={canonicalName}
                          onChange={(e) => setCanonicalName(e.target.value)}
                          placeholder={t('reclassifyTx.canonicalNamePlaceholder')}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-sm font-medium" htmlFor="ai-identity-entity-type">
                          {t('reclassifyTx.entityTypeLabel')}
                        </label>
                        <select
                          id="ai-identity-entity-type"
                          data-testid="ai-entity-type"
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

                <div className="flex gap-2">
                  <Button
                    data-testid="ai-correct-confirm-btn"
                    size="sm"
                    disabled={!correctGlId || submitting || identityIncomplete}
                    onClick={() => confirmCorrect(item)}
                  >
                    {submittingId === item.approvalId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {t('aiProposals.confirmCorrect')}
                  </Button>
                  <Button
                    data-testid="ai-correct-cancel-btn"
                    size="sm"
                    variant="ghost"
                    disabled={submitting}
                    onClick={closeCorrectForm}
                  >
                    {t('reclassifyTx.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
