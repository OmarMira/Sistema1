import type { ScoredCandidate } from './types';

export function rankCandidates(scored: ScoredCandidate[]): ScoredCandidate[] {
  return [...scored].sort((a, b) => {
    const tierDiff = b.specificityScore.highestTier - a.specificityScore.highestTier;
    if (tierDiff !== 0) return tierDiff;

    const weightDiff = b.specificityScore.weightWithinTier - a.specificityScore.weightWithinTier;
    if (weightDiff !== 0) return weightDiff;

    const qualityDiff = b.matchQuality - a.matchQuality;
    if (qualityDiff !== 0) return qualityDiff;

    const priorityDiff = a.priority - b.priority;
    if (priorityDiff !== 0) return priorityDiff;

    return a.ruleId.localeCompare(b.ruleId);
  });
}
