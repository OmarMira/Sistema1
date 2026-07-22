import { db } from '@/lib/db';
import {
  matchTransactionsWithShadow,
  executeApplyAll,
} from '@/lib/services/apply-all-engine';
import { persistShadowSummaryBestEffort } from '@/lib/services/rule-precedence-shadow';
import type { MatchResult, ApplyResult } from '@/lib/services/apply-all-engine';
import { ShadowMetricsReader } from '@/lib/services/shadow-metrics-reader';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
import { isOperationalPolicyObservationEnabled } from '@/lib/rule-engine/flag';
import {
  observePolicy,
  type PolicyObservationResponse,
} from '@/lib/operational-policy/apply-all-observer';
import { APPLY_ALL_OBSERVATION_CONFIG } from '@/lib/operational-policy/apply-all-observation-config';
import type { OperationalPolicyDecision } from '@/lib/operational-policy/types';
import { AppError, ValidationError } from '@/lib/api-error';

export interface ApplyAllUseCaseResult {
  matchResult: MatchResult;
  applyResult: ApplyResult;
  policyObservation?: PolicyObservationResponse;
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
): Promise<ApplyAllUseCaseResult> {
  const result = await matchTransactionsWithShadow(companyId, { limit: 200 });
  const { matchResult } = result;

  if (matchResult.matchedRules.length === 0 || matchResult.totalCount === 0) {
    return {
      matchResult,
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
    };
  }

  const applyResult = await db.$transaction(async (tx) => {
    return executeApplyAll(companyId, tx, matchResult);
  });

  if (result.kind === 'with-shadow') {
    await persistShadowSummaryBestEffort({
      companyId,
      entity: 'ApplyAllBatch',
      entityId: result.shadow.batchId,
      summary: result.shadow.summary,
    });
  }

  // ── S7-08: Observational policy block ─────────────────────
  let policyObservation: PolicyObservationResponse | undefined;

  if (isOperationalPolicyObservationEnabled() && result.kind === 'with-shadow') {
    try {
      const provider = new ShadowMetricsReader(new PrismaAuditLogRepository(db));
      const metricsWindow = buildObservationWindow(
        new Date(),
        APPLY_ALL_OBSERVATION_CONFIG.windowDays,
      );

      policyObservation = await observePolicy({
        companyId,
        context: 'APPLY_ALL',
        provider,
        metricsWindow,
      });

      if (policyObservation.status === 'AVAILABLE') {
        await persistOperationalPolicyObservationBestEffort({
          companyId,
          entityId: result.shadow.batchId,
          decision: policyObservation.decision,
          metricsWindow,
        });
      }
    } catch (error) {
      policyObservation = {
        status: 'UNAVAILABLE',
        errorCode: classifyObservationError(error),
      };
    }
  }
  // ──────────────────────────────────────────────────────────

  return { matchResult, applyResult, policyObservation };
}
