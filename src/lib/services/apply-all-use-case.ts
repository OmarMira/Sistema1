import { db } from '@/lib/db';
import {
  matchTransactionsWithShadow,
  executeApplyAll,
} from '@/lib/services/apply-all-engine';
import { persistShadowSummaryBestEffort } from '@/lib/services/rule-precedence-shadow';
import type { MatchResult, ApplyResult } from '@/lib/services/apply-all-engine';
import { ShadowMetricsReader, type ShadowMetricsQuery } from '@/lib/services/shadow-metrics-reader';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
import { isOperationalPolicyObservationEnabled } from '@/lib/rule-engine/flag';
import {
  observePolicy,
  type PolicyObservationResponse,
} from '@/lib/operational-policy/apply-all-observer';
import { APPLY_ALL_OBSERVATION_CONFIG } from '@/lib/operational-policy/apply-all-observation-config';
import { evaluateOperationalPolicy } from '@/lib/operational-policy/policy-service';
import type { OperationalPolicyDecision, OperationalPolicyProfile } from '@/lib/operational-policy/types';
import { AppError, ValidationError } from '@/lib/api-error';
import { evaluateTransactionAgainstRules } from '@/lib/services/rule-precedence-engine';
import { toRulePrecedenceRule } from '@/lib/services/rule-precedence-shadow';
import type { RulePrecedenceRule, RulePrecedenceTransaction } from '@/lib/services/rule-precedence-engine';

// ── S7-11: Enforcement types ─────────────────────────────────────────

export type EnforcementStatus = 'EXECUTED' | 'CONFIRMATION_REQUIRED' | 'BLOCKED';

export interface PolicyWarning {
  reasonCode: string;
  transactionCount: number;
  profileId: string;
  profileVersion: string;
}

export interface PolicyUnavailable {
  errorCode: string;
}

export interface ConfirmationDecision {
  reasonCode: string;
  summary: string;
  profileId: string;
  profileVersion: string;
  readinessStatus: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
}

export interface ConfirmationContext {
  transactionCount: number;
  matchedRuleCount: number;
}

export interface BlockReason {
  reasonCode: string;
  summary: string;
  profileId: string;
  profileVersion: string;
}

export interface EnforcementResult {
  status: EnforcementStatus;
  policyWarning?: PolicyWarning;
  policyUnavailable?: PolicyUnavailable;
  decision?: ConfirmationDecision;
  context?: ConfirmationContext;
  block?: BlockReason;
}

export interface ApplyAllUseCaseResult {
  matchResult: MatchResult;
  applyResult: ApplyResult;
  policyObservation?: PolicyObservationResponse;
  enforcement?: EnforcementResult;
}

function buildObservationWindow(
  now: Date,
  windowDays: number,
): { from: Date; to: Date } {
  const from = new Date(now);
  from.setDate(from.getDate() - windowDays);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}

function classifyObservationError(error: unknown): string {
  if (error instanceof ValidationError) {
    return 'POLICY_VALIDATION_ERROR';
  }
  if (error instanceof AppError) {
    return 'POLICY_PROVIDER_ERROR';
  }
  return 'POLICY_INTERNAL_ERROR';
}

// ── S7-11: Enforcement profile (inline — extract only when a second consumer needs it) ──

const ENFORCEMENT_PROFILE: OperationalPolicyProfile = {
  id: 'standard-enforcement-v1',
  name: 'Standard Enforcement Policy',
  version: '1.0.0',
  defaultAction: 'ALLOW',
  rules: [
    {
      id: 'enforce-apply-all-not-ready',
      context: 'APPLY_ALL',
      readinessStatus: 'NOT_READY',
      action: 'CONFIRM',
      reasonCode: 'READINESS_NOT_MET',
      description: 'Apply All readiness not met. User confirmation required.',
    },
    {
      id: 'enforce-apply-all-insufficient',
      context: 'APPLY_ALL',
      readinessStatus: 'INSUFFICIENT_DATA',
      action: 'CONFIRM',
      reasonCode: 'INSUFFICIENT_SAMPLE',
      description: 'Insufficient Apply All history. User confirmation required.',
    },
  ],
};

function classifyEnforcementError(error: unknown): string {
  if (error instanceof ValidationError) return 'POLICY_VALIDATION_ERROR';
  if (error instanceof AppError) return 'POLICY_PROVIDER_ERROR';
  return 'POLICY_INTERNAL_ERROR';
}

async function evaluatePolicy(
  companyId: string,
  matchResult: MatchResult,
  confirmed?: boolean,
): Promise<EnforcementResult> {
  const policyWindow = buildObservationWindow(new Date(), APPLY_ALL_OBSERVATION_CONFIG.windowDays);
  const policyProvider = new ShadowMetricsReader(new PrismaAuditLogRepository(db));

  try {
    const metricsQuery: ShadowMetricsQuery = {
      ...APPLY_ALL_OBSERVATION_CONFIG.metricsQueryTemplate,
      companyId,
      from: policyWindow.from,
      to: policyWindow.to,
    };

    const decision = await evaluateOperationalPolicy(
      { context: 'APPLY_ALL', metricsQuery },
      APPLY_ALL_OBSERVATION_CONFIG.criteria,
      policyProvider,
      ENFORCEMENT_PROFILE,
    );

    return buildEnforcementResult(decision, matchResult, confirmed);
  } catch (error) {
    return {
      status: 'EXECUTED',
      policyUnavailable: { errorCode: classifyEnforcementError(error) },
    };
  }
}

function buildEnforcementResult(
  decision: OperationalPolicyDecision,
  matchResult: MatchResult,
  confirmed?: boolean,
): EnforcementResult {
  switch (decision.action) {
    case 'ALLOW':
      return { status: 'EXECUTED' };

    case 'WARN':
      return {
        status: 'EXECUTED',
        policyWarning: {
          reasonCode: decision.reasons.reasonCode,
          transactionCount: matchResult.totalCount,
          profileId: decision.profileId,
          profileVersion: decision.profileVersion,
        },
      };

    case 'CONFIRM':
      if (confirmed) return { status: 'EXECUTED' };
      return {
        status: 'CONFIRMATION_REQUIRED',
        decision: {
          reasonCode: decision.reasons.reasonCode,
          summary: decision.reasons.summary,
          profileId: decision.profileId,
          profileVersion: decision.profileVersion,
          readinessStatus: decision.readiness.status,
        },
        context: {
          transactionCount: matchResult.totalCount,
          matchedRuleCount: matchResult.matchedRules.length,
        },
      };

    case 'BLOCK':
      return {
        status: 'BLOCKED',
        block: {
          reasonCode: decision.reasons.reasonCode,
          summary: decision.reasons.summary,
          profileId: decision.profileId,
          profileVersion: decision.profileVersion,
        },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────

async function persistOperationalPolicyObservationBestEffort(
  params: {
    companyId: string;
    entityId: string;
    decision: OperationalPolicyDecision;
    metricsWindow: { from: Date; to: Date };
  },
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        companyId: params.companyId,
        action: 'OPERATIONAL_POLICY_OBSERVATION',
        entity: 'ApplyAllBatch',
        entityId: params.entityId,
        details: JSON.stringify({
          policySchemaVersion: 1,
          context: params.decision.context,
          profileId: params.decision.profileId,
          profileVersion: params.decision.profileVersion,
          action: params.decision.action,
          reasonCode: params.decision.reasons.reasonCode,
          readinessStatus: params.decision.readiness.status,
          metricsWindow: {
            from: params.metricsWindow.from.toISOString(),
            to: params.metricsWindow.to.toISOString(),
            source: 'APPLY_ALL',
            trustPolicy: 'INCLUDE_LEGACY_IMPORT',
          },
        }),
      },
    });
  } catch {
    // best-effort — I9: failure does not degrade AVAILABLE
  }
}

export interface ApplyAllUseCaseOptions {
  confirmed?: boolean;
  mode?: 'batch' | 'single';
  transactionId?: string;
  forcedRuleId?: string;
}

/**
 * @internal Helper for executeSingleUseCase. Do not use outside this module.
 */
function buildMiniMatchResult(
  singleTx: { id: string; amount: number; description: string },
  rule: { id: string; name: string; priority: number | null },
  confidenceLabel: 'high' | 'medium' | 'low',
): MatchResult {
  const distribution = { high: 0, medium: 0, low: 0 };
  distribution[confidenceLabel] = 1;

  return {
    matchedRules: [{
      rule: { id: rule.id, name: rule.name, priority: rule.priority },
      txIds: [singleTx.id],
      confidenceDistribution: distribution,
    }],
    transactions: [singleTx],
    totalAmount: singleTx.amount,
    totalCount: 1,
    remaining: 0,
  };
}

async function executeSingleUseCase(
  companyId: string,
  options: Required<Pick<ApplyAllUseCaseOptions, 'transactionId' | 'forcedRuleId'>> & { confirmed?: boolean },
): Promise<ApplyAllUseCaseResult> {
  const { transactionId, forcedRuleId, confirmed } = options;

  // 1. Validate transaction exists and belongs to company
  const bankTx = await db.bankTransaction.findUnique({
    where: { id: transactionId },
    include: {
      statement: { select: { companyId: true, bankAccountId: true } },
    },
  });

  if (!bankTx || bankTx.statement.companyId !== companyId) {
    throw new ValidationError('TRANSACTION_NOT_FOUND', 'Transacción no encontrada o no pertenece a la empresa');
  }

  // 2. Validate forced rule exists and belongs to company
  const forcedRule = await db.bankRule.findUnique({
    where: { id: forcedRuleId },
  });

  if (!forcedRule || forcedRule.companyId !== companyId) {
    throw new ValidationError('RULE_NOT_FOUND', 'Regla no encontrada o no pertenece a la empresa');
  }

  // 3. Validate forced rule is active
  if (!forcedRule.isActive) {
    throw new ValidationError('RULE_INACTIVE', 'La regla seleccionada no está activa');
  }

  // 4. Validate transaction has no journal entry yet
  if (bankTx.journalEntryId) {
    throw new ValidationError('TRANSACTION_ALREADY_MATCHED', 'La transacción ya tiene un asiento contable');
  }

  // 5. Validate fiscal period is not locked
  const fiscalPeriod = await db.fiscalPeriod.findFirst({
    where: {
      companyId,
      startDate: { lte: bankTx.date },
      endDate: { gte: bankTx.date },
    },
  });

  if (fiscalPeriod?.isLocked) {
    throw new ValidationError('PERIOD_LOCKED', 'El período contable está bloqueado');
  }

  // 6. Run matching for this single transaction → get candidates
  const activeRules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    orderBy: { priority: 'asc' },
  });

  if (activeRules.length === 0) {
    throw new ValidationError('NO_RULES', 'No hay reglas activas disponibles');
  }

  const engineRules: RulePrecedenceRule[] = activeRules.map(toRulePrecedenceRule);
  const txData: RulePrecedenceTransaction = {
    id: bankTx.id,
    date: bankTx.date,
    description: bankTx.description,
    amount: Number(bankTx.amount),
    bankAccountId: bankTx.statement.bankAccountId,
  };

  const match = evaluateTransactionAgainstRules(txData, engineRules);

  // 7. Validate forcedRuleId is in candidates
  const isCandidate = match.candidates.some((c) => c.ruleId === forcedRuleId);
  if (!isCandidate) {
    throw new ValidationError(
      'RULE_NOT_CANDIDATE',
      'La regla seleccionada no es un candidato válido para esta transacción',
    );
  }

  const winnerCandidate = match.candidates.find((c) => c.ruleId === forcedRuleId)!;

  // 8. Build mini MatchResult
  const singleTx = {
    id: bankTx.id,
    amount: Number(bankTx.amount),
    description: bankTx.description,
  };

  const matchResult = buildMiniMatchResult(
    singleTx,
    { id: forcedRule.id, name: forcedRule.name, priority: forcedRule.priority },
    winnerCandidate.confidenceLabel,
  );

  // 9. Evaluate Operational Policy (respecting confirmed)
  const enforcementResult = await evaluatePolicy(companyId, matchResult, confirmed);

  if (enforcementResult.status === 'CONFIRMATION_REQUIRED' || enforcementResult.status === 'BLOCKED') {
    return {
      matchResult,
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
      enforcement: enforcementResult,
    };
  }

  // 10. Execute apply inside transaction
  const applyResult = await db.$transaction(async (tx) => {
    return executeApplyAll(companyId, tx, matchResult);
  });

  // 11. Audit with resolutionSource: USER (only after successful apply)
  try {
    await db.auditLog.create({
      data: {
        companyId,
        userId: undefined, // caller should set this
        action: 'RULE_AMBIGUITY_RESOLUTION',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          resolutionSource: 'USER',
          engineResult: 'AMBIGUOUS',
          selectedRuleId: forcedRuleId,
          transactionId,
          resolvedAt: new Date().toISOString(),
        }),
      },
    });
  } catch {
    // best-effort — apply already succeeded
  }

  return {
    matchResult,
    applyResult,
    enforcement: enforcementResult,
  };
}

export async function executeApplyAllUseCase(
  companyId: string,
  options?: ApplyAllUseCaseOptions,
): Promise<ApplyAllUseCaseResult> {
  if (options?.mode === 'single') {
    if (!options.transactionId || !options.forcedRuleId) {
      throw new ValidationError('INVALID_PARAMS', 'transactionId y forcedRuleId son requeridos en modo single');
    }
    return executeSingleUseCase(companyId, {
      transactionId: options.transactionId,
      forcedRuleId: options.forcedRuleId,
      confirmed: options.confirmed,
    });
  }
  const result = await matchTransactionsWithShadow(companyId, { limit: 200 });
  const { matchResult } = result;

  if (matchResult.matchedRules.length === 0 || matchResult.totalCount === 0) {
    return {
      matchResult,
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
    };
  }

  // ── S7-11: Enforcement evaluation ──────────────────────
  const enforcementResult = await evaluatePolicy(companyId, matchResult, options?.confirmed);

  // ── S7-11: Decision gate ───────────────────────────────
  if (enforcementResult.status === 'CONFIRMATION_REQUIRED' || enforcementResult.status === 'BLOCKED') {
    return {
      matchResult,
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
      enforcement: enforcementResult,
    };
  }

  // ── Transaction ────────────────────────────────────────
  const applyResult = await db.$transaction(async (tx) => {
    return executeApplyAll(companyId, tx, matchResult);
  });

  // ── Shadow persist ─────────────────────────────────────
  if (result.kind === 'with-shadow') {
    await persistShadowSummaryBestEffort({
      companyId,
      entity: 'ApplyAllBatch',
      entityId: result.shadow.batchId,
      summary: result.shadow.summary,
    });
  }

  // ── S7-08: Observational policy block ─────────────
  const policyWindow = buildObservationWindow(new Date(), APPLY_ALL_OBSERVATION_CONFIG.windowDays);
  const policyProvider = new ShadowMetricsReader(new PrismaAuditLogRepository(db));
  let policyObservation: PolicyObservationResponse | undefined;

  if (isOperationalPolicyObservationEnabled() && result.kind === 'with-shadow') {
    try {
      policyObservation = await observePolicy({
        companyId,
        context: 'APPLY_ALL',
        provider: policyProvider,
        metricsWindow: policyWindow,
      });

      if (policyObservation.status === 'AVAILABLE') {
        await persistOperationalPolicyObservationBestEffort({
          companyId,
          entityId: result.shadow.batchId,
          decision: policyObservation.decision,
          metricsWindow: policyWindow,
        });
      }
    } catch (error) {
      policyObservation = {
        status: 'UNAVAILABLE',
        errorCode: classifyObservationError(error),
      };
    }
  }
  // ────────────────────────────────────────────────────────

  return { matchResult, applyResult, policyObservation, enforcement: enforcementResult };
}
