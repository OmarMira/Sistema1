import type { ScoredCandidate, TraceEvent } from './types';
import { attachTraceToError } from './trace';
import { rankCanonical } from './canonical-ranking';

export function rankCandidates(scored: ScoredCandidate[]): [ScoredCandidate[], TraceEvent[]] {
  const events: TraceEvent[] = [];
  try {
    const ranked = rankCanonical(scored);

    events.push({
      stage: 'ranking',
      event: 'final_order',
      rankedRuleIds: ranked.map((c) => c.ruleId),
    });

    return [ranked, events];
  } catch (err) {
    attachTraceToError(err, events);
    throw err;
  }
}
