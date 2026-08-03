import type { SpecificityScore } from './types';

export interface CanonicalCandidate {
  ruleId: string;
  specificityScore: SpecificityScore;
  matchQuality: number;
  priority: number;
  action?: {
    category?: string;
    entityId?: string;
    glAccountId?: string;
  };
}

export const AMBIGUITY_DELTA_THRESHOLD = 0.10;

function compareOrdinal(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function canonicalComparator(a: CanonicalCandidate, b: CanonicalCandidate): number {
  if (b.specificityScore.highestTier !== a.specificityScore.highestTier) {
    return b.specificityScore.highestTier - a.specificityScore.highestTier;
  }
  if (b.specificityScore.weightWithinTier !== a.specificityScore.weightWithinTier) {
    return b.specificityScore.weightWithinTier - a.specificityScore.weightWithinTier;
  }
  if (b.matchQuality !== a.matchQuality) return b.matchQuality - a.matchQuality;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return compareOrdinal(a.ruleId, b.ruleId);
}

export function rankCanonical<T extends CanonicalCandidate>(candidates: T[]): T[] {
  return [...candidates].sort(canonicalComparator);
}

export type CanonicalReason =
  | 'no_candidates'
  | 'single_candidate'
  | 'higher_specificity_tier'
  | 'higher_specificity_weight'
  | 'higher_priority'
  | 'delta_above_threshold'
  | 'delta_below_threshold';

export interface CanonicalDecision {
  winner?: CanonicalCandidate;
  ambiguous: boolean;
  reason: CanonicalReason;
  delta?: number;
}

export function classifyCanonical<T extends CanonicalCandidate>(
  ranked: T[],
): { winner?: T; ambiguous: boolean; reason: CanonicalReason; delta?: number } {
  if (ranked.length === 0) {
    return { winner: undefined, ambiguous: false, reason: 'no_candidates' };
  }
  if (ranked.length === 1) {
    return { winner: ranked[0], ambiguous: false, reason: 'single_candidate' };
  }

  const top = ranked[0];
  const second = ranked[1];

  if (top.specificityScore.highestTier !== second.specificityScore.highestTier) {
    return { winner: top, ambiguous: false, reason: 'higher_specificity_tier' };
  }
  if (top.specificityScore.weightWithinTier !== second.specificityScore.weightWithinTier) {
    return { winner: top, ambiguous: false, reason: 'higher_specificity_weight' };
  }
  if (top.priority !== second.priority) {
    return { winner: top, ambiguous: false, reason: 'higher_priority' };
  }

  const delta = top.matchQuality - second.matchQuality;
  if (delta + Number.EPSILON >= AMBIGUITY_DELTA_THRESHOLD) {
    return { winner: top, ambiguous: false, reason: 'delta_above_threshold', delta };
  }
  return { winner: undefined, ambiguous: true, reason: 'delta_below_threshold', delta };
}
