import { describe, it, expect } from 'vitest';
import { makeRule, makeTransaction, makeRuleInput } from './fixtures';
import type { RuleDirection } from '../types';
import { runPipeline } from '../pipeline';

function collectCandidateIds(amount: number, direction?: RuleDirection): string[] {
  const rule = makeRule({ id: 'dir-rule', ...(direction !== undefined ? { direction } : {}) });
  const tx = makeTransaction({ amount });
  const input = makeRuleInput({
    transaction: tx,
    context: { availableRules: [rule], entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
  });
  const [result] = runPipeline(input);
  return result.rawCandidates.map((c) => c.ruleId);
}

describe('collectCandidates — direction pre-filter (BRE-007)', () => {
  it('TEST-1: debit + negative amount → matches', () => {
    expect(collectCandidateIds(-150, 'debit')).toEqual(['dir-rule']);
  });

  it('TEST-2: credit + positive amount → matches', () => {
    expect(collectCandidateIds(150, 'credit')).toEqual(['dir-rule']);
  });

  it('TEST-3: any → matches both signs', () => {
    expect(collectCandidateIds(-150, 'any')).toEqual(['dir-rule']);
    expect(collectCandidateIds(150, 'any')).toEqual(['dir-rule']);
  });

  it('TEST-4: opposite direction → no match (debit with positive, credit with negative)', () => {
    expect(collectCandidateIds(150, 'debit')).toEqual([]);
    expect(collectCandidateIds(-150, 'credit')).toEqual([]);
  });

  it('TEST-5: amount 0 → debit NO match, credit YES match', () => {
    expect(collectCandidateIds(0, 'debit')).toEqual([]);
    expect(collectCandidateIds(0, 'credit')).toEqual(['dir-rule']);
  });

  it('missing direction defaults to any (no filter)', () => {
    expect(collectCandidateIds(-150)).toEqual(['dir-rule']);
    expect(collectCandidateIds(150)).toEqual(['dir-rule']);
    expect(collectCandidateIds(0)).toEqual(['dir-rule']);
  });

  it('mixed rules: only the direction-matching rule survives', () => {
    const rules = [
      makeRule({ id: 'r-debit', direction: 'debit' }),
      makeRule({ id: 'r-credit', direction: 'credit' }),
      makeRule({ id: 'r-any' }),
    ];
    const tx = makeTransaction({ amount: -200 });
    const input = makeRuleInput({
      transaction: tx,
      context: { availableRules: rules, entityContexts: [], historicalMatches: [], entityResolution: { status: 'not_run' as const } },
    });
    const [result] = runPipeline(input);
    expect(result.rawCandidates.map((c) => c.ruleId)).toEqual(['r-debit', 'r-any']);
  });
});
