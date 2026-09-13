'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Sparkles, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useLanguageStore } from '@/store/language-store';

// ─── Contract shape (GET /api/learning/structural-candidates) ─────

export interface PendingCandidateApiEntry {
  candidateItemId: string;
  entityId: string;
  glAccountId: string;
  direction: 'debit' | 'credit' | 'any';
  segments: Array<{ kind: string; value?: string }>;
  observationIds: string[];
}

interface StructuralCandidatesClientProps {
  companyId: string;
}

/**
 * Structural generalization productive surface (KE-GENERALIZATION-UI-001).
 *
 * TWO strictly separate actions:
 *   1. "RUN DISCOVERY"  — asks the domain authority to propose candidates
 *      from accumulated observations. NEVER authorizes anything.
 *   2. "AUTHORIZE PATTERN" — explicit human act per candidate, the only
 *      writer of authorized structural patterns.
 */
export function StructuralCandidatesClient({ companyId }: StructuralCandidatesClientProps) {
  const t = useLanguageStore((s) => s.t);

  const [candidates, setCandidates] = useState<PendingCandidateApiEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [authorizingId, setAuthorizingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ companyId });
      const res = await fetch(`/api/learning/structural-candidates?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setCandidates(
        (data.candidates ?? []).map((c: Record<string, unknown>) => c as unknown as PendingCandidateApiEntry),
      );
    } catch {
      toast.error(t('learning.structuralCandidates.fetchError'));
    } finally {
      setLoading(false);
    }
  }, [companyId, t]);

  useEffect(() => {
    if (companyId) void fetchCandidates();
  }, [companyId, fetchCandidates]);

  async function handleDiscover() {
    if (discovering) return;
    setDiscovering(true);
    try {
      const res = await fetch('/api/learning/structural-candidates', { method: 'POST' });
      const body = await res.json();
      if (!res.ok || !body.success) {
        toast.error(body?.error ?? t('learning.structuralCandidates.discoverError'));
        return;
      }
      toast.success(
        t('learning.structuralCandidates.discoverSuccess')
          .replace('{found}', String(body.candidatesFound ?? 0))
          .replace('{recorded}', String(body.candidatesRecorded ?? 0)),
      );
      // Server-authoritative refresh after discovery.
      await fetchCandidates();
    } catch {
      toast.error(t('learning.structuralCandidates.discoverError'));
    } finally {
      setDiscovering(false);
    }
  }

  async function handleAuthorize(candidate: PendingCandidateApiEntry) {
    if (authorizingId) return;
    setAuthorizingId(candidate.candidateItemId);
    try {
      const res = await fetch(
        `/api/learning/structural-candidates/${candidate.candidateItemId}/authorize`,
        { method: 'POST' },
      );
      const body = await res.json();
      if (!res.ok || !body.success) {
        toast.error(body?.error ?? t('learning.structuralCandidates.authorizeError'));
        return;
      }
      toast.success(t('learning.structuralCandidates.authorizeSuccess'));
      // Server-authoritative refresh after authorization.
      await fetchCandidates();
      setSelectedId(null);
    } catch {
      toast.error(t('learning.structuralCandidates.authorizeError'));
    } finally {
      setAuthorizingId(null);
    }
  }

  // Presentation of contract segments: stable → literal token, variable → wildcard.
  function renderPattern(segments: PendingCandidateApiEntry['segments']): string {
    return segments
      .map((s) => (s.kind === 'stable' && typeof s.value === 'string' ? s.value : '*'))
      .join(' ');
  }

  const selected = candidates.find((c) => c.candidateItemId === selectedId) ?? null;

  return (
    <div className="p-6 space-y-4" data-testid="structural-candidates-panel">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('learning.structuralCandidates.title')}</h1>
        <Button onClick={() => void handleDiscover()} disabled={discovering} data-testid="run-discovery-btn">
          {discovering ? (
            <>
              <Loader2 className="size-4 animate-spin mr-1" />
              {t('learning.structuralCandidates.discovering')}
            </>
          ) : (
            <>
              <Sparkles className="size-4 mr-1" />
              {t('learning.structuralCandidates.runDiscovery')}
            </>
          )}
        </Button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          {t('learning.structuralCandidates.loading')}
        </div>
      )}

      {!loading && candidates.length === 0 && (
        <div className="py-10 text-center text-sm text-muted-foreground" data-testid="candidates-empty">
          {t('learning.structuralCandidates.empty')}
        </div>
      )}

      {!loading && candidates.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('learning.structuralCandidates.pattern')}</TableHead>
                <TableHead>{t('learning.structuralCandidates.treatment')}</TableHead>
                <TableHead>{t('learning.structuralCandidates.evidence')}</TableHead>
                <TableHead className="text-center">{t('learning.structuralCandidates.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((c) => (
                <TableRow
                  key={c.candidateItemId}
                  data-testid={`candidate-item-${c.candidateItemId}`}
                  className={selectedId === c.candidateItemId ? 'bg-primary/5 cursor-pointer' : 'cursor-pointer'}
                  onClick={() => setSelectedId(c.candidateItemId)}
                >
                  <TableCell className="font-mono text-sm">{renderPattern(c.segments)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.direction}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t('learning.structuralCandidates.observationsCount').replace('{count}', String(c.observationIds.length))}
                  </TableCell>
                  <TableCell className="text-center">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`authorize-btn-${c.candidateItemId}`}
                      disabled={authorizingId !== null}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleAuthorize(c);
                      }}
                    >
                      {authorizingId === c.candidateItemId ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <>
                          <ShieldCheck className="size-4 mr-1" />
                          {t('learning.structuralCandidates.authorize')}
                        </>
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selected && (
        <div className="space-y-2 rounded-md border p-3" data-testid="candidate-detail">
          <p className="text-sm font-medium">{t('learning.structuralCandidates.detailTitle')}</p>
          <p className="font-mono text-sm">{renderPattern(selected.segments)}</p>
          <p className="text-xs text-muted-foreground">
            {t('learning.structuralCandidates.detailEntity')}: {selected.entityId} ·{' '}
            {t('learning.structuralCandidates.detailDirection')}: {selected.direction}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="candidate-evidence">
            {t('learning.structuralCandidates.detailEvidence')}: {selected.observationIds.join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}
