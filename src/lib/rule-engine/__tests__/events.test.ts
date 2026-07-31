import { describe, it, expect } from 'vitest';
import { classifyDivergence, buildDivergenceEvent } from '../events';
import type { V2EngineResult, PrecedenceEngineResult } from '../events';

function v2(v: Partial<V2EngineResult> = {}): V2EngineResult {
  return { outcome: 'pending', ...v };
}

function prec(v: Partial<PrecedenceEngineResult> = {}): PrecedenceEngineResult {
  return { reason: 'NO_MATCH', winnerRuleId: null, ambiguous: false, ...v };
}

describe('classifyDivergence', () => {
  it('SAME when both engines agree on same winner', () => {
    expect(classifyDivergence(
      v2({ outcome: 'matched', matchedRuleId: 'rule-1' }),
      prec({ reason: 'WINNER', winnerRuleId: 'rule-1' }),
    )).toBe('SAME');
  });

  it('DIFFERENT_WINNER when matchedRuleId differs from winnerRuleId', () => {
    expect(classifyDivergence(
      v2({ outcome: 'matched', matchedRuleId: 'rule-a' }),
      prec({ reason: 'WINNER', winnerRuleId: 'rule-b' }),
    )).toBe('DIFFERENT_WINNER');
  });

  it('V2_MATCH_PRECEDENCE_NO_MATCH when V2 matched but precedence has NO_MATCH', () => {
    expect(classifyDivergence(
      v2({ outcome: 'matched', matchedRuleId: 'rule-1' }),
      prec({ reason: 'NO_MATCH' }),
    )).toBe('V2_MATCH_PRECEDENCE_NO_MATCH');
  });

  it('V2_NO_MATCH_PRECEDENCE_MATCH when V2 pending and precedence has WINNER', () => {
    expect(classifyDivergence(
      v2({ outcome: 'pending' }),
      prec({ reason: 'WINNER', winnerRuleId: 'rule-1' }),
    )).toBe('V2_NO_MATCH_PRECEDENCE_MATCH');
  });

  it('V2_ERROR when V2 returns pending with errorCode', () => {
    expect(classifyDivergence(
      v2({ outcome: 'pending', errorCode: 'ERR_SOMETHING' }),
      prec({ reason: 'NO_MATCH' }),
    )).toBe('V2_ERROR');
  });

  it('V2_MATCH_PRECEDENCE_NO_MATCH when precedence is AMBIGUOUS and V2 matched', () => {
    expect(classifyDivergence(
      v2({ outcome: 'matched', matchedRuleId: 'rule-1' }),
      prec({ reason: 'AMBIGUOUS', ambiguous: true }),
    )).toBe('V2_MATCH_PRECEDENCE_NO_MATCH');
  });

  it('SAME when V2 pending without errorCode and precedence NO_MATCH', () => {
    expect(classifyDivergence(
      v2({ outcome: 'pending' }),
      prec({ reason: 'NO_MATCH' }),
    )).toBe('SAME');
  });
});

describe('buildDivergenceEvent', () => {
  it('returns null when there is no divergence (SAME)', () => {
    const event = buildDivergenceEvent(
      'tx-1', 'comp-1',
      v2({ outcome: 'matched', matchedRuleId: 'rule-1' }),
      prec({ reason: 'WINNER', winnerRuleId: 'rule-1' }),
    );
    expect(event).toBeNull();
  });

  it('returns event with correct data when divergence exists', () => {
    const event = buildDivergenceEvent(
      'tx-123', 'comp-456',
      v2({ outcome: 'matched', matchedRuleId: 'rule-a' }),
      prec({ reason: 'WINNER', winnerRuleId: 'rule-b' }),
    );
    expect(event).not.toBeNull();
    expect(event!.transactionId).toBe('tx-123');
    expect(event!.companyId).toBe('comp-456');
    expect(event!.divergenceType).toBe('DIFFERENT_WINNER');
    expect(event!.v2Result.matchedRuleId).toBe('rule-a');
    expect(event!.precedenceResult.winnerRuleId).toBe('rule-b');
    expect(event!.timestamp).toBeInstanceOf(Date);
  });

  it('returns null when both are SAME explicitly (V2 pending no error, precedence NO_MATCH)', () => {
    const event = buildDivergenceEvent(
      'tx-1', 'comp-1',
      v2({ outcome: 'pending' }),
      prec({ reason: 'NO_MATCH' }),
    );
    expect(event).toBeNull();
  });
});
