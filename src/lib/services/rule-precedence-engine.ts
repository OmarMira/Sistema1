import { evaluateCondition } from '@/lib/rule-engine/conditions';
import { normalizeInputsForCompatibility, normalizeRuleForPrecedence } from './rule-precedence-compat';
import type { RuleCondition, EvaluatedCondition, Transaction } from '@/lib/rule-engine/types';
import { computeSpecificity } from '@/lib/rule-engine/specificity';
import { computeMatchQuality } from '@/lib/rule-engine/scoring';
import {
  rankCanonical,
  classifyCanonical,
} from '@/lib/rule-engine/canonical-ranking';

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
  /** Canonical specificity weight within the matched tier (numeric projection of the canonical tier-first model). */
  specificityScore: number;
  matchQuality: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  evaluatedConditions: { type: string; detail: string }[];
}

export interface RuleMatchOutput {
  winner?: RankedCandidate;
  candidates: RankedCandidate[];
  ambiguous: boolean;
  reason: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
}

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

// ─── Match quality (shared with V2) ──────────────────────────────────────

const MATCH_CONFIDENCE_HIGH = 0.8;
const MATCH_CONFIDENCE_MEDIUM = 0.5;

export function toMatchConfidenceLabel(matchQuality: number): 'high' | 'medium' | 'low' {
  if (matchQuality >= MATCH_CONFIDENCE_HIGH) return 'high';
  if (matchQuality >= MATCH_CONFIDENCE_MEDIUM) return 'medium';
  return 'low';
}
// NOTE: These thresholds (0.8/0.5) are specific to matchQuality semantics.
// Although they numerically match toConfidenceLabel() in decision-engine.ts,
// they measure a different magnitude: condition-match precision, not
// holistic classification confidence. They may evolve independently.

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

  const canonicalSpecificity = new Map<string, ReturnType<typeof computeSpecificity>>();

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

    const specificity = computeSpecificity(evaluated);
    const matchQuality = computeMatchQuality(evaluated.map((e) => e.score));

    candidates.push({
      ruleId: rule.id,
      priority: rule.priority,
      specificityScore: specificity.weightWithinTier,
      matchQuality,
      confidenceLabel: toMatchConfidenceLabel(matchQuality),
      evaluatedConditions: evaluated
        .filter((e) => e.match)
        .map((e) => ({ type: e.type, detail: e.detail })),
    });
    canonicalSpecificity.set(rule.id, specificity);
  }

  if (candidates.length === 0) {
    return { winner: undefined, candidates: [], ambiguous: false, reason: 'NO_MATCH' };
  }

  // Rank and classify through the shared canonical comparator (BRE-012)
  const ranked = rankCanonical(candidates.map((c) => ({
    ruleId: c.ruleId,
    specificityScore: canonicalSpecificity.get(c.ruleId)!,
    matchQuality: c.matchQuality,
    priority: c.priority,
  })));
  const decision = classifyCanonical(ranked);

  const byRuleId = new Map(candidates.map((c) => [c.ruleId, c]));
  const rankedCandidates = ranked.map((c) => byRuleId.get(c.ruleId)!);

  if (decision.ambiguous) {
    return {
      winner: undefined,
      candidates: rankedCandidates,
      ambiguous: true,
      reason: 'AMBIGUOUS',
    };
  }

  const winner = rankedCandidates[0];

  return {
    winner,
    candidates: rankedCandidates,
    ambiguous: false,
    reason: 'WINNER',
  };
}
