'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguageStore } from '@/store/language-store';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Loader2,
  Send,
  CheckCircle2,
  ArrowRight,
  AlertCircle,
  Plus,
  Trash2,
  Eye,
  ChevronRight,
} from 'lucide-react';
import { type EntityCandidate } from '@/lib/services/entity-detector';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';
import { ROLE_ACCOUNT_MAP } from '@/lib/constants/role-account-map';
import type { EntityRole } from '@/lib/constants/entity-roles';
import { logger } from '@/lib/logger';

interface ValidationErrorResponse {
  details?: { fieldErrors?: Record<string, string[]> };
  error?: string;
}

function formatValidationError(
  errData: ValidationErrorResponse,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  if (errData.details) {
    const fieldErrors = errData.details.fieldErrors || {};
    const fields = Object.keys(fieldErrors);
    if (fields.length > 0) {
      const msgs = fields.map((f) => `${f}: ${fieldErrors[f].join(', ')}`);
      return t('ruleBuilder.validationErrorDetail', { details: msgs.join('; ') });
    }
  }
  // Traduce el error base si es el mensaje hardcodeado en inglés
  const msg = errData.error || '';
  if (msg === 'Validation failed') return t('ruleBuilder.validationFailed');
  if (msg === 'pattern or conditions are required')
    return t('ruleBuilder.patternOrConditionRequired');
  return msg || t('ruleBuilder.createError');
}

function getNextCode(baseCode: string, existingAccounts: GlAccountOption[]): string {
  const existing = new Set(existingAccounts.filter(Boolean).map((a) => a.code));
  let code = baseCode;
  for (let i = 0; i < 100; i++) {
    if (!existing.has(code)) return code;
    const num = parseInt(code, 10);
    if (isNaN(num)) break;
    code = String(num + 1);
  }
  return baseCode;
}

function getNextSubAccountCode(parentCode: string, allAccounts: GlAccountOption[]): string {
  const parent = allAccounts.find((a) => a.code === parentCode);
  if (!parent?.id) return `${parentCode}-01`;
  const children = allAccounts.filter((a) => a.parentId === parent.id);
  if (children.length === 0) return `${parentCode}-01`;
  let maxSuffix = 0;
  for (const child of children) {
    const parts = child.code.split('-');
    const suffix = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(suffix) && suffix > maxSuffix) maxSuffix = suffix;
  }
  return `${parentCode}-${(maxSuffix + 1).toString().padStart(2, '0')}`;
}

function resolveSuggestionAccount(
  sug: { role?: string; account: { code: string; name: string; accountType?: string } },
  allGlAccounts: GlAccountOption[],
  direction: 'debit' | 'credit',
): { code: string; name: string; exists: boolean } {
  let account = allGlAccounts.find((a) => a.code === sug.account.code);
  if (account) return { code: sug.account.code, name: account.name, exists: true };
  const mapping = sug.role ? ROLE_ACCOUNT_MAP[sug.role as EntityRole] : undefined;
  if (mapping) {
    const heuristicCode = direction === 'debit' ? mapping.debit : mapping.credit;
    account = allGlAccounts.find((a) => a.code === heuristicCode);
    if (account) return { code: heuristicCode, name: account.name, exists: true };
  }
  if (sug.account.accountType) {
    account = allGlAccounts.find((a) => a.accountType === sug.account.accountType && !a.parentId);
    if (account) return { code: account.code, name: account.name, exists: true };
  }
  return { code: sug.account.code, name: sug.account.name, exists: false };
}

function accountTypeLabel(
  type?: string,
  t?: (key: string, params?: Record<string, string>) => string,
): string {
  const labels: Record<string, string> = {
    equity: t ? t('ruleBuilder.accountTypeEquity') : 'Capital (Equity)',
    revenue: t ? t('ruleBuilder.accountTypeRevenue') : 'Ingresos (Revenue)',
    asset: t ? t('ruleBuilder.accountTypeAsset') : 'Activo (Asset)',
    liability: t ? t('ruleBuilder.accountTypeLiability') : 'Pasivo (Liability)',
    expense: t ? t('ruleBuilder.accountTypeExpense') : 'Gasto (Expense)',
  };
  return type
    ? labels[type] || (t ? t('ruleBuilder.accountTypeExpense') : 'Gasto (Expense)')
    : t
      ? t('ruleBuilder.accountTypeExpense')
      : 'Gasto (Expense)';
}

function getIndividualCode(parentCode: string, accounts: GlAccountOption[]): string {
  const num = parseInt(parentCode, 10);
  if (isNaN(num)) return parentCode;
  return getNextCode(String(num + 1), accounts);
}

function buildAccountChain(
  accounts: GlAccountOption[],
  code: string,
): { id: string; code: string; name: string }[] {
  const byCode = new Map(accounts.filter(Boolean).map((a) => [a.code, a]));
  const byId = new Map(accounts.filter(Boolean).map((a) => [a.id, a]));
  const chain: { id: string; code: string; name: string }[] = [];
  let current = byCode.get(code) ?? null;
  while (current) {
    chain.unshift({ id: current.id, code: current.code, name: current.name });
    if (!current.parentId) break;
    current = byId.get(current.parentId) ?? null;
  }
  return chain;
}

interface RuleCondition {
  field: 'description' | 'amount' | 'reference';
  operator:
    | 'contains'
    | 'starts_with'
    | 'ends_with'
    | 'equals'
    | 'greater_than'
    | 'less_than'
    | 'amount_greater'
    | 'amount_less';
  value: string;
}

interface AISuggestion {
  role: string;
  account: { code: string; name: string; accountType?: string; normalBalance?: string };
  suggestSubAccount: boolean;
  subAccountName?: string;
  conditions?: RuleCondition[];
  confidence?: number;
  confidenceLabel?: 'high' | 'medium' | 'low';
  explanation?: string;
  uncertaintyReasons?: string[];
}

interface ConversationalRuleBuilderProps {
  companyId: string;
  onComplete?: (ruleData: Record<string, unknown>) => void;
}

export function ConversationalRuleBuilder({
  companyId,
  onComplete,
}: ConversationalRuleBuilderProps) {
  const { t } = useLanguageStore();
  const [candidates, setCandidates] = useState<EntityCandidate[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Estados del flujo conversacional
  const [answer, setAnswer] = useState('');
  const [processingAnswer, setProcessingAnswer] = useState(false);
  const [suggestion, setSuggestion] = useState<AISuggestion | null>(null);
  const [creatingRule, setCreatingRule] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const creatingRuleRef = useRef(false);
  const suggestionCache = useRef<Record<string, AISuggestion>>({});
  const autoLoadedRef = useRef<string | null>(null);

  // GL account creation/link modal (like bank import flow)
  const [glAccountModalOpen, setGlAccountModalOpen] = useState(false);
  const [glAccountMode, setGlAccountMode] = useState<'create' | 'link'>('create');
  const [glAccountCodeInput, setGlAccountCodeInput] = useState('');
  const [glAccountNameInput, setGlAccountNameInput] = useState('');
  const [glAccountId, setGlAccountId] = useState<string | null>(null);
  const [savingGlAccount, setSavingGlAccount] = useState(false);
  const [allGlAccounts, setAllGlAccounts] = useState<GlAccountOption[]>([]);

  // Live simulation & condition editor states
  const [editableConditions, setEditableConditions] = useState<RuleCondition[]>([]);
  const [localSuggestSubAccount, setLocalSuggestSubAccount] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationResult, setSimulationResult] = useState<{
    matchCount: number;
    samples: { description: string; date: string; reference?: string; amount: number }[];
  } | null>(null);
  const [showSamplesModal, setShowSamplesModal] = useState(false);

  // Dynamic smart chips — top GL accounts used across rules for this company
  const [topAccounts, setTopAccounts] = useState<
    { code: string; name: string; accountType: string }[]
  >([]);

  const entityCardRef = useRef<HTMLDivElement>(null);
  const questionInputRef = useRef<HTMLInputElement>(null);
  const hasAutoScrolled = useRef(false);

  useEffect(() => {
    if (!loading && !hasAutoScrolled.current) {
      hasAutoScrolled.current = true;
      const timer = setTimeout(() => {
        entityCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        questionInputRef.current?.focus();
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  // Sync suggestion conditions + sub-account flag when suggestion changes
  useEffect(() => {
    if (suggestion) {
      setEditableConditions(suggestion.conditions || []);
      setLocalSuggestSubAccount(suggestion.suggestSubAccount);
    } else {
      setEditableConditions([]);
      setLocalSuggestSubAccount(false);
    }
  }, [suggestion]);

  // Fetch top GL accounts for dynamic smart chips + all accounts for linking
  const fetchAccounts = useCallback(async () => {
    try {
      const [topRes, allRes] = await Promise.all([
        fetch(`/api/bank-rules/top-accounts?companyId=${companyId}`),
        fetch(`/api/accounts?companyId=${companyId}`),
      ]);
      if (topRes.ok) {
        const topData = await topRes.json();
        if (Array.isArray(topData.data)) {
          setTopAccounts(topData.data);
        }
      }
      if (allRes.ok) {
        const allData = await allRes.json();
        const accounts = (allData.accounts ?? allData.data ?? []).filter(Boolean);
        setAllGlAccounts(
          accounts.map(
            (a: {
              id: string;
              code: string;
              name: string;
              accountType: string;
              normalBalance: string;
              parentId: string | null;
            }) => ({
              id: a.id,
              code: a.code,
              name: a.name,
              accountType: a.accountType,
              normalBalance: a.normalBalance,
              parentId: a.parentId ?? null,
            }),
          ),
        );
      }
    } catch (err) {
      logger.warn('[FAILED TO FETCH ACCOUNTS]', { error: String(err) });
    }
  }, [companyId]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Debounced Simulation Effect
  useEffect(() => {
    if (editableConditions.length === 0) {
      setSimulationResult(null);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSimulating(true);
      try {
        const res = await fetch('/api/learning/rules/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId,
            conditions: editableConditions.filter((c) => c.value.trim().length > 0),
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            setSimulationResult({
              matchCount: data.matchCount,
              samples: data.samples,
            });
          }
        }
      } catch (err) {
        logger.error('[SIMULATION ERROR]', { error: String(err) });
      } finally {
        setIsSimulating(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [editableConditions, companyId]);

  useEffect(() => {
    if (clickCount > 0) {
      const timer = setTimeout(() => setClickCount(0), 1200);
      return () => clearTimeout(timer);
    }
  }, [clickCount]);

  // Perfiles de dirección cargados dinámicamente
  const [directionProfiles, setDirectionProfiles] = useState<
    Record<string, { normalBalance: 'credit' | 'debit'; deviationThreshold: number }>
  >({});

  useEffect(() => {
    async function fetchProfiles() {
      try {
        const res = await fetch('/api/config/direction-profiles');
        if (res.ok) {
          const resData = await res.json();
          if (resData.success && resData.data) {
            setDirectionProfiles(resData.data);
          }
        }
      } catch (err) {
        logger.warn('[FAILED TO FETCH DIRECTION PROFILES]', { error: String(err) });
      }
    }
    fetchProfiles();
  }, []);

  const current = candidates[currentIndex];

  // ─── Resolución de cuenta por rol (refleja ROLE_ACCOUNT_MAP del backend) ───
  // Usado cuando el scan no pudo sugerir cuenta pero conocemos el rol por contexto.
  const ROLE_ACCOUNT_SUGGESTIONS: Record<string, { fallback: string; isMultiEntity: boolean }> = {
    SOCIO: { fallback: '3010', isMultiEntity: true },
    EMPLEADO: { fallback: '6030', isMultiEntity: false },
    INQUILINO: { fallback: '4020', isMultiEntity: false },
    CLIENTE: { fallback: '4010', isMultiEntity: false },
    TARJETA_CREDITO: { fallback: '2020', isMultiEntity: false },
    PRESTAMO: { fallback: '2040', isMultiEntity: false },
    PROVEEDOR: { fallback: '6070', isMultiEntity: false },
    GASTO_OPERATIVO: { fallback: '5000', isMultiEntity: false },
    INGRESO: { fallback: '4010', isMultiEntity: false },
  };

  function resolveAccountFromRole(
    role: string,
  ): { code: string; isMultiEntity: boolean } | null {
    const upper = role.toUpperCase();
    // Exact match
    const exact = ROLE_ACCOUNT_SUGGESTIONS[upper];
    if (exact) return { code: exact.fallback, isMultiEntity: exact.isMultiEntity };
    // Partial match (compound names como "EMPRESA DE LOS SOCIOS")
    for (const [canonical, mapping] of Object.entries(ROLE_ACCOUNT_SUGGESTIONS)) {
      if (upper.includes(canonical)) return { code: mapping.fallback, isMultiEntity: mapping.isMultiEntity };
    }
    return null;
  }

  // Auto-carga: skip chat when entity has existing context
  useEffect(() => {
    if (!current || !current.hasContext) return;
    if (autoLoadedRef.current === current.id) return;

    let account: GlAccountOption | undefined;
    if (current.suggestedAccountId) {
      account = allGlAccounts.find((a) => a.id === current.suggestedAccountId);
    }
    if (!account && current.suggestedAccountCode) {
      account = allGlAccounts.find((a) => a.code === current.suggestedAccountCode);
    }
    if (!account) return;

    autoLoadedRef.current = current.id;
    const roleUpper = current.contextRole?.toUpperCase() || '';
    const isMultiEntity = roleUpper === 'SOCIO' || roleUpper.includes('SOCIO');
    const subName = current.canonicalName
      .trim()
      .split(/\s+/)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');

    setSuggestion({
      role: current.contextRole || '',
      account: { code: account.code, name: account.name, accountType: account.accountType },
      suggestSubAccount: isMultiEntity,
      subAccountName: subName,
      conditions: [{ field: 'description', operator: 'contains', value: current.canonicalName }],
    });

    if (isMultiEntity) {
      setGlAccountMode('create');
      setGlAccountId(null);
      setGlAccountCodeInput(account.code);
      setGlAccountNameInput(subName);
      setLocalSuggestSubAccount(true);
    } else {
      setGlAccountMode('link');
      setGlAccountId(account.id);
      setGlAccountCodeInput(account.code);
      setGlAccountNameInput(account.name);
      setLocalSuggestSubAccount(false);
    }
  }, [current, allGlAccounts]);

  // Segundo intento: si auto-load no encontró cuenta sugerida pero tenemos rol,
  // resolver desde ROLE_ACCOUNT_SUGGESTIONS y pre-seleccionar.
  useEffect(() => {
    if (!current || !current.hasContext) return;
    if (suggestion) return; // ya hay sugerencia
    if (!current.contextRole) return;

    const resolved = resolveAccountFromRole(current.contextRole);
    if (!resolved) return;

    const account = allGlAccounts.find((a) => a.code === resolved.code);
    if (!account) return;

    // Pre-seleccionar cuenta y modo
    setGlAccountId(account.id);
    setGlAccountCodeInput(account.code);
    setGlAccountNameInput(account.name);
    setGlAccountMode(resolved.isMultiEntity ? 'create' : 'link');
    setLocalSuggestSubAccount(resolved.isMultiEntity);
  }, [current, suggestion, allGlAccounts]);

  // Carga inicial de candidatos desde scan (sin clustering)
  const fetchCandidates = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/ai-rules/scan?companyId=${companyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(t('ruleBuilder.fetchError'));
      const data = await res.json();
      const raw = data.patterns || [];
      // Map scan patterns to EntityCandidate format
      const mapped: EntityCandidate[] = raw.map(
        (p: {
          id: string;
          description: string;
          occurrences: number;
          direction: string;
          rawDescription: string;
          hasContext?: boolean;
          contextRole?: string;
          suggestedAccountCode?: string;
          suggestedAccountId?: string;
          confidence?: number;
          confidenceLabel?: string;
          explanation?: string;
        }) => ({
          id: p.id,
          canonicalName: p.description,
          occurrences: p.occurrences,
          directionProfile: {
            creditPct: p.direction === 'credit' ? 1 : 0,
            debitPct: p.direction === 'debit' ? 1 : 0,
          },
          sampleDescriptions: [p.rawDescription],
          hasContext: p.hasContext ?? false,
          contextRole: p.contextRole ?? undefined,
          suggestedAccountCode: p.suggestedAccountCode ?? undefined,
          suggestedAccountId: p.suggestedAccountId ?? undefined,
          confidence: p.confidence ?? undefined,
          confidenceLabel: (p.confidenceLabel as 'high' | 'medium' | 'low') ?? undefined,
          explanation: p.explanation ?? undefined,
        }),
      );
      setCandidates(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ruleBuilder.unknownError'));
    } finally {
      setLoading(false);
    }
  }, [companyId, t]);

  const handleRefresh = useCallback(() => {
    setCurrentIndex(0);
    setSuggestion(null);
    setAnswer('');
    setEditableConditions([]);
    setSimulationResult(null);
    suggestionCache.current = {};
    fetchCandidates();
  }, [fetchCandidates]);

  useEffect(() => {
    fetchCandidates();
  }, [fetchCandidates]);

  // Helper para procesar respuesta libre o Smart Chips
  const submitWithAnswer = useCallback(
    async (value: string) => {
      if (!value.trim() || !current) return;

      // Check session cache first
      const cacheKey = `${current.canonicalName}::${value.trim()}`;
      const cached = suggestionCache.current[cacheKey];
      if (cached) {
        setAnswer(value);
        setSuggestion(cached);
        return;
      }

      setAnswer(value);
      setProcessingAnswer(true);
      setError(null);
      try {
        const res = await fetch('/api/learning/conversational-parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId,
            pattern: current.canonicalName,
            userInput: value.trim(),
            userAnswer: value.trim(),
            directionProfile: current.directionProfile,
          }),
        });
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || t('ruleBuilder.interpretError'));
        }
        const resData = await res.json();
        if (resData.success && resData.data) {
          const sug = resData.data;
          setGlAccountMode('create');

          // Resolve AI-suggested account code against real DB accounts
          const typeKey = sug.account.accountType || '';
          const profile = typeKey ? directionProfiles[typeKey] : undefined;
          const th = profile?.deviationThreshold ?? 0.9;
          const direction = current.directionProfile.creditPct >= th ? 'credit' : 'debit';
          const resolved = resolveSuggestionAccount(sug, allGlAccounts, direction);
          sug.account.name = resolved.name;

          if (sug.suggestSubAccount) {
            // Preserve parent code — server will create sub-account under it
            setGlAccountCodeInput(resolved.code);
          } else {
            // Standalone account: find next available code
            const nextCode = getNextCode(resolved.code, allGlAccounts);
            setGlAccountCodeInput(nextCode);
          }
          setGlAccountNameInput(sug.account.name);
          setSuggestion(sug);
          // Cache suggestion per session for consistent re-edits
          suggestionCache.current[`${current.canonicalName}::${value.trim()}`] = sug;
        } else {
          throw new Error(t('ruleBuilder.interpretError'));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('ruleBuilder.unknownError'));
      } finally {
        setProcessingAnswer(false);
      }
    },
    [current, companyId, t, allGlAccounts, directionProfiles],
  );

  // Paso 1: Interpretar respuesta libre con IA
  const handleInterpret = useCallback(async () => {
    await submitWithAnswer(answer);
  }, [answer, submitWithAnswer]);

  // Paso 2: Confirmar y generar regla
  const handleConfirm = useCallback(async () => {
    if (!suggestion || !current || creatingRuleRef.current) return;
    creatingRuleRef.current = true;
    setCreatingRule(true);
    try {
      const typeKey = suggestion.account.accountType;
      const profile = typeKey ? directionProfiles[typeKey] : undefined;
      const threshold = profile?.deviationThreshold ?? 0.9;
      const code = glAccountCodeInput || suggestion.account.code;
      const name = glAccountNameInput || suggestion.account.name;

      const res = await fetch('/api/learning/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          pattern: current.canonicalName,
          lockedDirection: current.directionProfile.creditPct >= threshold ? 'credit' : 'debit',
          glAccountCode: code,
          role: suggestion.role,
          createSubAccount: localSuggestSubAccount,
          subAccountName: localSuggestSubAccount ? (suggestion.subAccountName || current.canonicalName) : undefined,
          conditions: editableConditions.filter((c) => c.value.trim().length > 0),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (errData.code === 'GL_ACCOUNT_NOT_FOUND') {
          setGlAccountCodeInput(code);
          setGlAccountNameInput(name);
          setGlAccountId(null);
          setGlAccountMode('create');
          setGlAccountModalOpen(true);
          creatingRuleRef.current = false;
          setCreatingRule(false);
          return;
        }
        throw new Error(formatValidationError(errData, t));
      }

      onComplete?.(await res.json());

      // Reset para siguiente entidad
      setAnswer('');
      setSuggestion(null);
      setEditableConditions([]);
      setSimulationResult(null);
      suggestionCache.current = {};
      setCurrentIndex((prev) => prev + 1);

      // Refresh accounts so next entity sees newly created sub-accounts or parent
      fetchAccounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ruleBuilder.unknownError'));
    } finally {
      setCreatingRule(false);
      creatingRuleRef.current = false;
    }
  }, [
    suggestion,
    current,
    companyId,
    onComplete,
    t,
    glAccountCodeInput,
    glAccountNameInput,
    editableConditions,
    fetchAccounts,
    localSuggestSubAccount,
    directionProfiles,
  ]);

  const handleToggleGrouping = useCallback(
    (isIndividual: boolean) => {
      if (!suggestion) return;
      setLocalSuggestSubAccount(isIndividual);
      if (isIndividual) {
        // Individual: create sub-account under parent
        setGlAccountCodeInput(suggestion.account.code);
        setGlAccountNameInput(suggestion.subAccountName || suggestion.account.name);
        setGlAccountMode('create');
        setGlAccountId(null);
      } else {
        // Agrupar: link directly to existing parent account
        const parent = allGlAccounts.find((a) => a.code === suggestion.account.code);
        if (parent) {
          setGlAccountId(parent.id);
          setGlAccountMode('link');
          setGlAccountCodeInput(parent.code);
          setGlAccountNameInput(parent.name);
        } else {
          setGlAccountMode('create');
          setGlAccountCodeInput(suggestion.account.code);
          setGlAccountNameInput(suggestion.account.name);
          setGlAccountId(null);
        }
      }
    },
    [suggestion, allGlAccounts],
  );

  const handleSkip = useCallback(() => {
    setAnswer('');
    setSuggestion(null);
    setEditableConditions([]);
    setSimulationResult(null);
    setCurrentIndex((prev) => prev + 1);
  }, []);

  const handleSaveGlAccount = useCallback(async () => {
    if (!suggestion || !current) return;
    setSavingGlAccount(true);
    try {
      let finalCode = glAccountCodeInput;
      let createdAccountType: string | undefined;

      if (glAccountMode === 'create' && !localSuggestSubAccount) {
        // Standalone account: create via POST /api/accounts
        createdAccountType = suggestion.account.accountType || 'equity';
        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId,
            code: glAccountCodeInput,
            name: glAccountNameInput,
            accountType: createdAccountType,
            normalBalance: suggestion.account.normalBalance || 'debit',
            isActive: true,
          }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(
            errData.error || t('ruleBuilder.accountCreationFailed', { code: glAccountCodeInput }),
          );
        }
      } else if (glAccountMode === 'create' && localSuggestSubAccount) {
        // Sub-account: skip POST /api/accounts, backend rules endpoint handles creation
        createdAccountType = suggestion.account.accountType || 'equity';
      } else {
        const selected = allGlAccounts.find((a) => a.id === glAccountId);
        if (!selected) throw new Error(t('ruleBuilder.selectExistingAccount'));
        finalCode = selected.code;
        createdAccountType = selected.accountType;
      }

      const typeKey = createdAccountType;
      const profile = typeKey ? directionProfiles[typeKey] : undefined;
      const th = profile?.deviationThreshold ?? 0.9;

      const retryRes = await fetch('/api/learning/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          pattern: current.canonicalName,
          lockedDirection: current.directionProfile.creditPct >= th ? 'credit' : 'debit',
          glAccountCode: finalCode,
          role: suggestion.role,
          createSubAccount: localSuggestSubAccount,
          subAccountName: localSuggestSubAccount ? glAccountNameInput : undefined,
          conditions: editableConditions.filter((c) => c.value.trim().length > 0),
        }),
      });
      if (!retryRes.ok) {
        const retryErrData = await retryRes.json().catch(() => ({}));
        throw new Error(formatValidationError(retryErrData, t));
      }

      setGlAccountModalOpen(false);
      onComplete?.(await retryRes.json());

      setAnswer('');
      setSuggestion(null);
      setEditableConditions([]);
      setSimulationResult(null);
      suggestionCache.current = {};
      setCurrentIndex((prev) => prev + 1);

      // Refresh accounts list so next entity sees newly created account
      if (glAccountMode === 'create') {
        fetchAccounts();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('ruleBuilder.accountCreationError'));
    } finally {
      setSavingGlAccount(false);
    }
  }, [
    suggestion,
    current,
    companyId,
    onComplete,
    t,
    glAccountCodeInput,
    glAccountNameInput,
    glAccountMode,
    glAccountId,
    allGlAccounts,
    editableConditions,
    fetchAccounts,
    localSuggestSubAccount,
    directionProfiles,
  ]);

  // Renderizado de estados
  if (loading)
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="animate-spin mr-2" /> {t('ruleBuilder.loadingCandidates')}
      </div>
    );
  if (error)
    return (
      <div className="p-4 text-red-500 flex items-center gap-2 bg-red-500/10 rounded-md">
        <AlertCircle /> {error}
      </div>
    );
  if (candidates.length === 0)
    return (
      <div className="p-8 text-center space-y-4">
        <div className="text-muted-foreground">
          <p>{t('ruleBuilder.noCandidates')}</p>
          <p className="text-sm mt-2">{t('ruleBuilder.noCandidatesHint')}</p>
        </div>
        <Button onClick={handleRefresh} variant="outline">
          {t('common.refresh')}
        </Button>
      </div>
    );
  if (currentIndex >= candidates.length)
    return (
      <div className="p-6 text-center text-green-600 flex items-center justify-center gap-2">
        <CheckCircle2 /> {t('ruleBuilder.allProcessed')}
      </div>
    );

  const suggestedAccountType = suggestion?.account.accountType || '';
  const profile = suggestedAccountType ? directionProfiles[suggestedAccountType] : undefined;
  const threshold = profile?.deviationThreshold ?? 0.9;

  const directionLabel =
    current.directionProfile.creditPct >= threshold
      ? t('ruleBuilder.directionCredit')
      : current.directionProfile.debitPct >= threshold
        ? t('ruleBuilder.directionDebit')
        : t('ruleBuilder.directionMixed');

  return (
    <div className="space-y-4 w-full max-w-2xl mx-auto">
      <Card className="w-full shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            {t('ruleBuilder.title')}
            <Badge variant="outline" className="font-normal">
              {currentIndex + 1} / {candidates.length}
            </Badge>
          </CardTitle>
          <CardDescription>{t('ruleBuilder.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Info de la Entidad */}
          <div
            ref={entityCardRef}
            className="rounded-lg bg-indigo-500/5 border-indigo-500/20 p-4 space-y-3 border"
          >
            <h3 className="font-semibold text-lg tracking-tight">
              {current.canonicalName}
              {current.confidence !== undefined && (
                <Badge
                  variant={
                    current.confidence >= 0.8 ? 'default' :
                    current.confidence >= 0.5 ? 'secondary' :
                    'destructive'
                  }
                  className="ml-2 text-xs"
                >
                  {current.confidence >= 0.8 ? t('ruleBuilder.highConfidence') :
                   current.confidence >= 0.5 ? t('ruleBuilder.mediumConfidence') :
                   t('ruleBuilder.lowConfidence')}
                </Badge>
              )}
              {(current.contextRole || suggestion?.role) && (
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  ({current.contextRole || suggestion?.role})
                </span>
              )}
            </h3>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {current.occurrences} {t('ruleBuilder.occurrences')}
              </Badge>
              <Badge
                variant={
                  directionLabel === t('ruleBuilder.directionCredit')
                    ? 'default'
                    : directionLabel === t('ruleBuilder.directionDebit')
                      ? 'destructive'
                      : 'outline'
                }
              >
                {directionLabel}
              </Badge>
            </div>
            {current.explanation && (
              <p className="text-xs text-muted-foreground mt-2">{current.explanation}</p>
            )}
          </div>

          {/* Flujo Conversacional */}
          {!suggestion && current.hasContext ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-green-500/5 border border-green-500/20 p-4 space-y-3">
                <p className="text-sm text-foreground">
                  {t('ruleBuilder.contextInfo')
                    .replace('{role}', current.contextRole || '')
                    .replace('{entity}', current.canonicalName)}
                </p>
                <div className="space-y-1">
                  <label className="text-xs font-medium">
                    {t('ruleBuilder.selectAccountPlaceholder')}
                  </label>
                  <AccountSelector
                    accounts={allGlAccounts}
                    value={glAccountId}
                    onChange={(id) => {
                      setGlAccountId(id);
                      const selected = allGlAccounts.find((a) => a.id === id);
                      if (selected) {
                        setGlAccountCodeInput(selected.code);
                        setGlAccountNameInput(selected.name);
                        // No resetear el modo si ya fue pre-seleccionado por rol
                        // (el segundo useEffect lo dejó en 'create' si es multi-entidad)
                      }
                    }}
                    placeholder={t('ruleBuilder.selectAccountPlaceholder')}
                  />
                </div>
              </div>

              {/* Account options toggles — visible once account is selected */}
              {glAccountId && (
                <>
                  {/* Agrupar / Individual toggle */}
                  <div className="space-y-1">
                    <label className="text-xs font-medium">{t('ruleBuilder.groupingLabel')}</label>
                    <div className="grid grid-cols-2 gap-2 bg-slate-900/50 dark:bg-slate-900/80 p-1 rounded-lg border">
                      <button
                        type="button"
                        onClick={() => {
                          setLocalSuggestSubAccount(false);
                          if (glAccountId) {
                            setGlAccountMode('link');
                          }
                        }}
                        className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                          !localSuggestSubAccount
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {t('ruleBuilder.groupUnder', { code: glAccountCodeInput || '' })}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setLocalSuggestSubAccount(true);
                          setGlAccountMode('create');
                        }}
                        className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                          localSuggestSubAccount
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {t('ruleBuilder.groupIndividual')}
                      </button>
                    </div>
                  </div>

                  {/* Toggle Crear / Vincular */}
                  <div className="space-y-1">
                    <label className="text-xs font-medium">
                      {t('ruleBuilder.chartOfAccountsLabel')}
                    </label>
                    <div className="grid grid-cols-2 gap-2 bg-slate-900/50 dark:bg-slate-900/80 p-1 rounded-lg border">
                      <button
                        type="button"
                        onClick={() => setGlAccountMode('create')}
                        className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                          glAccountMode === 'create'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {t('ruleBuilder.createNewAuto')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setGlAccountMode('link')}
                        className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                          glAccountMode === 'link'
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {t('ruleBuilder.linkExisting')}
                      </button>
                    </div>
                  </div>

                  {/* Sub-account preview when individual mode */}
                  {localSuggestSubAccount && (
                    <div className="text-xs text-muted-foreground bg-slate-900/20 dark:bg-slate-900/40 p-3 rounded-md border border-slate-700/30 space-y-1">
                      <p className="leading-relaxed">
                        {t('ruleBuilder.subAccountHint').replace('{name}', current.canonicalName)}
                      </p>
                    </div>
                  )}
                </>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={async () => {
                    if (!glAccountId || !glAccountCodeInput) return;
                    setSuggestion({
                      role: current.contextRole || '',
                      account: {
                        code: glAccountCodeInput,
                        name: glAccountNameInput,
                        accountType: allGlAccounts.find((a) => a.id === glAccountId)?.accountType,
                      },
                      suggestSubAccount: localSuggestSubAccount,
                      subAccountName: localSuggestSubAccount ? current.canonicalName : undefined,
                      conditions: [
                        {
                          field: 'description',
                          operator: 'contains',
                          value: current.canonicalName,
                        },
                      ],
                    });
                    // Keep current glAccountMode/localSuggestSubAccount state
                  }}
                  className="flex-1"
                >
                  {t('ruleBuilder.confirmContextBtn')}
                </Button>
                <Button variant="outline" onClick={handleSkip}>
                  {t('ruleBuilder.skipBtn')}
                </Button>
              </div>
            </div>
          ) : !suggestion ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">
                  {t('ruleBuilder.question').replace('{entity}', current.canonicalName)}
                </label>

                {/* Smart Chips / Respuestas Rápidas */}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {(topAccounts.length > 0
                    ? topAccounts.map((account) => {
                        const emojiMap: Record<string, string> = {
                          EXPENSE: '💸',
                          REVENUE: '💰',
                          ASSET: '🏦',
                          LIABILITY: '🔗',
                          EQUITY: '💼',
                        };
                        const emoji = emojiMap[account.accountType] ?? '📊';
                        return {
                          label: `${emoji} ${account.name} (${account.code})`,
                          value: `Es una transacción para ${account.name} (cuenta ${account.code})`,
                        };
                      })
                    : directionLabel === t('ruleBuilder.directionCredit')
                      ? [
                          {
                            label: t('ruleBuilder.chipCollection'),
                            value: t('ruleBuilder.chipCollectionValue'),
                          },
                          {
                            label: t('ruleBuilder.chipRent'),
                            value: t('ruleBuilder.chipRentValue'),
                          },
                          {
                            label: t('ruleBuilder.chipPartnerContribution'),
                            value: t('ruleBuilder.chipPartnerContributionValue'),
                          },
                          {
                            label: t('ruleBuilder.chipInternalTransfer'),
                            value: t('ruleBuilder.chipInternalTransferValue'),
                          },
                        ]
                      : [
                          {
                            label: t('ruleBuilder.chipGeneralExpense'),
                            value: t('ruleBuilder.chipGeneralExpenseValue'),
                          },
                          {
                            label: t('ruleBuilder.chipCarLoan'),
                            value: t('ruleBuilder.chipCarLoanValue'),
                          },
                          {
                            label: t('ruleBuilder.chipPartnerWithdrawal'),
                            value: t('ruleBuilder.chipPartnerWithdrawalValue'),
                          },
                          {
                            label: t('ruleBuilder.chipOfficeRent'),
                            value: t('ruleBuilder.chipOfficeRentValue'),
                          },
                          {
                            label: t('ruleBuilder.chipSalary'),
                            value: t('ruleBuilder.chipSalaryValue'),
                          },
                          {
                            label: t('ruleBuilder.chipCreditCard'),
                            value: t('ruleBuilder.chipCreditCardValue'),
                          },
                        ]
                  ).map((chip, idx) => (
                    <Button
                      key={idx}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => submitWithAnswer(chip.value)}
                      disabled={processingAnswer}
                      className="text-xs h-7 px-2.5 rounded-full hover:bg-primary/10 hover:text-primary transition-all duration-200"
                    >
                      {chip.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex gap-2">
                <Input
                  ref={questionInputRef}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder={t('ruleBuilder.answerPlaceholder')}
                  onKeyDown={(e) => e.key === 'Enter' && !processingAnswer && handleInterpret()}
                  disabled={processingAnswer}
                  className="flex-1"
                />
                <Button
                  onClick={handleInterpret}
                  disabled={processingAnswer || !answer.trim()}
                  size="icon"
                >
                  {processingAnswer ? <Loader2 className="animate-spin" /> : <Send />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('ruleBuilder.answerHint')}</p>
            </div>
          ) : (
            <div className="space-y-4 border-t pt-4 animate-in fade-in slide-in-from-bottom-2">
              <div className="rounded-md bg-primary/5 border border-primary/20 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground">
                  {t('ruleBuilder.suggestedAccount')}
                </p>

                {/* Ancestor chain tree view */}
                {(() => {
                  const currentCode = glAccountCodeInput || suggestion.account.code;
                  const chain = buildAccountChain(allGlAccounts, currentCode);
                  if (chain.length > 1 || localSuggestSubAccount) {
                    return (
                      <div className="flex items-center gap-1.5 text-xs flex-wrap bg-background/50 rounded px-3 py-2 border">
                        {chain.map((acc, i) => (
                          <span key={acc.id} className="flex items-center gap-1">
                            <span className="text-muted-foreground font-mono">{acc.code}</span>
                            <span className="text-foreground">{acc.name}</span>
                            {i < chain.length - 1 && (
                              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                            )}
                          </span>
                        ))}
                        {localSuggestSubAccount && (
                          <>
                            <ChevronRight className="h-3 w-3 text-primary shrink-0" />
                            <span className="text-primary font-semibold">
                              🔽 {suggestion.subAccountName || current.canonicalName}
                              <span className="text-primary/70 font-mono ml-1">
                                (
                                {chain.length > 0
                                  ? getNextSubAccountCode(
                                      chain[chain.length - 1].code,
                                      allGlAccounts,
                                    )
                                  : getNextSubAccountCode(currentCode, allGlAccounts)}
                                )
                              </span>
                            </span>
                          </>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div className="text-xs font-mono text-primary bg-background/50 rounded px-3 py-2 border">
                      🔽 {glAccountNameInput || suggestion.account.name} ({currentCode})
                    </div>
                  );
                })()}

                {suggestion.confidence !== undefined && (
                  <div className={`rounded-lg p-3 border ${
                    suggestion.confidence >= 0.8
                      ? 'bg-green-500/5 border-green-500/20'
                      : suggestion.confidence >= 0.5
                        ? 'bg-amber-500/5 border-amber-500/20'
                        : 'bg-red-500/5 border-red-500/20'
                  }`}>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          suggestion.confidence >= 0.8 ? 'default' :
                          suggestion.confidence >= 0.5 ? 'secondary' :
                          'destructive'
                        }
                        className="text-xs"
                      >
                        {suggestion.confidence >= 0.8 ? t('ruleBuilder.highConfidence') :
                         suggestion.confidence >= 0.5 ? t('ruleBuilder.mediumConfidence') :
                         t('ruleBuilder.lowConfidence')}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {Math.round(suggestion.confidence * 100)}%
                      </span>
                    </div>
                    {suggestion.explanation && (
                      <p className="text-xs text-muted-foreground mt-2">{suggestion.explanation}</p>
                    )}
                    {suggestion.uncertaintyReasons && suggestion.uncertaintyReasons.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {suggestion.uncertaintyReasons.map((reason, idx) => (
                          <li key={idx} className="text-xs text-muted-foreground flex items-start gap-1">
                            <span className="text-red-400 mt-0.5">•</span>
                            {t('ruleBuilder.uncertaintyReason', { reason })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Agrupar / Individual toggle */}
                <div className="space-y-1">
                  <label className="text-xs font-medium">{t('ruleBuilder.groupingLabel')}</label>
                  <div className="grid grid-cols-2 gap-2 bg-slate-900/50 dark:bg-slate-900/80 p-1 rounded-lg border">
                    <button
                      type="button"
                      onClick={() => handleToggleGrouping(false)}
                      className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                        !localSuggestSubAccount
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t('ruleBuilder.groupUnder', { code: suggestion.account.code })}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleGrouping(true)}
                      className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                        localSuggestSubAccount
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t('ruleBuilder.groupIndividual')}
                    </button>
                  </div>
                </div>

                {/* Toggle Crear / Vincular */}
                <div className="space-y-1">
                  <label className="text-xs font-medium">
                    {t('ruleBuilder.chartOfAccountsLabel')}
                  </label>
                  <div className="grid grid-cols-2 gap-2 bg-slate-900/50 dark:bg-slate-900/80 p-1 rounded-lg border">
                    <button
                      type="button"
                      onClick={() => setGlAccountMode('create')}
                      className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                        glAccountMode === 'create'
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t('ruleBuilder.createNewAuto')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setGlAccountMode('link')}
                      className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                        glAccountMode === 'link'
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t('ruleBuilder.linkExisting')}
                    </button>
                  </div>
                </div>

                {glAccountMode === 'create' ? (
                  localSuggestSubAccount ? (
                    <div className="text-xs text-muted-foreground bg-slate-900/20 dark:bg-slate-900/40 p-3 rounded-md border border-slate-700/30 space-y-1">
                      <p className="leading-relaxed">
                        ➔ <strong>Se creará automáticamente</strong> una subcuenta para{' '}
                        <span className="text-primary font-semibold">
                          "{suggestion.subAccountName || current.canonicalName}"
                        </span>{' '}
                        bajo la cuenta padre{' '}
                        <strong>
                          {suggestion.account.code} -{' '}
                          {allGlAccounts.find((a) => a.code === suggestion.account.code)?.name ||
                            suggestion.account.name}
                        </strong>{' '}
                        (ej. {suggestion.account.code}-01, {suggestion.account.code}-02, etc.).
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium">
                          {t('ruleBuilder.codeLabel')}
                        </label>
                        <Input
                          value={glAccountCodeInput}
                          onChange={(e) => setGlAccountCodeInput(e.target.value)}
                          className="h-7 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] font-medium">
                          {t('ruleBuilder.nameLabel')}
                        </label>
                        <Input
                          value={glAccountNameInput}
                          onChange={(e) => setGlAccountNameInput(e.target.value)}
                          className="h-7 text-xs"
                        />
                      </div>
                    </div>
                  )
                ) : (
                  <div className="space-y-1">
                    <AccountSelector
                      accounts={allGlAccounts.filter(
                        (a) =>
                          !suggestion.account.accountType ||
                          a.accountType === suggestion.account.accountType,
                      )}
                      value={glAccountId}
                      onChange={(id) => {
                        setGlAccountId(id);
                        const selected = allGlAccounts.find((a) => a.id === id);
                        if (selected) {
                          setGlAccountCodeInput(selected.code);
                          setGlAccountNameInput(selected.name);
                        }
                      }}
                      placeholder={t('ruleBuilder.selectAccountPlaceholder')}
                    />
                  </div>
                )}

                {localSuggestSubAccount && (
                  <p className="text-xs text-muted-foreground border-t pt-2">
                    {t('ruleBuilder.subAccountHint').replace(
                      '{name}',
                      suggestion.subAccountName || current.canonicalName,
                    )}
                  </p>
                )}
                {/* Condition Editor */}
                <div className="text-xs text-muted-foreground mt-2 border-t pt-2 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-foreground text-sm">
                      {t('ruleBuilder.conditionsTitle')}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditableConditions((prev) => [
                          ...prev,
                          { field: 'description', operator: 'contains', value: '' },
                        ]);
                      }}
                      className="h-7 px-2 text-[10px]"
                    >
                      <Plus className="h-3 w-3 mr-1" /> {t('ruleBuilder.addCondition')}
                    </Button>
                  </div>

                  {editableConditions.length === 0 ? (
                    <p className="text-xs italic text-muted-foreground">
                      {t('ruleBuilder.noConditions')}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {editableConditions.map((cond, idx) => (
                        <div key={idx} className="flex gap-1.5 items-center">
                          {/* Field Select */}
                          <select
                            value={cond.field}
                            onChange={(e) => {
                              const newField = e.target.value as
                                | 'description'
                                | 'amount'
                                | 'reference';
                              setEditableConditions((prev) => {
                                const copy = [...prev];
                                copy[idx] = {
                                  ...copy[idx],
                                  field: newField,
                                  operator: newField === 'amount' ? 'greater_than' : 'contains',
                                };
                                return copy;
                              });
                            }}
                            className="h-8 rounded-md border border-input bg-transparent px-2 text-[11px] shadow-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            <option value="description" className="bg-background text-foreground">
                              {t('ruleBuilder.fieldDescription')}
                            </option>
                            <option value="amount" className="bg-background text-foreground">
                              {t('ruleBuilder.fieldAmount')}
                            </option>
                            <option value="reference" className="bg-background text-foreground">
                              {t('ruleBuilder.fieldReference')}
                            </option>
                          </select>

                          {/* Operator Select */}
                          <select
                            value={cond.operator}
                            onChange={(e) => {
                              const op = e.target.value as RuleCondition['operator'];
                              setEditableConditions((prev) => {
                                const copy = [...prev];
                                copy[idx] = { ...copy[idx], operator: op };
                                return copy;
                              });
                            }}
                            className="h-8 rounded-md border border-input bg-transparent px-2 text-[11px] shadow-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {cond.field === 'amount' ? (
                              <>
                                <option value="equals" className="bg-background text-foreground">
                                  {t('ruleBuilder.opEquals')}
                                </option>
                                <option
                                  value="greater_than"
                                  className="bg-background text-foreground"
                                >
                                  {t('ruleBuilder.opGreaterThan')}
                                </option>
                                <option value="less_than" className="bg-background text-foreground">
                                  {t('ruleBuilder.opLessThan')}
                                </option>
                              </>
                            ) : (
                              <>
                                <option value="contains" className="bg-background text-foreground">
                                  {t('ruleBuilder.opContains')}
                                </option>
                                <option value="equals" className="bg-background text-foreground">
                                  {t('ruleBuilder.opEquals')}
                                </option>
                                <option
                                  value="starts_with"
                                  className="bg-background text-foreground"
                                >
                                  {t('ruleBuilder.opStartsWith')}
                                </option>
                                <option value="ends_with" className="bg-background text-foreground">
                                  {t('ruleBuilder.opEndsWith')}
                                </option>
                              </>
                            )}
                          </select>

                          {/* Value Input */}
                          <Input
                            value={cond.value}
                            onChange={(e) => {
                              const val = e.target.value;
                              setEditableConditions((prev) => {
                                const copy = [...prev];
                                copy[idx] = { ...copy[idx], value: val };
                                return copy;
                              });
                            }}
                            placeholder={t('ruleBuilder.valuePlaceholder')}
                            className="h-8 text-[11px] flex-1 min-w-[80px]"
                          />

                          {/* Remove Button */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditableConditions((prev) => prev.filter((_, i) => i !== idx));
                            }}
                            className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Live Simulation Preview Badge and Details */}
                  {editableConditions.length > 0 && (
                    <div className="flex flex-col gap-2 pt-2 border-t mt-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-foreground">
                          {t('ruleBuilder.simulation')}
                        </span>
                        {isSimulating ? (
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            <span>{t('ruleBuilder.evaluating')}</span>
                          </div>
                        ) : simulationResult ? (
                          <Dialog open={showSamplesModal} onOpenChange={setShowSamplesModal}>
                            <DialogTrigger asChild>
                              <Badge
                                variant={simulationResult.matchCount > 0 ? 'secondary' : 'outline'}
                                className="cursor-pointer text-[10px] h-5 hover:bg-primary/10 hover:text-primary transition-all flex items-center gap-1 select-none"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                {simulationResult.matchCount === 1
                                  ? t('ruleBuilder.matchesSingle')
                                  : t('ruleBuilder.matchesPlural').replace(
                                      '{count}',
                                      String(simulationResult.matchCount),
                                    )}
                              </Badge>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-[500px]">
                              <DialogHeader>
                                <DialogTitle>{t('ruleBuilder.simulationPreview')}</DialogTitle>
                              </DialogHeader>
                              <div className="space-y-4 pt-2">
                                <p className="text-xs text-muted-foreground">
                                  {t('ruleBuilder.simulationDescription')}
                                </p>
                                {simulationResult.samples.length === 0 ? (
                                  <div className="text-center p-6 bg-muted/30 rounded-md text-xs italic text-muted-foreground">
                                    {t('ruleBuilder.noMatchingTransactions')}
                                  </div>
                                ) : (
                                  <div className="divide-y border rounded-md overflow-hidden bg-background">
                                    {simulationResult.samples.map((sample, sIdx) => (
                                      <div
                                        key={sIdx}
                                        className="p-3 text-xs flex justify-between gap-4 hover:bg-muted/30 transition-colors"
                                      >
                                        <div className="space-y-1">
                                          <p className="font-semibold text-foreground line-clamp-1">
                                            {sample.description}
                                          </p>
                                          <div className="flex items-center gap-2 text-muted-foreground text-[10px]">
                                            <span>
                                              {new Date(sample.date).toLocaleDateString()}
                                            </span>
                                            {sample.reference && (
                                              <>
                                                <span>•</span>
                                                <span>
                                                  {t('ruleBuilder.refLabel')} {sample.reference}
                                                </span>
                                              </>
                                            )}
                                          </div>
                                        </div>
                                        <span
                                          className={`font-mono font-semibold ${sample.amount < 0 ? 'text-red-500' : 'text-green-500'}`}
                                        >
                                          {sample.amount < 0 ? '-' : ''}$
                                          {Math.abs(sample.amount).toFixed(2)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </DialogContent>
                          </Dialog>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  onDoubleClick={handleConfirm}
                  onClick={() => setClickCount((c) => c + 1)}
                  disabled={creatingRule}
                  className="flex-1 select-none transition-all duration-200"
                >
                  {creatingRule ? (
                    <Loader2 className="animate-spin mr-2" />
                  ) : (
                    <CheckCircle2 className="mr-2" />
                  )}
                  {clickCount === 1
                    ? t('ruleBuilder.doubleClickConfirm')
                    : t('ruleBuilder.confirmBtn')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setSuggestion(null)}
                  disabled={creatingRule}
                >
                  {t('ruleBuilder.editBtn')}
                </Button>
              </div>
            </div>
          )}

          {/* Navegación */}
          {currentIndex < candidates.length - 1 && (
            <div className="flex justify-end pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSkip}
                disabled={processingAnswer || creatingRule}
              >
                {t('ruleBuilder.skipBtn')} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* GL Account creation/link modal */}
      <Dialog open={glAccountModalOpen} onOpenChange={setGlAccountModalOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t('ruleBuilder.accountNotFoundTitle')}</DialogTitle>
            <DialogDescription>
              {t('ruleBuilder.accountNotFoundDescription', { code: glAccountCodeInput })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Toggle Crear / Vincular */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('ruleBuilder.chartOfAccountsLabel')}</label>
              <div className="grid grid-cols-2 gap-2 bg-slate-900/50 dark:bg-slate-900/80 p-1 rounded-lg border">
                <button
                  type="button"
                  onClick={() => setGlAccountMode('create')}
                  className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                    glAccountMode === 'create'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t('ruleBuilder.createNewAuto')}
                </button>
                <button
                  type="button"
                  onClick={() => setGlAccountMode('link')}
                  className={`py-1.5 text-xs font-semibold rounded-md transition-all ${
                    glAccountMode === 'link'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t('ruleBuilder.linkExisting')}
                </button>
              </div>
            </div>

            {glAccountMode === 'create' ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    {t('ruleBuilder.codeLabel')} <span className="text-red-500">*</span>
                  </label>
                  <Input
                    placeholder={t('ruleBuilder.accountCodePlaceholder')}
                    value={glAccountCodeInput}
                    onChange={(e) => setGlAccountCodeInput(e.target.value)}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    {t('ruleBuilder.nameLabel')} <span className="text-red-500">*</span>
                  </label>
                  <Input
                    placeholder={t('ruleBuilder.accountNamePlaceholder')}
                    value={glAccountNameInput}
                    onChange={(e) => setGlAccountNameInput(e.target.value)}
                  />
                </div>
                <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-3 text-xs leading-relaxed text-blue-300 space-y-2">
                  <p className="font-semibold text-blue-400">{t('ruleBuilder.autoConfigTitle')}</p>
                  {localSuggestSubAccount ? (
                    <>
                      <p>{t('ruleBuilder.hierarchicalAccountsInfo')}</p>
                      <div className="mt-1 bg-slate-950/80 p-2.5 rounded border border-white/5 font-mono text-[11px] text-white space-y-1.5">
                        <div className="flex items-center gap-1">
                          <span className="text-slate-400">{t('ruleBuilder.glCodeLabel')}</span>{' '}
                          <span className="text-blue-400 font-bold">
                            {glAccountCodeInput || '---'}
                          </span>
                          <span className="text-xs text-muted-foreground">—</span>
                          <span className="text-emerald-400 font-bold">
                            {glAccountNameInput || '---'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 pl-4 border-l-2 border-indigo-500/30">
                          <ChevronRight className="h-3 w-3 text-indigo-400 shrink-0" />
                          <span className="text-blue-400 font-bold">
                            {getNextSubAccountCode(glAccountCodeInput, allGlAccounts)}
                          </span>
                          <span className="text-xs text-muted-foreground">—</span>
                          <span className="text-emerald-400 font-bold">
                            {suggestion?.subAccountName || glAccountNameInput}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">{t('ruleBuilder.bothTypesLabel')}</span>{' '}
                          <span className="text-amber-400 font-bold">
                            {accountTypeLabel(suggestion?.account.accountType, t)}
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>{t('ruleBuilder.standaloneAccountInfo')}</p>
                      <div className="mt-1 bg-slate-950/80 p-2.5 rounded border border-white/5 font-mono text-[11px] text-white space-y-1">
                        <div>
                          <span className="text-slate-400">{t('ruleBuilder.glCodeLabel')}</span>{' '}
                          <span className="text-blue-400 font-bold">
                            {glAccountCodeInput || '---'}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">{t('ruleBuilder.glNameLabel')}</span>{' '}
                          <span className="text-emerald-400 font-bold">
                            {glAccountNameInput || '---'}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400">{t('ruleBuilder.typeLabel')}</span>{' '}
                          <span className="text-amber-400 font-bold">
                            {accountTypeLabel(suggestion?.account.accountType, t)}
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('ruleBuilder.existingAccountLabel')} <span className="text-red-500">*</span>
                </label>
                <AccountSelector
                  accounts={allGlAccounts.filter(
                    (a) =>
                      !suggestion?.account.accountType ||
                      a.accountType === suggestion.account.accountType,
                  )}
                  value={glAccountId}
                  onChange={setGlAccountId}
                  placeholder={t('ruleBuilder.selectAccountPlaceholder')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('ruleBuilder.filteredByTypeHint', {
                    type: accountTypeLabel(suggestion?.account.accountType, t),
                  })}
                  .
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGlAccountModalOpen(false)}
              disabled={savingGlAccount}
            >
              {t('ruleBuilder.cancelBtn')}
            </Button>
            <Button onClick={handleSaveGlAccount} disabled={savingGlAccount}>
              {savingGlAccount && <Loader2 className="size-4 mr-1 animate-spin" />}
              {t('ruleBuilder.saveAndContinueBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-[10px] text-muted-foreground/50 text-center mt-4 italic px-4">
        {t('ruleBuilder.cpaDisclaimer') ||
          'Las sugerencias contables son borradores operacionales. La validación semántica final, de cierre y fiscal es responsabilidad exclusiva de un CPA licenciado.'}
      </p>
    </div>
  );
}
