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

export async function executeApplyAllUseCase(
  companyId: string,
  options?: { confirmed?: boolean },
): Promise<ApplyAllUseCaseResult> {
  const result = await matchTransactionsWithShadow(companyId, { limit: 200 });
  const { matchResult } = result;

  if (matchResult.matchedRules.length === 0 || matchResult.totalCount === 0) {
    return {
      matchResult,
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
    };
  }

  // ── S7-11: Create shared policy resources ───────────────
  const policyWindow = buildObservationWindow(new Date(), APPLY_ALL_OBSERVATION_CONFIG.windowDays);
  const policyProvider = new ShadowMetricsReader(new PrismaAuditLogRepository(db));

  // ── S7-11: Enforcement evaluation ──────────────────────
  let enforcementResult: EnforcementResult | undefined;

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

    enforcementResult = buildEnforcementResult(decision, matchResult, options?.confirmed);
  } catch (error) {
    enforcementResult = {
      status: 'EXECUTED',
      policyUnavailable: { errorCode: classifyEnforcementError(error) },
    };
  }

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

  // ── S7-08: Observational policy block (reuses policyWindow + policyProvider) ──
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
