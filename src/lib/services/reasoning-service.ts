import type { Signal, DecisionResult } from '@/lib/types/reasoning';
import { serverT } from '@/lib/server-i18n';

export function generateExplanation(result: DecisionResult, locale?: string): string {
  if (!result.selected) {
    const reasons = result.uncertaintyReasons.length > 0
      ? result.uncertaintyReasons.join(', ')
      : '';
    const template = serverT(locale, 'reasoning.sinClasificar');
    const confidence = Math.round(result.confidence * 100);
    return template
      .replace('{reasons}', reasons)
      .replace('{confidence}', String(confidence))
      .replace('{role}', '');
  }

  const signal = result.selected;
  const confidence = Math.round(signal.confidence * 100);

  switch (signal.source) {
    case 'entity_context': {
      const template = serverT(locale, 'reasoning.entityContextHigh');
      return template
        .replace('{role}', signal.role ?? '')
        .replace('{confidence}', String(confidence));
    }
    case 'heuristic': {
      const template = serverT(locale, 'reasoning.heuristicMatch');
      const matchedKeyword = (signal as Signal<{ matchedKeyword: string }>).metadata?.matchedKeyword ?? '';
      return template
        .replace('{role}', signal.role ?? '')
        .replace('{matchedKeyword}', matchedKeyword)
        .replace('{confidence}', String(confidence));
    }
    case 'ai': {
      const template = serverT(locale, 'reasoning.aiSuggestion');
      return template
        .replace('{role}', signal.role ?? '')
        .replace('{confidence}', String(confidence));
    }
    default: {
      return signal.reasoning;
    }
  }
}

export function generateUncertaintyReasons(signals: Signal[], locale?: string): string[] {
  const reasons: string[] = [];

  const entitySignal = signals.find((s) => s.source === 'entity_context');
  const heuristicSignal = signals.find((s) => s.source === 'heuristic');
  const aiSignal = signals.find((s) => s.source === 'ai');

  if (!entitySignal || entitySignal.confidence === 0) {
    reasons.push(serverT(locale, 'reasoning.uncertaintyNoContext'));
  }
  if (!heuristicSignal || heuristicSignal.confidence === 0) {
    reasons.push(serverT(locale, 'reasoning.uncertaintyNoHeuristic'));
  }
  if (!aiSignal || aiSignal.confidence === 0) {
    reasons.push(serverT(locale, 'reasoning.uncertaintyNoAI'));
  }

  return reasons;
}
