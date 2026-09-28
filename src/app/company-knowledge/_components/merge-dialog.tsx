'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuthStore } from '@/store/auth-store';
import type { CompanyKnowledgeRecord } from '@/internal/company-knowledge/client';

interface MergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceRecord: CompanyKnowledgeRecord | null;
  companyId: string;
  onComplete: () => void;
}

// G8-1 §15 — collision envelopes returned by the backend merge contract.
// The backend refuses to auto-select: the user must choose explicitly.
type MergeSideChoice = 'source' | 'target';

interface TreatmentCollision {
  kind: 'treatment';
  source: { itemId: string; glAccountId: string; direction: string };
  target: { itemId: string; glAccountId: string; direction: string };
}

interface AuthorizedPatternCollision {
  kind: 'authorized_pattern';
  direction: string;
  source: { itemIds: string[]; glAccountId: string };
  target: { itemIds: string[]; glAccountId: string };
}

type MergeCollision = TreatmentCollision | AuthorizedPatternCollision;

export function MergeDialog({
  open,
  onOpenChange,
  sourceRecord,
  companyId,
  onComplete,
}: MergeDialogProps) {
  const activeCompany = useAuthStore((s) => s.activeCompany);

  const [targets, setTargets] = useState<CompanyKnowledgeRecord[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [targetRecord, setTargetRecord] = useState<CompanyKnowledgeRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Field resolution state — user must resolve each conflict manually
  const [resolvedName, setResolvedName] = useState('');
  const [resolvedAliases, setResolvedAliases] = useState('');
  const [resolvedRelationship, setResolvedRelationship] = useState('');

  // G8-1 §15 — knowledge collisions (treatment / AP2) reported by the
  // backend; each requires an explicit human choice before merge runs.
  const [collisions, setCollisions] = useState<MergeCollision[]>([]);
  const [treatmentChoice, setTreatmentChoice] = useState<MergeSideChoice | ''>('');
  const [patternChoices, setPatternChoices] = useState<Record<string, MergeSideChoice | ''>>({});

  // Fetch active entities as potential merge targets
  const fetchTargets = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ companyId, status: 'active', limit: '100' });
      const res = await fetch(`/api/company-knowledge?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      // Exclude the source record itself
      const filtered = (data.data || []).filter(
        (r: CompanyKnowledgeRecord) => r.id !== sourceRecord?.id,
      );
      setTargets(filtered);
    } catch (err) {
      console.error('[MergeDialog] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [companyId, sourceRecord?.id]);

  useEffect(() => {
    if (open) {
      fetchTargets();
      setSelectedTargetId('');
      setTargetRecord(null);
      setError('');
      setCollisions([]);
      setTreatmentChoice('');
      setPatternChoices({});
      if (sourceRecord) {
        setResolvedName(sourceRecord.canonicalName);
        setResolvedAliases((sourceRecord.aliases || []).join(', '));
        setResolvedRelationship(sourceRecord.relationship || '');
      }
    }
  }, [open, fetchTargets, sourceRecord]);

  // When target is selected, populate default resolutions from target values
  useEffect(() => {
    if (!selectedTargetId) {
      setTargetRecord(null);
      return;
    }
    const found = targets.find((t) => t.id === selectedTargetId);
    setTargetRecord(found ?? null);

    // A different target means different knowledge collisions — reset them.
    setCollisions([]);
    setTreatmentChoice('');
    setPatternChoices({});

    if (found && sourceRecord) {
      // Pre-fill with source values by default; user can override
      setResolvedName(sourceRecord.canonicalName);
      setResolvedAliases(
        [...new Set([...(sourceRecord.aliases || []), ...(found.aliases || [])])].join(', '),
      );
      setResolvedRelationship(sourceRecord.relationship || found.relationship || '');
    }
  }, [selectedTargetId, targets, sourceRecord]);

  const handleSubmit = async () => {
    if (!sourceRecord || !selectedTargetId || !companyId) return;

    setSubmitting(true);
    setError('');

    const fieldResolutions: Record<string, unknown> = {};

    // Only include fields where there's an actual difference
    if (resolvedName !== sourceRecord.canonicalName) {
      fieldResolutions.canonicalName = resolvedName;
    }

    const newAliases = resolvedAliases.split(',').map((a) => a.trim()).filter(Boolean);
    if (JSON.stringify(newAliases) !== JSON.stringify(sourceRecord.aliases || [])) {
      fieldResolutions.aliases = newAliases;
    }

    if (resolvedRelationship !== (sourceRecord.relationship || '')) {
      fieldResolutions.relationship = resolvedRelationship || null;
    }

    // G8-1 §15 — include the explicit collision resolutions, if any.
    if (treatmentChoice) {
      fieldResolutions.treatment = treatmentChoice;
    }
    const resolvedPatterns = Object.fromEntries(
      Object.entries(patternChoices).filter(([, choice]) => choice !== ''),
    ) as Record<string, MergeSideChoice>;
    if (Object.keys(resolvedPatterns).length > 0) {
      fieldResolutions.authorizedPatterns = resolvedPatterns;
    }

    try {
      const res = await fetch(`/api/company-knowledge/${selectedTargetId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceKnowledgeId: sourceRecord.id,
          targetKnowledgeId: selectedTargetId,
          companyId,
          fieldResolutions,
          reason: `Merged from ${sourceRecord.canonicalName} into target`,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}) as Record<string, unknown>);
        const message =
          typeof data.error === 'string' && data.error.length > 0
            ? data.error
            : 'Merge failed';

        // G8-1: structured collision envelope → show explicit resolution UI.
        let envelope: { code?: string; collisions?: MergeCollision[] } | null = null;
        try {
          envelope = JSON.parse(message) as { code?: string; collisions?: MergeCollision[] };
        } catch {
          envelope = null;
        }
        if (
          envelope &&
          envelope.code === 'G8_1_COLLISION' &&
          Array.isArray(envelope.collisions)
        ) {
          setCollisions(envelope.collisions);
          setError(
            'Knowledge conflicts detected — choose how to resolve each one before merging.',
          );
          return;
        }
        throw new Error(message);
      }

      setCollisions([]);
      onComplete();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setSubmitting(false);
    }
  };

  const collisionsResolved = collisions.every((collision) =>
    collision.kind === 'treatment'
      ? treatmentChoice !== ''
      : (patternChoices[collision.direction] ?? '') !== '',
  );

  const hasDifferences =
    sourceRecord &&
    targetRecord &&
    (sourceRecord.canonicalName !== targetRecord.canonicalName ||
      JSON.stringify(sourceRecord.aliases || []) !==
        JSON.stringify(targetRecord.aliases || []) ||
      sourceRecord.relationship !== targetRecord.relationship);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge Entities</DialogTitle>
          <DialogDescription>
            Merge &ldquo;{sourceRecord?.canonicalName}&rdquo; into a target entity.
            Resolve field conflicts manually — no auto-resolution.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        )}

        <div className="space-y-4">
          {/* Source info */}
          {sourceRecord && (
            <div className="rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">SOURCE</p>
              <p className="font-medium">{sourceRecord.canonicalName}</p>
              <div className="mt-1 flex gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{sourceRecord.type}</Badge>
                <span>v{sourceRecord.version}</span>
                {sourceRecord.relationship && <span>{sourceRecord.relationship}</span>}
              </div>
            </div>
          )}

          {/* Target selector */}
          <div className="space-y-2">
            <Label htmlFor="target-select">Target Entity</Label>
            <Select
              value={selectedTargetId}
              onValueChange={setSelectedTargetId}
              disabled={loading || targets.length === 0}
            >
              <SelectTrigger id="target-select">
                <SelectValue
                  placeholder={
                    loading ? 'Loading...' : targets.length === 0
                      ? 'No active entities available'
                      : 'Select target entity'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.canonicalName} ({t.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Conflict resolution */}
          {sourceRecord && targetRecord && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <p className="text-sm font-medium">
                  {hasDifferences
                    ? 'Resolve field conflicts below'
                    : 'No field conflicts detected'}
                </p>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead>Source Value</TableHead>
                    <TableHead>Target Value</TableHead>
                    <TableHead>Resolved Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">Name</TableCell>
                    <TableCell>{sourceRecord.canonicalName}</TableCell>
                    <TableCell>{targetRecord.canonicalName}</TableCell>
                    <TableCell>
                      <Input
                        value={resolvedName}
                        onChange={(e) => setResolvedName(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Aliases</TableCell>
                    <TableCell>{(sourceRecord.aliases || []).join(', ') || '—'}</TableCell>
                    <TableCell>{(targetRecord.aliases || []).join(', ') || '—'}</TableCell>
                    <TableCell>
                      <Input
                        value={resolvedAliases}
                        onChange={(e) => setResolvedAliases(e.target.value)}
                        className="h-8 text-sm"
                        placeholder="Comma separated"
                      />
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="font-medium">Relationship</TableCell>
                    <TableCell>{sourceRecord.relationship || '—'}</TableCell>
                    <TableCell>{targetRecord.relationship || '—'}</TableCell>
                    <TableCell>
                      <Input
                        value={resolvedRelationship}
                        onChange={(e) => setResolvedRelationship(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}

          {/* G8-1 §15 — explicit knowledge collision resolution */}
          {collisions.length > 0 && (
            <div className="space-y-3 rounded-md border border-amber-500/50 p-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <p className="text-sm font-medium">
                  Knowledge conflicts — explicit resolution required
                </p>
              </div>

              {collisions.map((collision) =>
                collision.kind === 'treatment' ? (
                  <div key="treatment" className="space-y-1">
                    <Label htmlFor="treatment-resolution">
                      Exact treatment conflict (no auto-selection allowed)
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      SOURCE uses GL {collision.source.glAccountId} ({collision.source.direction})
                      — TARGET uses GL {collision.target.glAccountId} ({collision.target.direction}).
                      Choose which treatment stays active under the target.
                    </p>
                    <Select
                      value={treatmentChoice}
                      onValueChange={(v) => setTreatmentChoice(v as MergeSideChoice)}
                    >
                      <SelectTrigger id="treatment-resolution" className="h-8 text-sm">
                        <SelectValue placeholder="Select resolution" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="source">
                          Keep SOURCE treatment (GL {collision.source.glAccountId})
                        </SelectItem>
                        <SelectItem value="target">
                          Keep TARGET treatment (GL {collision.target.glAccountId})
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div key={`pattern-${collision.direction}`} className="space-y-1">
                    <Label htmlFor={`pattern-resolution-${collision.direction}`}>
                      Authorized pattern conflict — direction {collision.direction}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      SOURCE pattern uses GL {collision.source.glAccountId} — TARGET pattern uses
                      GL {collision.target.glAccountId}. Choose which pattern stays active under the
                      target.
                    </p>
                    <Select
                      value={patternChoices[collision.direction] ?? ''}
                      onValueChange={(v) =>
                        setPatternChoices((prev) => ({
                          ...prev,
                          [collision.direction]: v as MergeSideChoice,
                        }))
                      }
                    >
                      <SelectTrigger
                        id={`pattern-resolution-${collision.direction}`}
                        className="h-8 text-sm"
                      >
                        <SelectValue placeholder="Select resolution" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="source">
                          Keep SOURCE pattern (GL {collision.source.glAccountId})
                        </SelectItem>
                        <SelectItem value="target">
                          Keep TARGET pattern (GL {collision.target.glAccountId})
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedTargetId || submitting || !sourceRecord || !collisionsResolved}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Execute Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
