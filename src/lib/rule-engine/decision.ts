import type { ScoredCandidate, Candidate, EngineDecision } from './types';

export const AMBIGUITY_DELTA_THRESHOLD = 0.10;

export function classify(scored: ScoredCandidate[]): {
  winner?: ScoredCandidate;
  isAmbiguous: boolean;
  explanation: string;
} {
  if (scored.length === 0) {
    return { winner: undefined, isAmbiguous: false, explanation: 'No matching rules found' };
  }
  if (scored.length === 1) {
    return { winner: scored[0], isAmbiguous: false, explanation: 'Single candidate' };
  }

  const top = scored[0];
  const second = scored[1];

  if (top.specificityScore.highestTier !== second.specificityScore.highestTier) {
    return { winner: top, isAmbiguous: false, explanation: 'Top candidate wins by specificity tier' };
  }
  if (top.specificityScore.weightWithinTier !== second.specificityScore.weightWithinTier) {
    return { winner: top, isAmbiguous: false, explanation: 'Top candidate wins by specificity weight' };
  }

  const delta = top.matchQuality - second.matchQuality;
  if (delta + Number.EPSILON >= AMBIGUITY_DELTA_THRESHOLD) {
    return { winner: top, isAmbiguous: false, explanation: `DELTA ${delta} exceeds threshold 0.10` };
  }
  return {
    winner: undefined,
    isAmbiguous: true,
    explanation: `DELTA ${delta} below threshold 0.10 — ambiguous`,
  };
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
): EngineDecision {
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

  return {
    type: 'rule',
    result: decisionResult,
    ruleId: result.winner?.ruleId,
    candidateList: candidates,
    classification: resolvedClassification,
    explanation: result.explanation,
  };
}
