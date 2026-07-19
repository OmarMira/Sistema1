import type { Prisma } from '@prisma/client';
import { evaluateTransactionAgainstRules, type RulePrecedenceRule, type RulePrecedenceTransaction } from './rule-precedence-engine';
import { logger } from '@/lib/logger';
import { createAuditLogWithRetry } from '@/lib/audit';

// Types — S7-02/S7-03 shared (do not modify)

export type ShadowComparison =
  | 'SAME_WINNER'
  | 'BOTH_NO_MATCH'
  | 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH'
  | 'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH'
  | 'DIFFERENT_WINNER'
  | 'CANONICAL_AMBIGUOUS';

export interface ShadowComparisonResult {
  comparison: ShadowComparison;
  productiveWinnerId: string | null;
  canonicalWinnerId: string | null;
  canonicalAmbiguous: boolean;
  canonicalReason: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
}

// Shadow metrics — S7-02/S7-03 shared (do not modify)

export interface ShadowImportSummary {
  totalEvaluated: number;
  sameWinner: number;
  bothNoMatch: number;
  productiveMatchCanonicalNoMatch: number;
  productiveNoMatchCanonicalMatch: number;
  differentWinner: number;
  canonicalAmbiguous: number;
  shadowErrors: number;
}

// ─── S7-04C: Apply All Shadow types ────────────────────────

export type DivergenceComparison = 'SAME' | 'DIFFERENT';

export type DivergenceReason =
  | 'NO_MATCH'
  | 'AMBIGUOUS'
  | 'UNDETERMINED'
  | 'OTHER';

export interface ComparisonEvidence {
  productiveWinnerId: string | null;
  canonicalWinnerId: string | null;
  canonicalReason: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
}

export interface DivergenceClassification {
  comparison: DivergenceComparison;
  reason: DivergenceReason | null;
}

export interface ShadowExecutionSummary {
  totalEvaluated: number;
  sameWinner: number;
  bothNoMatch: number;
  productiveMatchCanonicalNoMatch: number;
  productiveNoMatchCanonicalMatch: number;
  differentWinner: number;
  canonicalAmbiguous: number;
  shadowErrors: number;
  divergenceReasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}

export interface ShadowPersistencePayload {
  totalEvaluated: number;
  sameWinner: number;
  differentWinner: number;
  shadowErrors: number;
  divergenceReasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}

export type ShadowExecutionResult =
  | { ok: true; comparison: ShadowComparisonResult }
  | { ok: false };

export function createEmptyShadowImportSummary(): ShadowImportSummary {
  return {
    totalEvaluated: 0,
    sameWinner: 0,
    bothNoMatch: 0,
    productiveMatchCanonicalNoMatch: 0,
    productiveNoMatchCanonicalMatch: 0,
    differentWinner: 0,
    canonicalAmbiguous: 0,
    shadowErrors: 0,
  };
}

// Flag

export function isRulePrecedenceShadowEnabled(): boolean {
  return process.env.RULE_PRECEDENCE_SHADOW_ENABLED === 'true';
}

// Adapter

export function toRulePrecedenceRule(source: {
  id: string;
  conditions: Prisma.JsonValue;
  conditionType: string | null;
  conditionValue: string | null;
  transactionDirection: string | null;
  priority: number;
  glAccountId: string | null;
  debitGlAccountId: string | null;
  creditGlAccountId: string | null;
  isActive: boolean;
}): RulePrecedenceRule {
  return {
    id: source.id,
    conditions: source.conditions,
    conditionType: source.conditionType,
    conditionValue: source.conditionValue,
    transactionDirection: source.transactionDirection,
    priority: source.priority,
    glAccountId: source.glAccountId,
    debitGlAccountId: source.debitGlAccountId,
    creditGlAccountId: source.creditGlAccountId,
    isActive: source.isActive,
  };
}

// Pure comparison

export function compareRuleDecisions(
  tx: RulePrecedenceTransaction,
  rules: RulePrecedenceRule[],
  productiveWinnerId: string | null,
): ShadowComparisonResult {
  const output = evaluateTransactionAgainstRules(tx, rules);

  const canonicalWinnerId = output.winner?.ruleId ?? null;

  let comparison: ShadowComparison;
  if (output.reason === 'NO_MATCH' && productiveWinnerId === null) {
    comparison = 'BOTH_NO_MATCH';
  } else if (output.reason === 'NO_MATCH' && productiveWinnerId !== null) {
    comparison = 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH';
  } else if (output.reason === 'WINNER' && productiveWinnerId === null) {
    comparison = 'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH';
  } else if (output.reason === 'WINNER' && canonicalWinnerId !== productiveWinnerId) {
    comparison = 'DIFFERENT_WINNER';
  } else if (output.reason === 'AMBIGUOUS') {
    comparison = 'CANONICAL_AMBIGUOUS';
  } else {
    comparison = 'SAME_WINNER';
  }

  return {
    comparison,
    productiveWinnerId,
    canonicalWinnerId,
    canonicalAmbiguous: output.ambiguous,
    canonicalReason: output.reason,
  };
}

// Shadow runner (catches own errors)

const DIVERGENCE_LOG_CODES = new Set<ShadowComparison>([
  'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH',
  'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH',
  'DIFFERENT_WINNER',
  'CANONICAL_AMBIGUOUS',
]);

export function runShadowComparison(
  tx: RulePrecedenceTransaction,
  rules: RulePrecedenceRule[],
  productiveWinnerId: string | null,
  context: { companyId: string; transactionId: string },
): ShadowExecutionResult {
  try {
    const result = compareRuleDecisions(tx, rules, productiveWinnerId);
    if (DIVERGENCE_LOG_CODES.has(result.comparison)) {
      logger.warn('[RULE SHADOW DIVERGENCE]', {
        companyId: context.companyId,
        transactionId: context.transactionId,
        productiveWinnerId: result.productiveWinnerId,
        canonicalWinnerId: result.canonicalWinnerId,
        comparison: result.comparison,
      });
    }
    return { ok: true, comparison: result };
  } catch (error) {
    logger.error('[RULE SHADOW ERROR]', {
      error: String(error),
      companyId: context.companyId,
      transactionId: context.transactionId,
    });
    return { ok: false };
  }
}

// ─── S7-04C: Divergence classification — pure function ─────

export function classifyDivergenceReason(evidence: ComparisonEvidence): DivergenceClassification {
  if (evidence.canonicalReason === 'NO_MATCH' && evidence.productiveWinnerId !== null) {
    return { comparison: 'DIFFERENT', reason: 'NO_MATCH' };
  }
  if (evidence.canonicalReason === 'AMBIGUOUS') {
    return { comparison: 'DIFFERENT', reason: 'AMBIGUOUS' };
  }
  if (evidence.productiveWinnerId === null && evidence.canonicalWinnerId !== null) {
    return { comparison: 'DIFFERENT', reason: 'OTHER' };
  }
  if (evidence.productiveWinnerId === evidence.canonicalWinnerId) {
    return { comparison: 'SAME', reason: null };
  }
  return { comparison: 'DIFFERENT', reason: 'UNDETERMINED' };
}

// ─── S7-04C: Apply All accumulation ────────────────────────

export function createEmptyApplyAllShadowSummary(): ShadowExecutionSummary {
  return {
    totalEvaluated: 0,
    sameWinner: 0,
    bothNoMatch: 0,
    productiveMatchCanonicalNoMatch: 0,
    productiveNoMatchCanonicalMatch: 0,
    differentWinner: 0,
    canonicalAmbiguous: 0,
    shadowErrors: 0,
    divergenceReasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
  };
}

export function accumulateApplyAllShadowSummary(
  summary: ShadowExecutionSummary,
  result: ShadowExecutionResult,
  classification?: DivergenceClassification,
): ShadowExecutionSummary {
  const next = { ...summary, totalEvaluated: summary.totalEvaluated + 1 };

  if (!result.ok) {
    next.shadowErrors = next.shadowErrors + 1;
    return next;
  }

  switch (result.comparison.comparison) {
    case 'SAME_WINNER':
      next.sameWinner = next.sameWinner + 1;
      break;
    case 'BOTH_NO_MATCH':
      next.bothNoMatch = next.bothNoMatch + 1;
      break;
    case 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH':
      next.productiveMatchCanonicalNoMatch = next.productiveMatchCanonicalNoMatch + 1;
      break;
    case 'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH':
      next.productiveNoMatchCanonicalMatch = next.productiveNoMatchCanonicalMatch + 1;
      break;
    case 'DIFFERENT_WINNER':
      next.differentWinner = next.differentWinner + 1;
      break;
    case 'CANONICAL_AMBIGUOUS':
      next.canonicalAmbiguous = next.canonicalAmbiguous + 1;
      break;
  }

  if (classification?.reason) {
    next.divergenceReasons[classification.reason] = next.divergenceReasons[classification.reason] + 1;
  }

  return next;
}

export function toPersistencePayload(summary: ShadowExecutionSummary): ShadowPersistencePayload {
  return {
    totalEvaluated: summary.totalEvaluated,
    sameWinner: summary.sameWinner,
    differentWinner: summary.differentWinner,
    shadowErrors: summary.shadowErrors,
    divergenceReasons: { ...summary.divergenceReasons },
  };
}

// Accumulator — pure function

export function accumulateShadowSummary(
  summary: ShadowImportSummary,
  result: ShadowExecutionResult,
): ShadowImportSummary {
  const next = { ...summary, totalEvaluated: summary.totalEvaluated + 1 };

  if (!result.ok) {
    next.shadowErrors = next.shadowErrors + 1;
    return next;
  }

  switch (result.comparison.comparison) {
    case 'SAME_WINNER':
      next.sameWinner = next.sameWinner + 1;
      break;
    case 'BOTH_NO_MATCH':
      next.bothNoMatch = next.bothNoMatch + 1;
      break;
    case 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH':
      next.productiveMatchCanonicalNoMatch = next.productiveMatchCanonicalNoMatch + 1;
      break;
    case 'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH':
      next.productiveNoMatchCanonicalMatch = next.productiveNoMatchCanonicalMatch + 1;
      break;
    case 'DIFFERENT_WINNER':
      next.differentWinner = next.differentWinner + 1;
      break;
    case 'CANONICAL_AMBIGUOUS':
      next.canonicalAmbiguous = next.canonicalAmbiguous + 1;
      break;
  }

  return next;
}

// Best-effort persistence

export type PersistShadowParams =
  | {
      companyId: string;
      userId?: string;
      statementId: string;
      summary: ShadowImportSummary;
    }
  | {
      companyId: string;
      userId?: string;
      entity: 'ApplyAllBatch';
      entityId: string;
      summary: ShadowPersistencePayload;
    };

export async function persistShadowSummaryBestEffort(params: PersistShadowParams): Promise<void> {
  try {
    const entity = 'statementId' in params ? 'BankStatement' as const : params.entity;
    const entityId = 'statementId' in params ? params.statementId : params.entityId;
    await createAuditLogWithRetry({
      companyId: params.companyId,
      userId: params.userId,
      action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
      entity,
      entityId,
      details: JSON.stringify(params.summary),
    });
  } catch (error) {
    const entityId = 'statementId' in params ? params.statementId : params.entityId;
    logger.error('[SHADOW SUMMARY PERSIST FAILED]', {
      error: String(error),
      companyId: params.companyId,
      entityId,
    });
  }
}

