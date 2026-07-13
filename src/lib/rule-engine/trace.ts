import type { TraceEvent, DecisionTrace } from './types';
import { RULE_ENGINE_VERSION, MAX_TRACE_EVENTS } from './version';

export function buildDecisionTrace(
  nonTerminalEvents: TraceEvent[],
  terminalEvent: TraceEvent,
  maxEvents: number = MAX_TRACE_EVENTS,
): DecisionTrace {
  if (maxEvents < 1) throw new RangeError('maxEvents must be >= 1');

  const totalEvents = nonTerminalEvents.length + 1;
  let emitted: TraceEvent[];
  let truncated: boolean;

  if (totalEvents <= maxEvents) {
    emitted = [...nonTerminalEvents, terminalEvent];
    truncated = false;
  } else {
    const head = nonTerminalEvents.slice(0, maxEvents - 1);
    emitted = [...head, terminalEvent];
    truncated = true;
  }

  return {
    engineVersion: RULE_ENGINE_VERSION,
    events: emitted,
    truncated,
    totalEvents,
    emittedEvents: emitted.length,
  };
}

export function deepCopyTraceEvent(e: TraceEvent): TraceEvent {
  if (e.stage === 'ranking' && e.event === 'final_order') {
    return { ...e, rankedRuleIds: [...e.rankedRuleIds] };
  }
  return { ...e } as TraceEvent;
}

export function cloneDecisionTrace(trace: DecisionTrace): DecisionTrace {
  return {
    ...trace,
    events: trace.events.map((e) => deepCopyTraceEvent(e)),
  };
}

export function attachTraceToError(err: unknown, events: TraceEvent[]): void {
  if (typeof err === 'object' && err !== null && Object.isExtensible(err)) {
    Object.defineProperty(err, '__ruleEngineEvents', {
      value: events,
      enumerable: false,
      configurable: true,
    });
  }
}
