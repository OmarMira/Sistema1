'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLanguageStore } from '@/store/language-store';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { EXPECTED_DIRECTION, UI_ROLES, ROLE_LABELS } from '@/lib/constants/entity-roles';
import type { EntityRole } from '@/lib/constants/entity-roles';
import { TRANSACTION_INTENT_VALUES } from '@/lib/constants/transaction-intent';
import type { TransactionIntent } from '@/lib/constants/transaction-intent';
import { classifyDirection } from '@/lib/services/direction-filter';

interface EntityCandidate {
  id: string;
  canonicalName: string;
  occurrences: number;
  directionProfile: {
    creditPct: number;
    debitPct: number;
  };
  sampleDescriptions: string[];
  totalAmount?: number;
}

interface BatchEntry {
  suggestedRole: string;
  confidence: number;
  explanation: string;
  status: 'pending' | 'success' | 'error' | 'accepted' | 'discarded';
}

interface EntityOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  companyId: string;
  onComplete?: () => void;
}

/** Derive a human-readable direction hint from EXPECTED_DIRECTION for the Actor Type badge. */
function getDirectionHint(role: string): string | null {
  const expectedDir = EXPECTED_DIRECTION[role as EntityRole];
  if (expectedDir === null || expectedDir === 'mixed' || expectedDir === undefined) return null;
  return expectedDir === 'credit' ? 'Expected: Income' : 'Expected: Expense';
}

/** Check if a role's expected direction conflicts with the entity's direction profile. */
function checkRoleDirectionMismatch(
  role: string,
  debitPct: number,
  creditPct: number,
): { warning: string; expectedDirection: 'credit' | 'debit' } | null {
  const upperRole = role.toUpperCase();
  const expectedDirection = EXPECTED_DIRECTION[upperRole as EntityRole];

  // OTRO / IGNORADA (null) and SOCIO (mixed) never warn
  if (expectedDirection === null || expectedDirection === 'mixed') return null;

  if (expectedDirection === 'credit' && debitPct > 0.5) {
    return { warning: `${upperRole} expects credits but most transactions are debits`, expectedDirection: 'credit' };
  }

  if (expectedDirection === 'debit' && creditPct > 0.5) {
    return { warning: `${upperRole} expects debits but most transactions are credits`, expectedDirection: 'debit' };
  }

  return null;
}

/** Determine if a direction profile is mixed (both sides >= 0.15). */
function isMixedDirection(profile: { creditPct: number; debitPct: number }): boolean {
  return profile.creditPct >= 0.15 && profile.debitPct >= 0.15;
}

function isValidRoleInput(
  role: string | undefined,
  description: string | undefined,
): boolean {
  if (!role || role === '') return false;
  if (role === 'OTRO') return (description ?? '').trim().length > 0;
  return true;
}

/** Filter OTRO entities with description >= 5 chars for batch classification (FR-2). */
export function getEligibleBatchEntities(
  candidates: EntityCandidate[],
  descriptions: Record<string, string>,
  selections: Record<string, { role: string }>,
  getDefaultRoleFn: (name: string) => string,
): string[] {
  return candidates
    .filter((c) => {
      const role = selections[c.canonicalName]?.role || getDefaultRoleFn(c.canonicalName);
      const desc = descriptions[c.canonicalName];
      return role === 'OTRO' && desc && desc.length >= 5;
    })
    .map((c) => c.canonicalName);
}

export function EntityOnboardingModal({
  isOpen,
  onClose,
  companyId,
  onComplete,
}: EntityOnboardingModalProps) {
  const t = useLanguageStore((s) => s.t);

  // ── Core state ──────────────────────────────────────────────────────
  const [candidates, setCandidates] = useState<EntityCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // canonialName → { role, userInput }
  const [selections, setSelections] = useState<
    Record<string, { role: string; userInput: string }>
  >({});

  // ── 4.1 (F2) — Direction override state ─────────────────────────────
  // canonicalName → true after user clicks "Asignar de todas formas"
  const [directionOverrides, setDirectionOverrides] = useState<
    Record<string, boolean>
  >({});

  // ── 4.2 (F3) — Split state ──────────────────────────────────────────
  // canonicalName → 'credit' | 'debit' | 'both' | null
  const [splitSelections, setSplitSelections] = useState<
    Record<string, 'credit' | 'debit' | 'both' | null>
  >({});

  // ── F1 — Per-entity intent selection state ─────────────────────────
  const [intentSelections, setIntentSelections] = useState<
    Record<string, TransactionIntent | null>
  >({});

  // ── OTRO descriptions + Batch classification state ──────────────────
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [batchResults, setBatchResults] = useState<
    Record<string, BatchEntry | null>
  >({});
  const [batchInProgress, setBatchInProgress] = useState(false);
  const descriptionsSnapshot = useRef<Record<string, string>>({});

  // ── Saved entities — disappear from list after successful save ───────
  const [savedEntities, setSavedEntities] = useState<Set<string>>(new Set([]));
  const savedRef = useRef<Set<string>>(new Set([]));

  // ── Manual mode: show role/intent selectors only when user opts in ──
  const [manualMode, setManualMode] = useState<Set<string>>(new Set());

  // ── Fetch candidates on open ─────────────────────────────────────────
  useEffect(() => {
    if (!companyId || !isOpen) return;

    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const candidatesRes = await fetch(
          `/api/learning/smart-classify?companyId=${companyId}`,
        );

        if (candidatesRes.ok) {
          const data = await candidatesRes.json();
          setCandidates(data.data ?? []);
        } else {
          setError(t('learning.fetchError'));
        }
      } catch (err) {
        logger.error('Error loading entity onboarding data', {
          error: String(err),
        });
        setError(t('learning.loadError'));
      } finally {
        setLoading(false);
      }
    }

    fetchData();

    // Reset all per-candidate state when modal closes
    return () => {
      // Abort any in-flight requests
      for (const controller of Object.values(abortControllers.current)) {
        controller.abort();
      }
      // Reset refs
      abortControllers.current = {};
      loadingRef.current = {};
      selectionsRef.current = {};
      // Reset state
      setDirectionOverrides({});
      setSplitSelections({});
      setDescriptions({});
      setBatchResults({});
      setBatchInProgress(false);
      setIntentSelections({});
      setManualMode(new Set());
    };
  }, [companyId, isOpen, t]);

  // ── Refs for in-flight request management ────────────────────────
  // Abort controllers for in-flight requests per entity
  const abortControllers = useRef<Record<string, AbortController>>({});
  // Synchronous in-flight tracker for batch requests
  const loadingRef = useRef<Record<string, boolean>>({});
  // Synchronous snapshot of selections (avoids stale closure reads in async paths)
  const selectionsRef = useRef<Record<string, { role: string; userInput: string }>>({});

  // ── Batch pre-classification ──────────────────────────────────────────
  async function handlePreClassify() {
    setBatchInProgress(true);

    // 1. Snapshot current descriptions at click time (FR-11)
    descriptionsSnapshot.current = { ...descriptions };

    // 2. Auto-save all non-OTRO entities (they disappear from the list)
    const entries = Object.entries(selectionsRef.current);
    const newlySaved = new Set(savedRef.current);
    for (const [name, sel] of entries) {
      if (!sel.role || sel.role === 'OTRO') continue;
      if (newlySaved.has(name)) continue;

        const splitDir = splitSelections[name];
        const isSplit = splitDir === 'credit' || splitDir === 'debit';
        const intent = intentSelections[name] ?? null;

        if (isSplit) {
          const splitPattern =
          splitDir === 'credit'
            ? `${name} - ingresos`
            : `${name} - retiros`;
        try {
          const res = await fetch('/api/learning/classify-entity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              companyId,
              pattern: splitPattern,
              transactionDirection: splitDir,
              intent,
              ...(!intent ? { role: sel.role } : {}),
            }),
          });
          if (res.ok) newlySaved.add(name);
        } catch (err) {
          logger.error('Error auto-saving split entity', {
            name,
            error: String(err),
          });
        }
        continue;
      }

      try {
        const res = await fetch('/api/learning/classify-entity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              companyId,
              pattern: name,
              userInput: sel.userInput || name,
              directionOverride: directionOverrides[name] || undefined,
              intent,
              ...(!intent ? { role: sel.role } : {}),
            }),
          });
        if (res.ok) {
          newlySaved.add(name);
        } else {
          const errBody = await res.json().catch(() => ({}));
          logger.error('Auto-save API error', {
            name,
            role: sel.role,
            status: res.status,
            error: errBody,
          });
          toast.error(
            `Error al guardar ${name}: ${errBody.error || res.statusText}`,
          );
        }
      } catch (err) {
        logger.error('Error auto-saving entity', {
          name,
          error: String(err),
        });
        toast.error(`Error de red al guardar ${name}`);
      }
    }

    // Update saved tracking if anything was saved
    if (newlySaved.size !== savedRef.current.size) {
      savedRef.current = newlySaved;
      setSavedEntities(newlySaved);
    }

    // 3. Determine eligible OTRO entities (FR-2), excluding already-processed ones
    const eligible = getEligibleBatchEntities(
      candidates,
      descriptionsSnapshot.current,
      selectionsRef.current,
      getDefaultRole,
    ).filter(
      (name) => !batchResults[name] || batchResults[name]?.status === 'error',
    );

    if (eligible.length === 0) {
      setBatchInProgress(false);
      return;
    }

    // 4. Process eligible entities with concurrency pool of max 3 (FR-2)
    let poolIndex = 0;

    async function worker(): Promise<void> {
      while (poolIndex < eligible.length) {
        const name = eligible[poolIndex++];
        const controller = new AbortController();
        abortControllers.current[name] = controller;
        loadingRef.current[name] = true;

        const candidateData = candidates.find((c) => c.canonicalName === name);
        const batchBody: Record<string, unknown> = {
          description: descriptionsSnapshot.current[name],
          companyId,
          sampleDescriptions: candidateData?.sampleDescriptions,
          occurrences: candidateData?.occurrences,
        };
        if (candidateData?.totalAmount) {
          batchBody.totalAmount = { min: candidateData.totalAmount, max: candidateData.totalAmount };
        }

        try {
          const resp = await fetch('/api/learning/suggest-role', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batchBody),
            signal: controller.signal,
          });

          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const data = await resp.json();

          // ── Auto-assignment path ────────────────────────────────────────
          if (data.autoAssign) {
            try {
              const classifyResp = await fetch('/api/learning/classify-entity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  companyId,
                  pattern: name,
                  userInput: descriptionsSnapshot.current[name],
                  role: data.suggestedRole,
                  autoAssign: true,
                }),
              });

              if (classifyResp.ok) {
                const classifyData = await classifyResp.json();
                const contextId = classifyData.data?.entityContext?.id;

                toast.success(
                  `${name} → ${data.suggestedRole} (${Math.round(data.confidence * 100)}%)`,
                  {
                    action: {
                      label: 'Deshacer',
                      onClick: async () => {
                        try {
                          const rollbackResp = await fetch(
                            `/api/learning/auto-assignments/${contextId}/rollback`,
                            { method: 'POST' },
                          );
                          if (rollbackResp.ok) {
                            savedRef.current.delete(name);
                            setSavedEntities(new Set(savedRef.current));
                            toast.success(`${name} restaurado a pendientes`);
                          } else {
                            toast.error('Error al deshacer auto-asignación');
                          }
                        } catch {
                          toast.error('Error de red al deshacer');
                        }
                      },
                    },
                  },
                );

                // Mark entity as saved (skip grid)
                savedRef.current.add(name);
                setSavedEntities(new Set(savedRef.current));
              } else {
                toast.error(`Error al auto-asignar ${name}`);
                // Fall through to grid on failure
                setBatchResults((prev) => ({
                  ...prev,
                  [name]: {
                    suggestedRole: data.suggestedRole,
                    confidence: data.confidence,
                    explanation: data.explanation,
                    status: 'success',
                  },
                }));
              }
            } catch {
              toast.error(`Error de red al auto-asignar ${name}`);
              // Fall through to grid on failure
              setBatchResults((prev) => ({
                ...prev,
                [name]: {
                  suggestedRole: data.suggestedRole,
                  confidence: data.confidence,
                  explanation: data.explanation,
                  status: 'success',
                },
              }));
            }
            return;
          }

          // Normal flow: Update UI progressively as each result resolves
          setBatchResults((prev) => ({
            ...prev,
            [name]: {
              suggestedRole: data.suggestedRole,
              confidence: data.confidence,
              explanation: data.explanation,
              status: 'success',
            },
          }));
        } catch (err) {
          // Update UI immediately with error state
          setBatchResults((prev) => ({
            ...prev,
            [name]: {
              suggestedRole: '',
              confidence: 0,
              explanation: '',
              status: 'error',
            },
          }));
        } finally {
          delete loadingRef.current[name];
          delete abortControllers.current[name];
        }
      }
    }

    const workerCount = Math.min(3, eligible.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.allSettled(workers);
    setBatchInProgress(false);
  }

  // ── Retry a single entity that failed ──────────────────────────────────
  async function handleRetrySuggestion(name: string) {
    if (!descriptions[name]) return;

    const controller = new AbortController();
    abortControllers.current[name] = controller;

    setBatchResults((prev) => ({
      ...prev,
      [name]: {
        suggestedRole: '',
        confidence: 0,
        explanation: '',
        status: 'pending',
      },
    }));

    const candidateData = candidates.find((c) => c.canonicalName === name);
    const retryBody: Record<string, unknown> = {
      description: descriptions[name],
      companyId,
      sampleDescriptions: candidateData?.sampleDescriptions,
      occurrences: candidateData?.occurrences,
    };
    if (candidateData?.totalAmount) {
      retryBody.totalAmount = { min: candidateData.totalAmount, max: candidateData.totalAmount };
    }

    try {
      const resp = await fetch('/api/learning/suggest-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryBody),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      setBatchResults((prev) => ({
        ...prev,
        [name]: {
          suggestedRole: data.suggestedRole,
          confidence: data.confidence,
          explanation: data.explanation,
          status: 'success',
        },
      }));
    } catch (err) {
      setBatchResults((prev) => ({
        ...prev,
        [name]: {
          suggestedRole: '',
          confidence: 0,
          explanation: '',
          status: 'error',
        },
      }));
    } finally {
      delete abortControllers.current[name];
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  function getDefaultRole(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('inquilino') || lower.includes('rent') || lower.includes('alquiler'))
      return 'INQUILINO';
    if (lower.includes('proveedor') || lower.includes('supplier') || lower.includes('vendor'))
      return 'PROVEEDOR';
    if (lower.includes('socio') || lower.includes('partner') || lower.includes('member'))
      return 'SOCIO';
    if (lower.includes('cliente') || lower.includes('customer') || lower.includes('client'))
      return 'CLIENTE';
    if (lower.includes('empleado') || lower.includes('employee') || lower.includes('salary'))
      return 'EMPLEADO';
    if (selections[name]?.role) return selections[name].role;
    return '';
  }

  function updateSelection(
    name: string,
    field: 'role' | 'userInput',
    value: string | null,
  ) {
    // Sync ref synchronously (BEFORE React reconciles) so async paths see current state
    selectionsRef.current = {
      ...selectionsRef.current,
      [name]: {
        ...(selectionsRef.current[name] || {
          role: getDefaultRole(name),
          userInput: '',
        }),
        [field]: value,
      },
    };
    setSelections((prev) => {
      const existing = prev[name];
      const base = existing || {
        role: getDefaultRole(name),
        userInput: '',
      };
      return {
        ...prev,
        [name]: {
          ...base,
          [field]: value,
        },
      };
    });
  }

  // ── 4.1 — Handle direction override ─────────────────────────────────
  function handleDirectionOverride(canonicalName: string) {
    setDirectionOverrides((prev) => ({ ...prev, [canonicalName]: true }));
    logger.warn('[DIRECTION OVERRIDE]', { canonicalName });
    toast.info(t('learning.directionOverrideAcknowledge'), { duration: 3000 });
  }

  // ── 4.2 — Handle split selection ────────────────────────────────────
  function handleSplitChange(
    canonicalName: string,
    direction: 'credit' | 'debit' | 'both',
  ) {
    setSplitSelections((prev) => ({ ...prev, [canonicalName]: direction }));
  }

  // ── Handle description change ──
  function handleDescriptionChange(canonicalName: string, value: string) {
    setDescriptions((prev) => ({ ...prev, [canonicalName]: value }));
    // If OTRO with description >= 5 chars, clear stale batch result (FR-11)
    const selection = selectionsRef.current[canonicalName];
    const role = selection?.role || getDefaultRole(canonicalName);
    if (role === 'OTRO' && value.length >= 5) {
      setBatchResults((prev) => ({ ...prev, [canonicalName]: null }));
    }
  }

  // ── Handle role change ──
  function handleRoleChange(canonicalName: string, newRole: string) {
    updateSelection(canonicalName, 'role', newRole);
    if (newRole !== 'OTRO') {
      // Abort any in-flight request for this entity
      if (abortControllers.current[canonicalName]) {
        abortControllers.current[canonicalName].abort();
        delete abortControllers.current[canonicalName];
      }
      delete loadingRef.current[canonicalName];
      setDescriptions((prev) => ({ ...prev, [canonicalName]: '' }));
      setBatchResults((prev) => ({ ...prev, [canonicalName]: null }));
    }
  }

  function handleIntentChange(canonicalName: string, value: string) {
    const intent = value === 'none' ? null : (value as TransactionIntent);
    setIntentSelections((prev) => ({ ...prev, [canonicalName]: intent }));

    if (intent !== 'OTHER') {
      setDescriptions((prev) => ({ ...prev, [canonicalName]: '' }));
    }
  }

  // ── Single-entity pre-classification ─────────────────────────────────
  async function handlePreClassifyOne(name: string, directionProfile?: { creditPct: number; debitPct: number }) {
    if (loadingRef.current[name]) return;
    const result = batchResults[name];
    if (result && result.status !== 'error' && result.status !== 'discarded') return;

    const controller = new AbortController();
    abortControllers.current[name] = controller;
    loadingRef.current[name] = true;

    setBatchResults((prev) => ({
      ...prev,
      [name]: { suggestedRole: '', confidence: 0, explanation: '', status: 'pending' },
    }));

    const candidateData = candidates.find((c) => c.canonicalName === name);
    const body: Record<string, unknown> = {
      description: descriptionsSnapshot.current[name] || descriptions[name] || name,
      companyId,
      directionProfile,
      sampleDescriptions: candidateData?.sampleDescriptions,
      occurrences: candidateData?.occurrences,
      manualRequest: true,
    };
    if (candidateData?.totalAmount) {
      body.totalAmount = { min: candidateData.totalAmount, max: candidateData.totalAmount };
    }

    try {
      const resp = await fetch('/api/learning/suggest-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      setBatchResults((prev) => ({
        ...prev,
        [name]: {
          suggestedRole: data.suggestedRole,
          confidence: data.confidence,
          explanation: data.explanation,
          status: 'success',
        },
      }));
    } catch (err) {
      setBatchResults((prev) => ({
        ...prev,
        [name]: { suggestedRole: '', confidence: 0, explanation: '', status: 'error' },
      }));
    } finally {
      delete abortControllers.current[name];
      delete loadingRef.current[name];
    }
  }

  // ── Batch suggestion actions ──────────────────────────────────────────
  function handleAcceptSuggestion(canonicalName: string, role: string) {
    updateSelection(canonicalName, 'role', role);
    setBatchResults((prev) => {
      const existing = prev[canonicalName];
      if (!existing) return prev;
      return { ...prev, [canonicalName]: { ...existing, status: 'accepted' } };
    });
  }

  function handleDiscardSuggestion(canonicalName: string) {
    setBatchResults((prev) => {
      const existing = prev[canonicalName];
      if (!existing) return prev;
      return { ...prev, [canonicalName]: { ...existing, status: 'discarded' } };
    });
  }

  function handleEditRole(canonicalName: string) {
    // Focus the role SelectTrigger so the dropdown opens
    const trigger = document.querySelector(`[data-candidate="${canonicalName}"]`);
    if (trigger instanceof HTMLElement) {
      trigger.click();
      trigger.focus();
    }
  }

  // ── Save all classifications ────────────────────────────────────────
  async function handleClassifyAll() {
    const pendingCandidates = candidates.filter(
      (candidate) => !savedRef.current.has(candidate.canonicalName),
    );
    if (pendingCandidates.length === 0) return;

    setSaving(true);
    setError(null);
    let count = 0;
    const savedBefore = savedRef.current.size;

    for (const candidate of pendingCandidates) {
      const pattern = candidate.canonicalName;
      // Skip entities already auto-saved during pre-classify
      if (savedRef.current.has(pattern)) continue;

      const sel = selections[pattern];
      const role = sel?.role || getDefaultRole(pattern);
      if (!isValidRoleInput(role, descriptions[pattern])) continue;

      const splitDir = splitSelections[pattern];
      const isSplit = splitDir === 'credit' || splitDir === 'debit';
      const intent = intentSelections[pattern] ?? null;

      if (role === 'OTRO') {
        const userDesc = descriptions[pattern] || '';

        try {
          const res = await fetch('/api/learning/classify-entity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              companyId,
              pattern,
              source: 'user',
              userDescription: userDesc.trim(),
              role,
              intent,
            }),
          });

          if (res.ok) {
            count++;
            savedRef.current.add(pattern);
          } else {
            logger.warn('[OTRO SAVE FAILED]', { pattern, status: res.status });
          }
        } catch (err) {
          logger.error('[OTRO SAVE ERROR]', { pattern, error: String(err) });
        }
        continue;
      }

      if (isSplit) {
        // 4.2 — Save the split entity with suffixed pattern and transactionDirection
        const splitPattern =
          splitDir === 'credit'
            ? `${pattern} - ingresos`
            : `${pattern} - retiros`;

        try {
          const res = await fetch('/api/learning/classify-entity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              companyId,
              pattern: splitPattern,
              source: 'user',
              transactionDirection: splitDir,
              role,
              intent,
            }),
          });

          if (res.ok) {
            count++;
          } else {
            logger.warn('[SPLIT SAVE FAILED]', { pattern, splitPattern, status: res.status });
          }
        } catch (err) {
          logger.error('Error saving split entity', {
            pattern,
            error: String(err),
          });
        }
        // Do NOT save the original pattern — it stays for next scan
        continue;
      }

      // Normal save (including split = 'both')
      try {
        const res = await fetch('/api/learning/classify-entity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              companyId,
              pattern,
              userInput: selectionsRef.current[pattern]?.userInput || pattern,
              source: 'user',
              directionOverride: directionOverrides[pattern] || undefined,
              role,
              intent,
          }),
        });

        if (res.ok) {
          count++;
          savedRef.current.add(pattern);
        } else {
          logger.warn('[ENTITY SAVE FAILED]', { pattern, status: res.status });
        }
      } catch (err) {
        logger.error('Error classifying entity', {
          pattern,
          error: String(err),
        });
      }
    }

    setSavedCount(count);
    if (savedRef.current.size !== savedBefore) {
      setSavedEntities(new Set(savedRef.current));
    }

    if (count === 0) {
      const message = t('learning.customRoleMissing').replace(
        '{count}',
        String(pendingCandidates.length),
      );
      setError(message);
      toast.warning(message);
      setSaving(false);
      return;
    }

    const skipped = pendingCandidates.length - count;
    if (skipped > 0) {
      toast.warning(
        t('learning.classifiedCount').replace('{count}', String(count)) +
          '. ' +
          t('learning.customRoleMissing').replace('{count}', String(skipped)),
      );
    } else {
      toast.success(
        t('learning.classifiedCount').replace('{count}', String(count)),
      );
    }
    setSaving(false);

    // Check if there are still pending entities
    const stillPending = candidates.filter(
      (c) => !savedRef.current.has(c.canonicalName),
    );

    if (onComplete) onComplete();

    // Only close modal if all entities are classified
    if (stillPending.length === 0) {
      onClose();
    }
  }

  const remainingCandidates = candidates.filter(
    (c) => !savedEntities.has(c.canonicalName),
  );

  const hasValidRoleAssignments = remainingCandidates.some((candidate) => {
      const sel = selections[candidate.canonicalName];
      const role = sel?.role || getDefaultRole(candidate.canonicalName);
      return isValidRoleInput(role, descriptions[candidate.canonicalName]);
    });

  // Check for unresolved OTRO entities with descriptions (eligible for batch pre-classify)
  const eligibleForBatch = remainingCandidates.filter((candidate) => {
    const sel = selections[candidate.canonicalName];
    const role = sel?.role || getDefaultRole(candidate.canonicalName);
    const desc = descriptions[candidate.canonicalName];
    if (role !== 'OTRO' || !desc || desc.length < 5) return false;
    const result = batchResults[candidate.canonicalName];
    return !result || result.status === 'error';
  });

  const hasUnresolvedOtro = eligibleForBatch.length > 0;

  const buttonState = (() => {
    if (batchInProgress) {
      return {
        text: t('learning.batch.loading'),
        disabled: true,
        showSpinner: true,
        onClick: undefined,
      };
    }
    if (hasUnresolvedOtro) {
      return {
        text: t('learning.preClassify'),
        disabled: false,
        showSpinner: false,
        onClick: handlePreClassify,
      };
    }
    return {
      text: t('learning.classify'),
      disabled: !hasValidRoleAssignments,
      showSpinner: false,
      onClick: hasValidRoleAssignments ? handleClassifyAll : undefined,
    };
  })();

  if (!isOpen) return null;

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('learning.onboardingTitle')}
            {remainingCandidates.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                {remainingCandidates.length}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>{t('learning.onboardingDesc')}</DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-center gap-2 p-3 text-sm bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 rounded-md">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : remainingCandidates.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
            <p>{t('learning.allClassified')}</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {remainingCandidates.map((candidate) => {
              const sel = selections[candidate.canonicalName];
              const selectedIntent = intentSelections[candidate.canonicalName] ?? null;
              const role = sel?.role || '';
              const name = candidate.canonicalName;

              // Direction label
              const directionLabel = (() => {
                const profile = classifyDirection(candidate.directionProfile);
                if (profile === 'credit') return t('learning.directionCredit');
                if (profile === 'debit') return t('learning.directionDebit');
                return t('learning.directionMixed');
              })();

              // 4.2 — Detect mixed direction
              const mixed = isMixedDirection(candidate.directionProfile);
              const currentSplit = splitSelections[name] ?? null;

              // ── State flags for this entity ──
              const result = batchResults[name];
              const isInManualMode = manualMode.has(name);
              const hasSuggestion = result?.status === 'success' || result?.status === 'accepted';
              const showPreClassifyBtn = !result || result.status === 'discarded' || result.status === 'error';
              const showSelectors = isInManualMode || hasSuggestion;

              // ── OTRO description handling ──
              const isOtro = role === 'OTRO' || selectedIntent === 'OTHER';
              const descValue = descriptions[name] ?? '';

              return (
                <div
                  key={candidate.id}
                  className="border rounded-lg p-4 space-y-3 bg-card shadow-sm"
                >
                  {/* Header: name + transaction count + direction */}
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-base truncate text-primary">
                      {candidate.canonicalName}
                      <span className="text-muted-foreground font-normal text-xs ml-1.5">
                        {t('learning.transactions').replace(
                          '{count}',
                          String(candidate.occurrences),
                        )}
                        {' · '}
                        {directionLabel}
                      </span>
                    </h4>
                  </div>

                  {/* ── 4.2 (F3) — Split UI for mixed direction ────────── */}
                  {mixed && role && role !== 'OTRO' && (
                    <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-md p-3 space-y-2">
                      <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
                        {t('learning.splitTitle')}
                      </p>
                      <div className="flex gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant={currentSplit === 'credit' ? 'default' : 'outline'}
                          onClick={() => handleSplitChange(name, 'credit')}
                          disabled={saving}
                        >
                          {t('learning.splitCredit')}
                        </Button>
                        <Button
                          size="sm"
                          variant={currentSplit === 'debit' ? 'default' : 'outline'}
                          onClick={() => handleSplitChange(name, 'debit')}
                          disabled={saving}
                        >
                          {t('learning.splitDebit')}
                        </Button>
                        <Button
                          size="sm"
                          variant={currentSplit === 'both' ? 'default' : 'outline'}
                          onClick={() => handleSplitChange(name, 'both')}
                          disabled={saving}
                        >
                          {t('learning.splitBoth')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* ── F2 — Actor Type badge + direction hint ───────────── */}
                  {hasSuggestion && (
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs text-muted-foreground font-medium">
                        {t('learning.actorTypeLabel')}: {ROLE_LABELS[role as EntityRole] || role}
                      </span>
                      {getDirectionHint(role) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {getDirectionHint(role)}
                        </span>
                      )}
                    </div>
                  )}

                  {/* ── No suggestion yet: show Pre-classify + Manual buttons ── */}
                  {showPreClassifyBtn && !showSelectors && !savedEntities.has(name) && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-8 text-sm"
                        data-testid="pre-classify-btn"
                        onClick={() => handlePreClassifyOne(name, candidate.directionProfile)}
                        disabled={loadingRef.current[name] || saving}
                      >
                        {loadingRef.current[name] ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            {t('learning.suggestionBanner.pending')}
                          </>
                        ) : (
                          <>🤖 {t('learning.preClassify')}</>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 text-xs text-muted-foreground"
                        data-testid="manual-select-btn"
                        onClick={() => setManualMode((prev) => new Set([...prev, name]))}
                        disabled={saving}
                      >
                        {t('learning.manualSelection')}
                      </Button>
                    </div>
                  )}

                  {/* ── Suggestion banner (AI suggested) ── */}
                  {result?.status === 'success' && (
                    <div className="flex items-center justify-between gap-3 p-3 text-sm border rounded-md bg-muted/30">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">
                          {t('learning.suggestionBanner.title', { role: ROLE_LABELS[result.suggestedRole as EntityRole] || result.suggestedRole })}
                        </span>
                        <span className={result.confidence >= 0.7 ? 'text-green-600' : 'text-yellow-600'}>
                          {result.confidence >= 0.7
                            ? t('learning.suggestionBanner.confidence', { percent: Math.round(result.confidence * 100) })
                            : t('learning.suggestionBanner.lowConfidence', { percent: Math.round(result.confidence * 100) })}
                        </span>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          data-testid="accept-suggestion-btn"
                          onClick={() => handleAcceptSuggestion(name, result.suggestedRole)}
                        >
                          ✅ {t('learning.suggestionBanner.accept')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          data-testid="discard-suggestion-btn"
                          onClick={() => handleDiscardSuggestion(name)}
                        >
                          ❌ {t('learning.suggestionBanner.discard')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          data-testid="edit-role-btn"
                          onClick={() => setManualMode((prev) => new Set([...prev, name]))}
                        >
                          ✏️ {t('learning.suggestionBanner.edit')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* ── Accepted suggestion — confirmed badge ── */}
                  {result?.status === 'accepted' && (
                    <div className="flex items-center gap-2 p-2 text-sm text-green-600 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      {t('learning.suggestionBanner.assigned', { role: ROLE_LABELS[result.suggestedRole as EntityRole] || result.suggestedRole })}
                    </div>
                  )}

                  {/* ── Error banner — retry button ── */}
                  {result?.status === 'error' && (
                    <div className="space-y-2">
                      <div className="flex items-start gap-2 p-2.5 text-sm text-amber-700 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md">
                        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <p className="text-xs leading-relaxed">
                            {t('learning.suggestionBanner.error')}
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs border-amber-300 dark:border-amber-700"
                            onClick={() => handleRetrySuggestion(name)}
                            disabled={batchInProgress || saving}
                          >
                            <RefreshCw className="h-3 w-3 mr-1" />
                            {t('learning.suggestionBanner.retry')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Manual selectors (role + intent) — only in manual mode or after suggestion accepted ── */}
                  {showSelectors && (
                    <div className="space-y-2 border-t pt-2">
                      {/* Role dropdown */}
                      <div className="w-full">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t('learning.selectRole')}
                        </label>
                        <Select
                          value={role || ''}
                          onValueChange={(newRole) => handleRoleChange(name, newRole)}
                          disabled={saving}
                        >
                          <SelectTrigger className="h-8 text-sm" data-testid="role-select">
                            <SelectValue placeholder={t('learning.rolePlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {UI_ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {ROLE_LABELS[r] || r}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* ── F2 — Direction mismatch warning ───────────── */}
                      {(() => {
                        const mismatch = checkRoleDirectionMismatch(
                          role,
                          candidate.directionProfile.debitPct,
                          candidate.directionProfile.creditPct,
                        );
                        if (!mismatch || directionOverrides[name]) return null;
                        return (
                          <div className="flex items-start gap-2 p-2.5 text-sm bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md">
                            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-amber-700 dark:text-amber-300">
                                {mismatch.warning}
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs mt-1.5 border-amber-300 dark:border-amber-700"
                                onClick={() => handleDirectionOverride(name)}
                                disabled={saving}
                              >
                                {t('learning.directionOverride')}
                              </Button>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Intent dropdown — visually secondary */}
                      <div className="w-full">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t('learning.intentLabel')}
                        </label>
                        <Select
                          value={intentSelections[name] ?? 'none'}
                          onValueChange={(v) => handleIntentChange(name, v)}
                          disabled={saving}
                        >
                          <SelectTrigger className="h-7 text-xs" data-testid="intent-select">
                            <SelectValue placeholder={t('learning.intentPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">
                              {t('learning.intentPlaceholder')}
                            </SelectItem>
                            {TRANSACTION_INTENT_VALUES.map((intent) => (
                              <SelectItem key={intent} value={intent}>
                                {t(`transactionIntent.${intent}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* OTRO textarea */}
                      {isOtro && (
                        <div className="w-full">
                          <Textarea
                            placeholder={t('learning.otroDescription')}
                            value={descValue}
                            onChange={(e) => handleDescriptionChange(name, e.target.value)}
                            disabled={saving}
                            className="min-h-[60px] text-sm"
                          />
                          {/* Pre-clasificar button inside OTRO */}
                          {role === 'OTRO' && descValue.trim().length >= 5 && (!result || result.status === 'error' || result.status === 'discarded') && (
                            <Button
                              size="sm"
                              variant="secondary"
                              className="h-7 text-xs mt-2"
                              data-testid="pre-classify-btn"
                              onClick={() => handlePreClassifyOne(name, candidate.directionProfile)}
                              disabled={loadingRef.current[name] || saving}
                            >
                              {loadingRef.current[name] ? (
                                <>
                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                  {t('learning.suggestionBanner.pending')}
                                </>
                              ) : (
                                <>🤖 {t('learning.preClassify')}</>
                              )}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="gap-2 pt-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {savedCount > 0 ? t('learning.close') : t('common.cancel')}
          </Button>
          {candidates.length > 0 && (
            <Button
              onClick={buttonState.onClick || handleClassifyAll}
              disabled={saving || buttonState.disabled}
            >
              {(saving || buttonState.showSpinner) ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {saving ? t('learning.saving') : buttonState.text}
                </>
              ) : (
                buttonState.text
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
