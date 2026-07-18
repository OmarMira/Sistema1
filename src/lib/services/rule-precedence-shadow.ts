import type { Prisma } from '@prisma/client';
import { evaluateTransactionAgainstRules, type RulePrecedenceRule, type RulePrecedenceTransaction } from './rule-precedence-engine';
import { logger } from '@/lib/logger';
import { createAuditLogWithRetry } from '@/lib/audit';

// Types

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

// Shadow metrics

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

export async function persistShadowSummaryBestEffort(params: {
  companyId: string;
  userId?: string;
  statementId: string;
  summary: ShadowImportSummary;
}): Promise<void> {
  try {
    await createAuditLogWithRetry({
      companyId: params.companyId,
      userId: params.userId,
      action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
      entity: 'BankStatement',
      entityId: params.statementId,
      details: JSON.stringify(params.summary),
    });
  } catch (error) {
    logger.error('[SHADOW SUMMARY PERSIST FAILED]', {
      error: String(error),
      companyId: params.companyId,
      statementId: params.statementId,
    });
  }
}

