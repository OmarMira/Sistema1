'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { EXPECTED_DIRECTION, UI_ROLES, ROLE_LABELS } from '@/lib/constants/entity-roles';
import type { EntityRole } from '@/lib/constants/entity-roles';
import { classifyDirection } from '@/lib/services/direction-filter';

const CUSTOM_ROLE = '__CUSTOM__';

/* ─── Types ─────────────────────────────────────────────────────────── */

interface EntityCandidate {
  id: string;
  canonicalName: string;
  occurrences: number;
  directionProfile: { creditPct: number; debitPct: number };
  sampleDescriptions: string[];
  totalAmount?: number;
}

type EntityState = 'pending' | 'ai-loading' | 'suggestion' | 'manual' | 'saving' | 'saved' | 'error';

interface SuggestionData {
  suggestedRole: string;
  confidence: number;
  explanation: string;
  isNewRole?: boolean;
  roleSource?: 'BASE_ROLE' | 'COMPANY_ROLE' | 'NEW_ROLE_CANDIDATE';
}

interface EntityOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  companyId: string;
  onComplete?: () => void;
}

/* ─── Helpers ───────────────────────────────────────────────────────── */

function getDirectionHint(role: string): string | null {
  const expectedDir = EXPECTED_DIRECTION[role as EntityRole];
  if (expectedDir === null || expectedDir === 'mixed' || expectedDir === undefined) return null;
  return expectedDir === 'credit' ? 'Expected: Income' : 'Expected: Expense';
}

function isMixedDirection(profile: { creditPct: number; debitPct: number }): boolean {
  return profile.creditPct >= 0.15 && profile.debitPct >= 0.15;
}

/* ─── Component ─────────────────────────────────────────────────────── */

export function EntityOnboardingModal({
  isOpen,
  onClose,
  companyId,
  onComplete,
}: EntityOnboardingModalProps) {
  const t = useLanguageStore((s) => s.t);

  const [candidates, setCandidates] = useState<EntityCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-entity state: canonicalName → state machine
  const [entityStates, setEntityStates] = useState<Record<string, EntityState>>({});
  // Per-entity suggestion data
  const [suggestions, setSuggestions] = useState<Record<string, SuggestionData>>({});
  // Per-entity manual role selection
  const [manualRoles, setManualRoles] = useState<Record<string, string>>({});
  // Per-entity OTRO description
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  // Per-entity custom role name (for CUSTOM_ROLE selection)
  const [customRoleNames, setCustomRoleNames] = useState<Record<string, string>>({});
  // Per-entity error message
  const [entityErrors, setEntityErrors] = useState<Record<string, string>>({});

  const abortControllers = useRef<Record<string, AbortController>>({});
  const savedRef = useRef<Set<string>>(new Set());

  /* ── Fetch candidates ──────────────────────────────────────────────── */
  useEffect(() => {
    if (!companyId || !isOpen) return;

    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/learning/smart-classify?companyId=${companyId}`);
        if (res.ok) {
          const data = await res.json();
          setCandidates(data.data ?? []);
        } else {
          setError(t('learning.fetchError'));
        }
      } catch (err) {
        logger.error('Error loading entity onboarding data', { error: String(err) });
        setError(t('learning.loadError'));
      } finally {
        setLoading(false);
      }
    }

    fetchData();

    return () => {
      for (const controller of Object.values(abortControllers.current)) {
        controller.abort();
      }
      abortControllers.current = {};
      setEntityStates({});
      setSuggestions({});
      setManualRoles({});
      setCustomRoleNames({});
      setDescriptions({});
      setEntityErrors({});
      savedRef.current = new Set();
    };
  }, [companyId, isOpen, t]);

  const remainingCandidates = candidates.filter(
    (c) => !savedRef.current.has(c.canonicalName),
  );

  /* ── State helpers ─────────────────────────────────────────────────── */
  function setState(name: string, state: EntityState) {
    setEntityStates((prev) => ({ ...prev, [name]: state }));
  }

  function getState(name: string): EntityState {
    return entityStates[name] ?? 'pending';
  }

  /* ── AI suggest (State 1 → State 2 → State 3) ─────────────────────── */
  const handleAskAI = useCallback(async (candidate: EntityCandidate) => {
    const name = candidate.canonicalName;
    if (entityStates[name] === 'ai-loading') return;

    setState(name, 'ai-loading');
    setEntityErrors((prev) => ({ ...prev, [name]: '' }));

    const controller = new AbortController();
    abortControllers.current[name] = controller;

    const body: Record<string, unknown> = {
      description: descriptions[name] || name,
      companyId,
      directionProfile: candidate.directionProfile,
      sampleDescriptions: candidate.sampleDescriptions,
      occurrences: candidate.occurrences,
      manualRequest: true,
    };
    if (candidate.totalAmount) {
      body.totalAmount = { min: candidate.totalAmount, max: candidate.totalAmount };
    }

    try {
      const resp = await fetch('/api/learning/suggest-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        const code = errBody.code as string | undefined;
        let errorMsg = t('learning.suggestionBanner.error');
        if (code === 'AI_NOT_CONFIGURED') {
          errorMsg = t('learning.suggestionBanner.errorNotConfigured');
        } else if (code === 'AI_REQUEST_FAILED') {
          errorMsg = t('learning.suggestionBanner.errorRequestFailed');
        }
        setEntityErrors((prev) => ({ ...prev, [name]: errorMsg }));
        setState(name, 'error');
        return;
      }

      const data = await resp.json();
      setSuggestions((prev) => ({
        ...prev,
        [name]: {
          suggestedRole: data.suggestedRole,
          confidence: data.confidence,
          explanation: data.explanation,
          isNewRole: data.isNewRole ?? false,
          roleSource: data.roleSource ?? 'BASE_ROLE',
        },
      }));
      setState(name, 'suggestion');
    } catch (err) {
      if (controller.signal.aborted) return;
      logger.error('AI suggest error', { name, error: String(err) });
      setEntityErrors((prev) => ({ ...prev, [name]: t('learning.suggestionBanner.error') }));
      setState(name, 'error');
    } finally {
      delete abortControllers.current[name];
    }
  }, [companyId, descriptions, entityStates, t]);

  /* ── Assign immediately (State 3 → saved) ──────────────────────────── */
  async function handleAssign(name: string, role: string, userDescription?: string) {
    setState(name, 'saving');
    setEntityErrors((prev) => ({ ...prev, [name]: '' }));

    try {
      const res = await fetch('/api/learning/classify-entity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          pattern: name,
          userInput: name,
          role,
          ...(userDescription ? { userDescription } : {}),
        }),
      });

      if (res.ok) {
        savedRef.current.add(name);
        setState(name, 'saved');
        toast.success(`${name} → ${ROLE_LABELS[role as EntityRole] || role}`);
        if (onComplete) onComplete();
      } else {
        const errBody = await res.json().catch(() => ({}));
        setEntityErrors((prev) => ({ ...prev, [name]: errBody.error || 'Error' }));
        setState(name, 'suggestion');
      }
    } catch (err) {
      logger.error('Assign error', { name, error: String(err) });
      setEntityErrors((prev) => ({ ...prev, [name]: 'Error de red' }));
      setState(name, 'suggestion');
    }
  }

  /* ── Discard suggestion (State 3 → State 1) ────────────────────────── */
  function handleDiscard(name: string) {
    setSuggestions((prev) => ({ ...prev, [name]: undefined as unknown as SuggestionData }));
    setState(name, 'pending');
  }

  /* ── Enter manual mode (State 1 or 3 → State 6) ───────────────────── */
  function handleEnterManual(name: string, prefillRole?: string) {
    if (prefillRole) {
      setManualRoles((prev) => ({ ...prev, [name]: prefillRole }));
    }
    setState(name, 'manual');
  }

  /* ── Manual assign: AI re-suggestion (State 6 → State 2 → State 3) ── */
  async function handleManualAssign(name: string) {
    const role = manualRoles[name];
    if (!role) return;
    if (role === 'OTRO') {
      const desc = descriptions[name]?.trim();
      if (!desc || desc.length < 5) return;
      const candidate = candidates.find((c) => c.canonicalName === name);
      if (candidate) {
        await handleAskAI(candidate);
      }
      return;
    }
    if (role === CUSTOM_ROLE) {
      const customName = customRoleNames[name]?.trim().toUpperCase();
      if (!customName || customName.length < 2) return;
      await handleAssign(name, customName);
      return;
    }
    await handleAssign(name, role);
  }

  /* ── Assign OTRO directly without AI (State 6 → saved) ────────────── */
  function handleAssignOtro(name: string) {
    const desc = descriptions[name]?.trim();
    if (!desc || desc.length < 5) return;
    handleAssign(name, 'OTRO', desc);
  }

  /* ── Loading spinner state ─────────────────────────────────────────── */
  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
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
            <p className="text-xs mt-1">{t('learning.noPendingEntities')}</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {remainingCandidates.map((candidate) => {
              const name = candidate.canonicalName;
              const state = getState(name);
              const suggestion = suggestions[name];
              const manualRole = manualRoles[name] ?? '';
              const desc = descriptions[name] ?? '';
              const customName = customRoleNames[name] ?? '';
              const entityError = entityErrors[name];
              const isOtro = manualRole === 'OTRO';
              const isCustom = manualRole === CUSTOM_ROLE;

              const directionLabel = (() => {
                const profile = classifyDirection(candidate.directionProfile);
                if (profile === 'credit') return t('learning.directionCredit');
                if (profile === 'debit') return t('learning.directionDebit');
                return t('learning.directionMixed');
              })();

              return (
                <div
                  key={candidate.id}
                  className="border rounded-lg p-4 space-y-3 bg-card shadow-sm"
                >
                  {/* ── Header: always visible ──────────────────────────── */}
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-base truncate text-primary">
                      {name}
                      <span className="text-muted-foreground font-normal text-xs ml-1.5">
                        {t('learning.transactions').replace('{count}', String(candidate.occurrences))}
                        {' · '}
                        {directionLabel}
                      </span>
                    </h4>
                  </div>

                  {/* ── Entity error ────────────────────────────────────── */}
                  {entityError && (
                    <div className="flex items-start gap-2 p-2.5 text-sm text-amber-700 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md">
                      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span className="flex-1 text-xs">{entityError}</span>
                      {(entityError.includes('no configurada') || entityError.includes('not configured')) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs shrink-0"
                          onClick={() => {
                            onClose();
                            useAuthStore.getState().setSettingsActiveTab('ai-config');
                            useAuthStore.getState().setCurrentView('settings');
                          }}
                        >
                          <Settings className="h-3 w-3 mr-1" />
                          {t('settings.aiConfigTab')}
                        </Button>
                      )}
                    </div>
                  )}

                  {/* ════════════════════════════════════════════════════════
                      STATE 1: PENDING — Two buttons, nothing else
                     ════════════════════════════════════════════════════════ */}
                  {state === 'pending' && (
                    <div className="flex items-center justify-center gap-2 pt-1">
                      <Button
                        size="sm"
                        className="h-8 text-xs"
                        data-testid="pre-classify-btn"
                        onClick={() => handleAskAI(candidate)}
                      >
                        🤖 {t('learning.preClassify')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        data-testid="manual-select-btn"
                        onClick={() => handleEnterManual(name)}
                      >
                        {t('learning.manualSelection')}
                      </Button>
                    </div>
                  )}

                  {/* ════════════════════════════════════════════════════════
                      STATE 2: AI LOADING
                     ════════════════════════════════════════════════════════ */}
                  {state === 'ai-loading' && (
                    <div className="flex items-center gap-2 p-3 text-sm border rounded-md bg-muted/30">
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                      <span className="text-muted-foreground">
                        {t('learning.suggestionBanner.pending')}
                      </span>
                    </div>
                  )}

                  {/* ════════════════════════════════════════════════════════
                      STATE 3: SUGGESTION READY
                     ════════════════════════════════════════════════════════ */}
                  {state === 'suggestion' && suggestion && (
                    <div className="space-y-2">
                      {suggestion.isNewRole ? (
                        /* ── NEW ROLE SUGGESTION ── */
                        <div className="p-3 border border-blue-200 dark:border-blue-800 rounded-md bg-blue-50 dark:bg-blue-950">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                              {t('learning.suggestionBanner.newRoleTitle')}
                            </span>
                          </div>
                          <p className="text-sm text-muted-foreground mb-1">
                            {t('learning.suggestionBanner.newRoleDesc', {
                              role: suggestion.suggestedRole,
                            })}
                          </p>
                          <span className="text-lg font-semibold text-foreground">
                            {suggestion.suggestedRole}
                          </span>
                          <span className={suggestion.confidence >= 0.7 ? 'text-green-600 text-xs ml-2' : 'text-yellow-600 text-xs ml-2'}>
                            {suggestion.confidence >= 0.7
                              ? t('learning.suggestionBanner.confidence', { percent: Math.round(suggestion.confidence * 100) })
                              : t('learning.suggestionBanner.lowConfidence', { percent: Math.round(suggestion.confidence * 100) })}
                          </span>
                          <div className="flex flex-wrap gap-2 mt-3">
                            <Button
                              size="sm"
                              className="h-8 text-sm"
                              onClick={() => handleAssign(name, suggestion.suggestedRole)}
                            >
                              ✅ {t('learning.suggestionBanner.newRoleUse')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-sm"
                              onClick={() => handleEnterManual(name, suggestion.suggestedRole)}
                            >
                              ✏️ {t('learning.suggestionBanner.edit')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-xs text-muted-foreground"
                              onClick={() => handleDiscard(name)}
                            >
                              ❌ {t('learning.suggestionBanner.newRoleCancel')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        /* ── EXISTING ROLE SUGGESTION ── */
                        <div className="p-3 border rounded-md bg-muted/30">
                          <div className="flex flex-col gap-1 mb-3">
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('learning.suggestionBanner.title', {
                                role: ROLE_LABELS[suggestion.suggestedRole as EntityRole] || suggestion.suggestedRole,
                              })}
                            </span>
                            <span className="text-lg font-semibold text-foreground">
                              {ROLE_LABELS[suggestion.suggestedRole as EntityRole] || suggestion.suggestedRole}
                            </span>
                            <span className={suggestion.confidence >= 0.7 ? 'text-green-600 text-xs' : 'text-yellow-600 text-xs'}>
                              {suggestion.confidence >= 0.7
                                ? t('learning.suggestionBanner.confidence', { percent: Math.round(suggestion.confidence * 100) })
                                : t('learning.suggestionBanner.lowConfidence', { percent: Math.round(suggestion.confidence * 100) })}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              className="h-8 text-sm"
                              data-testid="accept-suggestion-btn"
                              onClick={() => handleAssign(name, suggestion.suggestedRole)}
                            >
                              ✅ {t('learning.suggestionBanner.accept')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-sm"
                              data-testid="discard-suggestion-btn"
                              onClick={() => handleDiscard(name)}
                            >
                              ❌ {t('learning.suggestionBanner.discard')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-xs text-muted-foreground"
                              data-testid="edit-role-btn"
                              onClick={() => handleEnterManual(name, suggestion.suggestedRole)}
                            >
                              ✏️ {t('learning.suggestionBanner.edit')}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ════════════════════════════════════════════════════════
                      STATE 5: ERROR — retry
                     ════════════════════════════════════════════════════════ */}
                  {state === 'error' && (
                    <div className="flex items-center gap-2 p-3 text-sm border rounded-md bg-muted/30">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-muted-foreground text-xs">
                        {t('learning.suggestionBanner.error')}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => handleAskAI(candidate)}
                      >
                        <RefreshCw className="h-3 w-3 mr-1" />
                        {t('learning.suggestionBanner.retry')}
                      </Button>
                    </div>
                  )}

                  {/* ════════════════════════════════════════════════════════
                      STATE 6: MANUAL FORM — dropdown + conditional inputs
                     ════════════════════════════════════════════════════════ */}
                  {state === 'manual' && (
                    <div className="space-y-3 border-t pt-3">
                      <div className="w-full">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {isOtro ? t('learning.describeRelationship') : isCustom ? 'Nombre del rol personalizado' : t('learning.selectRole')}
                        </label>
                        <Select
                          value={manualRole}
                          onValueChange={(v) => {
                            setManualRoles((prev) => ({ ...prev, [name]: v }));
                            if (v !== 'OTRO') {
                              setDescriptions((prev) => ({ ...prev, [name]: '' }));
                            }
                            if (v !== CUSTOM_ROLE) {
                              setCustomRoleNames((prev) => ({ ...prev, [name]: '' }));
                            }
                          }}
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
                            <SelectItem value={CUSTOM_ROLE}>
                              Personalizado...
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {/* OTRO textarea — only when "Otro" selected */}
                      {isOtro && (
                        <div className="w-full space-y-2">
                          <Textarea
                            placeholder={t('learning.otroDescription')}
                            value={desc}
                            onChange={(e) => setDescriptions((prev) => ({ ...prev, [name]: e.target.value }))}
                            className="min-h-[60px] text-sm"
                          />
                          <div className="flex items-center justify-center gap-2 pt-1">
                            <Button
                              size="sm"
                              className="h-8 text-xs"
                              disabled={!desc.trim() || desc.trim().length < 5}
                              onClick={() => handleManualAssign(name)}
                            >
                              ✅ {t('learning.accept')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs"
                              onClick={() => handleAskAI(candidate)}
                            >
                              🤖 {t('learning.preClassify')}
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Custom role name input — only when "Personalizado" selected */}
                      {isCustom && (
                        <div className="w-full space-y-2">
                          <Input
                            placeholder="Ej: FIDEICOMISO, PLATAFORMA, INVERSOR..."
                            value={customName}
                            onChange={(e) => setCustomRoleNames((prev) => ({ ...prev, [name]: e.target.value }))}
                            className="h-8 text-sm"
                          />
                          <div className="flex items-center justify-center gap-2 pt-1">
                            <Button
                              size="sm"
                              className="h-8 text-xs"
                              disabled={!customName.trim() || customName.trim().length < 2}
                              onClick={() => handleManualAssign(name)}
                            >
                              ✅ {t('learning.suggestionBanner.accept')}
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Assign button for base roles (excludes OTRO and Custom) */}
                      {manualRole && !isOtro && !isCustom && (
                        <Button
                          size="sm"
                          className="h-8 text-sm"
                          onClick={() => handleManualAssign(name)}
                        >
                          ✅ {t('learning.suggestionBanner.accept')}
                        </Button>
                      )}

                      {/* Back to pending */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-muted-foreground"
                        onClick={() => setState(name, 'pending')}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  )}

                  {/* ════════════════════════════════════════════════════════
                      STATE: SAVING
                     ════════════════════════════════════════════════════════ */}
                  {state === 'saving' && (
                    <div className="flex items-center gap-2 p-3 text-sm border rounded-md bg-muted/30">
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                      <span className="text-muted-foreground">{t('learning.saving')}</span>
                    </div>
                  )}

                  {/* ════════════════════════════════════════════════════════
                      STATE: SAVED
                     ════════════════════════════════════════════════════════ */}
                  {state === 'saved' && (
                    <div className="flex items-center gap-2 p-2 text-sm text-green-600 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      {t('learning.suggestionBanner.assigned', {
                        role: ROLE_LABELS[manualRoles[name] as EntityRole] || manualRoles[name] || suggestions[name]?.suggestedRole || '',
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="pt-4 border-t">
          <Button variant="outline" onClick={onClose}>
            {t('learning.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
