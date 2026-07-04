import type { Signal, DecisionResult } from '@/lib/types/reasoning';
import { toConfidenceLabel } from '@/lib/types/reasoning';
import { serverT } from '@/lib/server-i18n';
import { generateUncertaintyReasons as buildUncertaintyReasons } from './reasoning-service';

export function decide(signals: Signal[], locale?: string): DecisionResult {
  if (signals.length === 0) {
    const noContext = serverT(locale, 'reasoning.uncertaintyNoContext');
    const noHeuristic = serverT(locale, 'reasoning.uncertaintyNoHeuristic');
    const noAI = serverT(locale, 'reasoning.uncertaintyNoAI');
    const allReasons = [noContext, noHeuristic, noAI];
    return {
      selected: null,
      allSignals: [],
      confidence: 0,
      confidenceLabel: 'low',
      explanation: serverT(locale, 'reasoning.sinClasificar').replace('{reasons}', allReasons.join(', ')),
      uncertaintyReasons: allReasons,
      source: 'unknown',
    };
  }

  const entitySignal = signals.find((s) => s.source === 'entity_context');
  const heuristicSignal = signals.find((s) => s.source === 'heuristic');
  const aiSignal = signals.find((s) => s.source === 'ai');

  // Rule 1: Any signal with confidence >= 0.9 → use highest
  const highConfSignals = signals.filter((s) => s.confidence >= 0.9);
  if (highConfSignals.length > 0) {
    const best = highConfSignals.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
    return {
      selected: best,
      allSignals: signals,
      confidence: best.confidence,
      confidenceLabel: 'high',
      explanation: best.reasoning,
      uncertaintyReasons: buildUncertaintyReasons(signals, locale),
      source: best.source,
    };
  }

  // Rule 2: Heuristic >= 0.7 and specific match → use heuristic
  if (heuristicSignal && heuristicSignal.confidence >= 0.7 && heuristicSignal.role) {
    return {
      selected: heuristicSignal,
      allSignals: signals,
      confidence: heuristicSignal.confidence,
      confidenceLabel: toConfidenceLabel(heuristicSignal.confidence),
      explanation: heuristicSignal.reasoning,
      uncertaintyReasons: buildUncertaintyReasons(signals, locale),
      source: 'heuristic',
    };
  }

  // Rule 3: EntityContext >= 0.7 → use EntityContext
  if (entitySignal && entitySignal.confidence >= 0.7) {
    return {
      selected: entitySignal,
      allSignals: signals,
      confidence: entitySignal.confidence,
      confidenceLabel: toConfidenceLabel(entitySignal.confidence),
      explanation: entitySignal.reasoning,
      uncertaintyReasons: buildUncertaintyReasons(signals, locale),
      source: 'entity_context',
    };
  }

  // Rule 4: AI >= 0.7 → use AI
  if (aiSignal && aiSignal.confidence >= 0.7) {
    return {
      selected: aiSignal,
      allSignals: signals,
      confidence: aiSignal.confidence,
      confidenceLabel: toConfidenceLabel(aiSignal.confidence),
      explanation: aiSignal.reasoning,
      uncertaintyReasons: buildUncertaintyReasons(signals, locale),
      source: 'ai',
    };
  }

  // Rule 5: Any signal >= 0.5 → use highest, label medium
  const mediumSignals = signals.filter((s) => s.confidence >= 0.5);
  if (mediumSignals.length > 0) {
    const best = mediumSignals.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
    return {
      selected: best,
      allSignals: signals,
      confidence: best.confidence,
      confidenceLabel: 'medium',
      explanation: best.reasoning,
      uncertaintyReasons: buildUncertaintyReasons(signals, locale),
      source: best.source,
    };
  }

  // Rule 6: All signals < 0.5 → SIN_CLASIFICAR
  const reasons = buildUncertaintyReasons(signals, locale);
  const reasonText = reasons.length > 0 ? reasons.join(', ') : serverT(locale, 'reasoning.allLowConfidence');

  return {
    selected: null,
    allSignals: signals,
    confidence: 0,
    confidenceLabel: 'low',
    explanation: serverT(locale, 'reasoning.sinClasificar').replace('{reasons}', reasonText),
    uncertaintyReasons: reasons,
    source: 'unknown',
  };
}
