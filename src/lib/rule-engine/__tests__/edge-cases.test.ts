import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateRules } from '../index';
import { makeRule, makeTransaction, makeCondition } from './fixtures';
import type { TraceEvent, DecisionTrace, AuditRecord } from '../types';
import { RULE_ENGINE_VERSION } from '../version';

beforeEach(() => {
  vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
});

describe('Typed error trace', () => {
  it('partial DecisionTrace attached to typed error with errorCode', () => {
    const rule = makeRule({ conditions: [makeCondition('description_matches', '[invalid')] });
    const tx = makeTransaction();
    try {
      evaluateRules({
        transaction: tx,
        context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.trace).toBeDefined();
      expect(err.trace.events.length).toBeGreaterThan(0);
      const lastEvent = err.trace.events[err.trace.events.length - 1];
      expect(lastEvent.stage).toBe('execution');
      expect(lastEvent.event).toBe('error');
      expect(lastEvent.errorCode).toBe('ERR_INVALID_REGEX');
    }
  });
});

describe('Sensitivity scan', () => {
  it('no TraceEvent variant contains value, payload, or metadata keys', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });

    function scan(obj: unknown, path: string): string[] {
      const violations: string[] = [];
      if (obj !== null && typeof obj === 'object') {
        for (const key of Object.keys(obj as Record<string, unknown>)) {
          if (key === 'value' || key === 'payload' || key === 'metadata') {
            violations.push(`${path}.${key}`);
          }
          scan((obj as Record<string, unknown>)[key], `${path}.${key}`);
        }
      }
      return violations;
    }

    const violations = scan(result.trace, 'trace');
    expect(violations).toEqual([]);
  });
});

describe('Audit snapshot isolation', () => {
  it('execution.trace !== execution.audit.trace', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    expect(result.trace).not.toBe(result.audit!.trace);
    expect(result.trace!.events).not.toBe(result.audit!.trace.events);
  });

  it('rankedRuleIds arrays are not shared between trace and audit', () => {
    const rules = [
      makeRule({ conditions: [makeCondition('amount_gt', 100)] }),
      makeRule({ conditions: [makeCondition('amount_lt', 1000)] }),
    ];
    const tx = makeTransaction({ amount: 500 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    for (let i = 0; i < result.trace!.events.length; i++) {
      const e = result.trace!.events[i];
      if (e.stage === 'ranking' && e.event === 'final_order') {
        const auditEvent = result.audit!.trace.events[i];
        if (auditEvent.stage === 'ranking' && auditEvent.event === 'final_order') {
          expect(e.rankedRuleIds).not.toBe(auditEvent.rankedRuleIds);
        }
      }
    }
  });
});

describe('Serialization', () => {
  it('round-trip JSON is equivalent', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    const roundTrip = JSON.parse(JSON.stringify(result));
    expect(roundTrip.output.candidates).toEqual(result.output.candidates);
    expect(roundTrip.trace.events.map((e: { stage: string; event: string }) => `${e.stage}/${e.event}`))
      .toEqual(result.trace!.events.map((e) => `${e.stage}/${e.event}`));
  });

  it('no non-serializable types in result (Date, Map, Set)', () => {
    const rule = makeRule({ conditions: [makeCondition('amount_gt', 500)] });
    const tx = makeTransaction({ amount: 600 });
    const result = evaluateRules({
      transaction: tx,
      context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });

    function checkSerializable(value: unknown): string[] {
      const issues: string[] = [];
      if (value instanceof Date) issues.push('Date found');
      if (value instanceof Map) issues.push('Map found');
      if (value instanceof Set) issues.push('Set found');
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const v of Object.values(value as Record<string, unknown>)) {
          issues.push(...checkSerializable(v));
        }
      }
      if (Array.isArray(value)) {
        for (const v of value) {
          issues.push(...checkSerializable(v));
        }
      }
      return issues;
    }

    const serialized = JSON.parse(JSON.stringify(result));
    expect(checkSerializable(serialized)).toEqual([]);
  });
});

describe('AuditLogEntry removal', () => {
  it('AuditLogEntry is not exported from types', async () => {
    const types = await import('../types');
    expect((types as any).AuditLogEntry).toBeUndefined();
  });

  it('no stale references to AuditLogEntry in source files', async () => {
    const indexExports = await import('../index');
    expect((indexExports as any).AuditLogEntry).toBeUndefined();
  });
});

describe('RuleEngineError.trace field', () => {
  it('error trace property is a DecisionTrace (not raw events)', () => {
    const rule = makeRule({ conditions: [makeCondition('description_matches', '[invalid')] });
    const tx = makeTransaction();
    try {
      evaluateRules({
        transaction: tx,
        context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.trace).toBeDefined();
      expect(err.trace.engineVersion).toBe(RULE_ENGINE_VERSION);
      expect(Array.isArray(err.trace.events)).toBe(true);
      expect(typeof err.trace.truncated).toBe('boolean');
      expect(typeof err.trace.totalEvents).toBe('number');
      expect(typeof err.trace.emittedEvents).toBe('number');
    }
  });
});
