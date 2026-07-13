import type { PipelineArtifacts, ScoredCandidate, TraceEvent } from './types';
import { InvalidPipelineStateError } from './errors';
import { computeSpecificity } from './specificity';
import { attachTraceToError } from './trace';

export const MATCH_QUALITY_ALPHA = 0.25;

export function computeMatchQuality(scores: number[]): number {
  if (scores.length === 0) return 0;
  const min = Math.min(...scores);
  const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return min + MATCH_QUALITY_ALPHA * (avg - min);
}

export function scoreCandidates(artifacts: PipelineArtifacts): [ScoredCandidate[], TraceEvent[]] {
  const events: TraceEvent[] = [];
  try {
    const { rawCandidates, evaluations } = artifacts;
    const scored = rawCandidates.map((raw) => {
      const evals = evaluations.get(raw.ruleId);
      if (!evals) {
        throw new InvalidPipelineStateError(
          `No evaluation found for ruleId ${raw.ruleId}`,
          'ERR_INVALID_PIPELINE_STATE',
        );
      }
      const specificityScore = computeSpecificity(evals);
      const matchQuality = computeMatchQuality(raw.conditionScores);
      events.push({
        stage: 'scoring',
        event: 'candidate_scored',
        ruleId: raw.ruleId,
        highestTier: specificityScore.highestTier,
        weightWithinTier: specificityScore.weightWithinTier,
        matchQuality,
      });
      return {
        ruleId: raw.ruleId,
        specificityScore,
        matchQuality,
        priority: raw.priority,
        conditionScores: raw.conditionScores,
        action: { ...raw.action },
      };
    });
    return [scored, events];
  } catch (err) {
    attachTraceToError(err, events);
    throw err;
  }
}
