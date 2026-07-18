import { evaluateCondition } from '@/lib/rule-engine/conditions';
import { normalizeInputsForCompatibility, normalizeRuleForPrecedence } from './rule-precedence-compat';
import type { RuleCondition, EvaluatedCondition, Transaction } from '@/lib/rule-engine/types';

// ─── Types ───────────────────────────────────────────────────────────────

export interface RulePrecedenceTransaction {
  id?: string;
  date: Date;
  description: string;
  amount: number;
  bankAccountId?: string;
  companyId?: string;
}

export interface RulePrecedenceRule {
  id: string;
  conditions?: unknown;
  conditionType?: string | null;
  conditionValue?: string | null;
  transactionDirection?: string | null;
  priority: number;
  glAccountId?: string | null;
  debitGlAccountId?: string | null;
  creditGlAccountId?: string | null;
  isActive: boolean;
}

export interface RankedCandidate {
  ruleId: string;
  priority: number;
  specificityScore: number;
  matchQuality: number;
}

export interface RuleMatchOutput {
  winner?: RankedCandidate;
  candidates: RankedCandidate[];
  ambiguous: boolean;
  reason: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
}

// ─── Helpers ─────────────────────────────────────────────────────────────
// ─── Helpers (normalization imported from compat) ─────────────────────────

// ─── Single condition evaluation via V2 SSOT ──────────────────────────────

function evaluateSingleCondition(
  cond: RuleCondition,
  tx: Transaction,
): EvaluatedCondition {
  const { cond: finalCond, tx: compatTx } = normalizeInputsForCompatibility(cond, tx);

  try {
    return evaluateCondition(finalCond, compatTx);
  } catch {
    return { type: cond.type, score: 0, match: false, detail: 'Unsupported type' };
  }
}

// ─── Specificity scoring ─────────────────────────────────────────────────

const CONDITION_SPECIFICITY: Record<string, number> = {
  description_eq: 100,
  amount_eq: 100,
  amount_range: 80,
  description_starts_with: 60,
  description_ends_with: 60,
  description_contains: 40,
  amount_gt: 40,
  amount_gte: 40,
  amount_lt: 40,
  amount_lte: 40,
  description_matches: 40,
};

function directionSpecificity(direction: string | null): number {
  return (direction === 'debit' || direction === 'credit') ? 20 : 0;
}

function computeSpecificityScore(conditions: RuleCondition[], direction: string | null): number {
  let score = 0;
  for (const c of conditions) {
    score += CONDITION_SPECIFICITY[c.type] ?? 10;
  }
  score += directionSpecificity(direction);
  return score;
}

// ─── Match quality ───────────────────────────────────────────────────────

function computeMatchQuality(evaluated: EvaluatedCondition[]): number {
  if (evaluated.length === 0) return 0;
  const scores = evaluated.map((e) => e.score);
  const min = Math.min(...scores);
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
  return min + 0.25 * (avg - min);
}

// ─── Main entry point ────────────────────────────────────────────────────

export function evaluateTransactionAgainstRules(
  tx: RulePrecedenceTransaction,
  rules: RulePrecedenceRule[],
): RuleMatchOutput {
  const candidates: RankedCandidate[] = [];

  const fullTx: Transaction = {
    id: tx.id ?? 'dummy-id',
    date: tx.date,
    description: tx.description,
    amount: tx.amount,
    bankAccountId: tx.bankAccountId ?? 'dummy-bank',
    companyId: tx.companyId ?? 'dummy-company',
  };

  for (const rule of rules) {
    if (!rule.isActive) continue;

    const direction = rule.transactionDirection ?? null;

    // Pre-filter by direction
    if (direction === 'debit' && tx.amount >= 0) continue;
    if (direction === 'credit' && tx.amount < 0) continue;

    const normalized = normalizeRuleForPrecedence(rule);
    if (normalized.length === 0) continue;

    // Evaluate all conditions using V2 evaluators
    const evaluated = normalized.map((c) => evaluateSingleCondition(c, fullTx));

    // Discard if any condition doesn't match
    if (!evaluated.every((e) => e.match)) continue;

    const specificityScore = computeSpecificityScore(normalized, direction);
    const matchQuality = computeMatchQuality(evaluated);

    candidates.push({
      ruleId: rule.id,
      priority: rule.priority,
      specificityScore,
      matchQuality,
    });
  }

  if (candidates.length === 0) {
    return { winner: undefined, candidates: [], ambiguous: false, reason: 'NO_MATCH' };
  }

  // Rank
  candidates.sort((a, b) => {
    if (b.specificityScore !== a.specificityScore) return b.specificityScore - a.specificityScore;
    if (b.matchQuality !== a.matchQuality) return b.matchQuality - a.matchQuality;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.ruleId.localeCompare(b.ruleId);
  });

  // Ambiguity: same specificityScore AND close matchQuality AND same priority
  if (candidates.length >= 2) {
    const top = candidates[0];
    const second = candidates[1];
    if (
      top.specificityScore === second.specificityScore &&
      Math.abs(top.matchQuality - second.matchQuality) < 0.10 &&
      top.priority === second.priority
    ) {
      return {
        winner: undefined,
        candidates,
        ambiguous: true,
        reason: 'AMBIGUOUS',
      };
    }
  }

  return {
    winner: candidates[0],
    candidates,
    ambiguous: false,
    reason: 'WINNER',
  };
}
