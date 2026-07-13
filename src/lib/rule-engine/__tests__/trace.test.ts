import { describe, it, expect } from 'vitest';
import { RULE_ENGINE_VERSION, MAX_TRACE_EVENTS } from '../version';
import { buildDecisionTrace, cloneDecisionTrace, deepCopyTraceEvent, attachTraceToError } from '../trace';
import type { TraceEvent, DecisionTrace } from '../types';
import { RuleEngineError, InvalidPipelineStateError } from '../errors';

function makeStageEvents(n: number): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push({ stage: 'pipeline', event: 'candidates_collected', count: i + 1 });
  }
  return events;
}

const completeTerminal: TraceEvent = { stage: 'execution', event: 'complete' };
const errorTerminal: TraceEvent = { stage: 'execution', event: 'error' };

describe('RULE_ENGINE_VERSION', () => {
  it('is 2.1.0', () => {
    expect(RULE_ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('MAX_TRACE_EVENTS', () => {
  it('is 500', () => {
    expect(MAX_TRACE_EVENTS).toBe(500);
  });
});

describe('buildDecisionTrace', () => {
  it('normal flow — no truncation', () => {
    const events = makeStageEvents(3);
    const result = buildDecisionTrace(events, completeTerminal);

    expect(result.engineVersion).toBe(RULE_ENGINE_VERSION);
    expect(result.events).toHaveLength(4);
    expect(result.events[0]).toEqual(events[0]);
    expect(result.events[1]).toEqual(events[1]);
    expect(result.events[2]).toEqual(events[2]);
    expect(result.events[3]).toEqual(completeTerminal);
    expect(result.truncated).toBe(false);
    expect(result.totalEvents).toBe(4);
    expect(result.emittedEvents).toBe(4);
  });

  it('truncation — head kept, last slot is terminal', () => {
    const events = makeStageEvents(10);
    const result = buildDecisionTrace(events, completeTerminal, 5);

    expect(result.truncated).toBe(true);
    expect(result.events).toHaveLength(5);
    expect(result.totalEvents).toBe(11);
    expect(result.emittedEvents).toBe(5);
    expect(result.events[0]).toEqual(events[0]);
    expect(result.events[1]).toEqual(events[1]);
    expect(result.events[2]).toEqual(events[2]);
    expect(result.events[3]).toEqual(events[3]);
    expect(result.events[4]).toEqual(completeTerminal);
  });

  it('truncation — MAX=1 only terminal event', () => {
    const events = makeStageEvents(10);
    const result = buildDecisionTrace(events, completeTerminal, 1);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual(completeTerminal);
    expect(result.truncated).toBe(true);
    expect(result.totalEvents).toBe(11);
    expect(result.emittedEvents).toBe(1);
  });

  it('truncation — exactly at limit emits all events', () => {
    const events = makeStageEvents(4);
    const result = buildDecisionTrace(events, completeTerminal, 5);

    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(5);
    expect(result.totalEvents).toBe(5);
    expect(result.emittedEvents).toBe(5);
  });

  it('throws RangeError when maxEvents < 1', () => {
    expect(() => buildDecisionTrace([], completeTerminal, 0)).toThrow(RangeError);
    expect(() => buildDecisionTrace([], completeTerminal, -1)).toThrow(RangeError);
  });

  it('empty nonTerminalEvents emits only terminal', () => {
    const result = buildDecisionTrace([], completeTerminal);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual(completeTerminal);
    expect(result.truncated).toBe(false);
    expect(result.totalEvents).toBe(1);
  });
});

describe('cloneDecisionTrace', () => {
  it('returns a deep copy — events array is not shared', () => {
    const events = makeStageEvents(2);
    const original: DecisionTrace = {
      engineVersion: RULE_ENGINE_VERSION,
      events: [...events, completeTerminal],
      truncated: false,
      totalEvents: 3,
      emittedEvents: 3,
    };

    const clone = cloneDecisionTrace(original);

    expect(clone).toEqual(original);
    expect(clone.events).not.toBe(original.events);
  });

  it('rankedRuleIds array is deeply copied', () => {
    const rankedEvent: TraceEvent = { stage: 'ranking', event: 'final_order', rankedRuleIds: ['a', 'b', 'c'] };
    const original: DecisionTrace = {
      engineVersion: RULE_ENGINE_VERSION,
      events: [rankedEvent, completeTerminal],
      truncated: false,
      totalEvents: 2,
      emittedEvents: 2,
    };

    const clone = cloneDecisionTrace(original);

    expect(clone.events).toHaveLength(2);
    if (clone.events[0].stage === 'ranking' && clone.events[0].event === 'final_order') {
      expect(clone.events[0].rankedRuleIds).not.toBe(
        (original.events[0] as Extract<TraceEvent, { stage: 'ranking'; event: 'final_order' }>).rankedRuleIds,
      );
    }
  });
});

describe('deepCopyTraceEvent', () => {
  it('deep copies rankedRuleIds for final_order event', () => {
    const event: TraceEvent = { stage: 'ranking', event: 'final_order', rankedRuleIds: ['x', 'y'] };
    const copy = deepCopyTraceEvent(event) as Extract<TraceEvent, { stage: 'ranking'; event: 'final_order' }>;
    expect(copy.rankedRuleIds).toEqual(['x', 'y']);
    expect(copy.rankedRuleIds).not.toBe(
      (event as Extract<TraceEvent, { stage: 'ranking'; event: 'final_order' }>).rankedRuleIds,
    );
  });

  it('shallow copies primitive-only events', () => {
    const event: TraceEvent = { stage: 'pipeline', event: 'candidates_collected', count: 5 };
    const copy = deepCopyTraceEvent(event);
    expect(copy).toEqual(event);
  });
});

describe('attachTraceToError', () => {
  it('attaches events to RuleEngineError', () => {
    const err = new InvalidPipelineStateError('test', 'ERR');
    const events = makeStageEvents(2);
    attachTraceToError(err, events);
    expect((err as any).__ruleEngineEvents).toBe(events);
  });

  it('attaches events to plain Error', () => {
    const err = new Error('test');
    const events = makeStageEvents(1);
    attachTraceToError(err, events);
    expect((err as any).__ruleEngineEvents).toBe(events);
  });

  it('attaches events to plain object', () => {
    const err: Record<string, unknown> = {};
    const events = makeStageEvents(1);
    attachTraceToError(err, events);
    expect(err.__ruleEngineEvents).toBe(events);
  });

  it('does nothing on null', () => {
    expect(() => attachTraceToError(null, [])).not.toThrow();
  });

  it('does nothing on primitive', () => {
    expect(() => attachTraceToError('string', [])).not.toThrow();
  });

  it('does nothing on non-extensible object', () => {
    const err = Object.preventExtensions({});
    const events = makeStageEvents(1);
    expect(() => attachTraceToError(err, events)).not.toThrow();
    expect((err as any).__ruleEngineEvents).toBeUndefined();
  });

  it('does nothing on frozen object', () => {
    const err = Object.freeze({});
    const events = makeStageEvents(1);
    expect(() => attachTraceToError(err, events)).not.toThrow();
  });

  it('property is non-enumerable', () => {
    const err = new Error('test');
    const events = makeStageEvents(1);
    attachTraceToError(err, events);
    expect(Object.keys(err)).not.toContain('__ruleEngineEvents');
  });
});
