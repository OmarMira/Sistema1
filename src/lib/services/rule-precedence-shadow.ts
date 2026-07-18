import type { Prisma } from '@prisma/client';
import { evaluateTransactionAgainstRules, type RulePrecedenceRule, type RulePrecedenceTransaction } from './rule-precedence-engine';
import { logger } from '@/lib/logger';

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
): void {
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
  } catch (error) {
    logger.error('[RULE SHADOW ERROR]', {
      error: String(error),
      companyId: context.companyId,
      transactionId: context.transactionId,
    });
  }
}

