'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { toast } from 'sonner';
import { useLanguageStore } from '@/store/language-store';

// ─── Contract shape (GET /api/learning/classification-conflicts) ──

export interface PendingConflictApiEntry {
  conflictItemId: string;
  kind: string;
  authorizedPatternIds: string[];
  exactTreatmentItemIds?: string[];
  conflictingGlAccountId: string;
  observationIds: string[];
  detectedAt: string;
}

interface ClassificationConflictsClientProps {
  companyId: string;
}

/**
 * Conflict lifecycle productive surface (KE-CONFLICT-UI-001).
 *
 * Two SEPARATE human actions:
 *   1. "RESOLVE CONFLICT"  — records the explicit resolution reason.
 *   2. "REHABILITATE KNOWLEDGE" — enabled only afterwards, and ONLY for
 *      knowledge items explicitly implicated by the conflict
 *      (authorizedPatternIds ∪ exactTreatmentItemIds). Legacy conflicts
 *      without exactTreatmentItemIds expose no invented exact target.
 *
 * No target guessing: no derived eligibility beyond the explicit lists.
 */
export function ClassificationConflictsClient({
  companyId,
}: ClassificationConflictsClientProps) {
  const t = useLanguageStore((s) => s.t);

  const [conflicts, setConflicts] = useState<PendingConflictApiEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedConflict, setSelectedConflict] = useState<PendingConflictApiEntry | null>(null);
  const [resolutionReason, setResolutionReason] = useState('');
  const [resolvedConflictIds, setResolvedConflictIds] = useState<Set<string>>(new Set());
  const [rehabilitationTargetId, setRehabilitationTargetId] = useState('');
  const [resolving, setResolving] = useState(false);
  const [rehabilitating, setRehabilitating] = useState(false);

  const fetchConflicts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ companyId });
      const res = await fetch(`/api/learning/classification-conflicts?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setConflicts(
        (data.conflicts ?? []).map((c: Record<string, unknown>) => c as unknown as PendingConflictApiEntry),
      );
    } catch {
      toast.error(t('learning.conflicts.fetchError'));
    } finally {
      setLoading(false);
    }
  }, [companyId, t]);

  useEffect(() => {
    if (companyId) void fetchConflicts();
  }, [companyId, fetchConflicts]);

  function handleSelectConflict(conflict: PendingConflictApiEntry) {
    setSelectedConflict(conflict);
    setResolutionReason('');
    setRehabilitationTargetId('');
  }

  // Explicitly implicated targets only: authorized ∪ exact. The confidence
  // state of the target item is unknown here; the rehabilitation endpoint
  // reports the honest outcome (ALREADY_CERTAIN / NOT_UNCERTAIN / …).
  const implicatedTargetIds: string[] = selectedConflict
    ? [
        ...selectedConflict.authorizedPatternIds,
        ...(selectedConflict.exactTreatmentItemIds ?? []),
      ]
    : [];

  const conflictAlreadyResolved = selectedConflict
    ? resolvedConflictIds.has(selectedConflict.conflictItemId)
    : false;

  async function handleResolve() {
    if (!selectedConflict || resolutionReason.trim() === '') return;
    setResolving(true);
    try {
      const res = await fetch(
        `/api/learning/classification-conflicts/${selectedConflict.conflictItemId}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolutionReason: resolutionReason.trim() }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        toast.error(t('learning.conflicts.resolveFailed'));
        return;
      }
      if (body.status === 'RESOLVED') {
        toast.success(t('learning.conflicts.resolved'));
      } else if (body.status === 'ALREADY_RESOLVED') {
        toast.info(t('learning.conflicts.alreadyResolved'));
      }
      setResolvedConflictIds((prev) => new Set(prev).add(selectedConflict.conflictItemId));
      void fetchConflicts();
    } catch {
      toast.error(t('learning.conflicts.resolveFailed'));
    } finally {
      setResolving(false);
    }
  }

  async function handleRehabilitate() {
    if (!selectedConflict || rehabilitationTargetId === '' || !conflictAlreadyResolved) return;
    setRehabilitating(true);
    try {
      const res = await fetch(
        `/api/learning/classification-conflicts/${selectedConflict.conflictItemId}/rehabilitate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ knowledgeItemId: rehabilitationTargetId }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        // Business refusals (409) are honest outcomes, not generic crashes.
        toast.error(`${body.status ?? 'ERROR'} — ${t('learning.conflicts.rehabilitateRefused')}`);
        return;
      }
      if (body.status === 'REHABILITATED') {
        toast.success(`${t('learning.conflicts.rehabilitated')}: ${body.knowledgeItemId}`);
      } else if (body.status === 'ALREADY_CERTAIN') {
        toast.info(`${body.status} — ${t('learning.conflicts.alreadyCertain')}`);
      }
      setRehabilitationTargetId('');
    } catch {
      toast.error(t('learning.conflicts.rehabilitateFailed'));
    } finally {
      setRehabilitating(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6" data-testid="classification-conflicts-panel">
      <div>
        <h1 className="text-2xl font-bold mb-1">{t('learning.conflicts.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('learning.conflicts.subtitle')}</p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="conflicts-loading">
          {t('common.loading')}
        </p>
      ) : conflicts.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="conflicts-empty">
          {t('learning.conflicts.empty')}
        </p>
      ) : (
        <Table data-testid="conflicts-list">
          <TableHeader>
            <TableRow>
              <TableHead>{t('learning.conflicts.kindLabel')}</TableHead>
              <TableHead>{t('learning.conflicts.glAccountLabel')}</TableHead>
              <TableHead>{t('learning.conflicts.detectedAtLabel')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {conflicts.map((c) => (
              <TableRow
                key={c.conflictItemId}
                data-testid="conflict-item"
                className={selectedConflict?.conflictItemId === c.conflictItemId ? 'bg-muted cursor-pointer' : 'cursor-pointer'}
                onClick={() => handleSelectConflict(c)}
              >
                <TableCell>{c.kind}</TableCell>
                <TableCell>{c.conflictingGlAccountId}</TableCell>
                <TableCell>{c.detectedAt}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {selectedConflict && (
        <div className="border rounded-lg p-4 space-y-4" data-testid="conflict-detail">
          <div className="grid grid-cols-1 gap-1 text-sm">
            <div>
              <span className="font-semibold">{t('learning.conflicts.kindLabel')}: </span>
              {selectedConflict.kind}
            </div>
            <div>
              <span className="font-semibold">{t('learning.conflicts.glAccountLabel')}: </span>
              {selectedConflict.conflictingGlAccountId}
            </div>
            <div>
              <span className="font-semibold">{t('learning.conflicts.observationIdsLabel')}: </span>
              {selectedConflict.observationIds.join(', ')}
            </div>
            <div>
              <span className="font-semibold">{t('learning.conflicts.authorizedPatternsLabel')}: </span>
              {selectedConflict.authorizedPatternIds.join(', ')}
            </div>
            {selectedConflict.exactTreatmentItemIds && (
              <div>
                <span className="font-semibold">{t('learning.conflicts.exactTreatmentsLabel')}: </span>
                {selectedConflict.exactTreatmentItemIds.join(', ')}
              </div>
            )}
            <div>
              <span className="font-semibold">{t('learning.conflicts.detectedAtLabel')}: </span>
              {selectedConflict.detectedAt}
            </div>
          </div>

          {/* ── Action 1: RESOLVE CONFLICT (separate, always first) ── */}
          <div className="space-y-2" data-testid="resolve-section">
            <label className="text-sm font-medium" htmlFor="resolution-reason-input">
              {t('learning.conflicts.reasonLabel')}
            </label>
            <Textarea
              id="resolution-reason-input"
              data-testid="resolution-reason-input"
              value={resolutionReason}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setResolutionReason(e.target.value)}
              placeholder={t('learning.conflicts.reasonPlaceholder')}
            />
            <Button
              data-testid="resolve-conflict-btn"
              onClick={handleResolve}
              disabled={resolving || resolutionReason.trim() === ''}
            >
              {resolving ? t('learning.conflicts.resolving') : t('learning.conflicts.resolveBtn')}
            </Button>
            {conflictAlreadyResolved && (
              <p className="text-sm text-green-700" data-testid="resolution-recorded-hint">
                {t('learning.conflicts.resolutionRecorded')}
              </p>
            )}
          </div>

          {/* ── Action 2: REHABILITATE KNOWLEDGE (separate, enabled only
                after an explicit resolution; targets limited to the
                explicitly implicated ids) ── */}
          <div className="space-y-2" data-testid="rehabilitate-section">
            <label className="text-sm font-medium" htmlFor="rehabilitation-target-select">
              {t('learning.conflicts.rehabilitateLabel')}
            </label>
            <Select
              value={rehabilitationTargetId}
              onValueChange={(value: string) => setRehabilitationTargetId(value)}
              disabled={!conflictAlreadyResolved}
            >
              <SelectTrigger data-testid="rehabilitation-target-select" className="w-[300px]">
                <SelectValue placeholder={t('learning.conflicts.selectTarget')} />
              </SelectTrigger>
              <SelectContent>
                {implicatedTargetIds.map((id) => (
                  <SelectItem key={id} value={id} data-testid="rehabilitation-target-item">
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              data-testid="rehabilitate-knowledge-btn"
              onClick={handleRehabilitate}
              disabled={rehabilitating || !conflictAlreadyResolved}
            >
              {rehabilitating ? t('learning.conflicts.rehabilitating') : t('learning.conflicts.rehabilitateBtn')}
            </Button>
            {!conflictAlreadyResolved && (
              <p className="text-xs text-muted-foreground" data-testid="rehabilitate-disabled-hint">
                {t('learning.conflicts.rehabilitateDisabledHint')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
