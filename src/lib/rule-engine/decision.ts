import type { ScoredCandidate, Candidate, EngineDecision, DecisionReason, TraceEvent } from './types';
import { attachTraceToError } from './trace';
import { classifyCanonical, AMBIGUITY_DELTA_THRESHOLD } from './canonical-ranking';
import type { CanonicalReason } from './canonical-ranking';

export { AMBIGUITY_DELTA_THRESHOLD };

const REASON_MAP: Record<CanonicalReason, DecisionReason> = {
  no_candidates: 'no_candidates',
  single_candidate: 'single_candidate',
  higher_specificity_tier: 'higher_specificity_tier',
  higher_specificity_weight: 'higher_specificity_weight',
  higher_priority: 'higher_priority',
  delta_above_threshold: 'delta_above_threshold',
  delta_below_threshold: 'delta_below_threshold',
};

export function classify(scored: ScoredCandidate[]): {
  winner?: ScoredCandidate;
  isAmbiguous: boolean;
  explanation: string;
  reason: DecisionReason;
  delta?: number;
} {
  const decision = classifyCanonical(scored);
  const explanation = explain(decision.reason, decision.delta);
  return {
    winner: decision.winner as ScoredCandidate | undefined,
    isAmbiguous: decision.ambiguous,
    explanation,
    reason: REASON_MAP[decision.reason],
    ...(decision.delta !== undefined ? { delta: decision.delta } : {}),
  };
}

function explain(reason: CanonicalReason, delta?: number): string {
  switch (reason) {
    case 'no_candidates':
      return 'No matching rules found';
    case 'single_candidate':
      return 'Single candidate';
    case 'higher_specificity_tier':
      return 'Top candidate wins by specificity tier';
    case 'higher_specificity_weight':
      return 'Top candidate wins by specificity weight';
    case 'higher_priority':
      return 'Top candidate wins by manual priority';
    case 'delta_above_threshold':
      return `DELTA ${delta} exceeds threshold 0.10`;
    case 'delta_below_threshold':
      return `DELTA ${delta} below threshold 0.10 — ambiguous`;
  }
}

function extractClassification(scored: ScoredCandidate[]): {
  entityId?: string;
  category?: string;
  glAccountId?: string;
} | undefined {
  if (scored.length === 0) return undefined;
  const top = scored[0];
  const hasAction = top.action.category !== undefined || top.action.entityId !== undefined || top.action.glAccountId !== undefined;
  if (!hasAction) return undefined;
  return {
    ...(top.action.entityId !== undefined && { entityId: top.action.entityId }),
    ...(top.action.category !== undefined && { category: top.action.category }),
    ...(top.action.glAccountId !== undefined && { glAccountId: top.action.glAccountId }),
  };
}

export function makeDecision(
  scored: ScoredCandidate[],
  classification?: { entityId?: string; category?: string; glAccountId?: string },
): [EngineDecision, TraceEvent[]] {
  const events: TraceEvent[] = [];
  try {
    const result = classify(scored);

    const candidates: Candidate[] = scored.map((s) => ({
      ruleId: s.ruleId,
      specificity: s.specificityScore.weightWithinTier,
      matchQuality: s.matchQuality,
      confidence: 0,
      conditionScores: s.conditionScores,
      priority: s.priority,
    }));

    const decisionResult = result.isAmbiguous ? 'ambiguous' as const : result.winner ? 'winner' as const : 'no_match' as const;

    const resolvedClassification = classification !== undefined
      ? classification
      : (decisionResult === 'winner' ? extractClassification(scored) : undefined);

    const decision: EngineDecision = {
      type: 'rule',
      result: decisionResult,
      ruleId: result.winner?.ruleId,
      candidateList: candidates,
      classification: resolvedClassification,
      explanation: result.explanation,
    };

    const outcome: TraceEvent = {
      stage: 'decision',
      event: 'outcome',
      result: decisionResult,
      reason: result.reason,
      threshold: AMBIGUITY_DELTA_THRESHOLD,
      ...(result.winner?.ruleId !== undefined ? { winnerRuleId: result.winner.ruleId } : {}),
      ...(result.delta !== undefined ? { delta: result.delta } : {}),
    };
    events.push(outcome);

    return [decision, events];
  } catch (err) {
    attachTraceToError(err, events);
    throw err;
  }
}
