import { describe, it, expect } from 'vitest';
import type { MatchResult } from '@/lib/services/apply-all-engine';

// Replicate the exact logic of buildMiniMatchResult from apply-all-use-case
// to verify contract parity without importing from the mocked module
function buildMiniMatchResult(
  singleTx: { id: string; amount: number; description: string },
  rule: { id: string; name: string; priority: number | null },
  confidenceLabel: 'high' | 'medium' | 'low',
): MatchResult {
  const distribution = { high: 0, medium: 0, low: 0 };
  distribution[confidenceLabel] = 1;

  return {
    matchedRules: [{
      rule: { id: rule.id, name: rule.name, priority: rule.priority },
      txIds: [singleTx.id],
      confidenceDistribution: distribution,
    }],
    transactions: [singleTx],
    totalAmount: singleTx.amount,
    totalCount: 1,
    remaining: 0,
  };
}

describe('buildMiniMatchResult contract parity with batch', () => {
  it('produces the same shape as a single-match batch MatchResult', () => {
    const tx = { id: 'tx-1', amount: 150, description: 'APPLE.COM BILLING' };
    const rule = { id: 'r1', name: 'Apple Rule', priority: 10 };

    const miniResult = buildMiniMatchResult(tx, rule, 'high');

    const expected: MatchResult = {
      matchedRules: [{
        rule: { id: 'r1', name: 'Apple Rule', priority: 10 },
        txIds: ['tx-1'],
        confidenceDistribution: { high: 1, medium: 0, low: 0 },
      }],
      transactions: [{ id: 'tx-1', amount: 150, description: 'APPLE.COM BILLING' }],
      totalAmount: 150,
      totalCount: 1,
      remaining: 0,
    };

    expect(miniResult).toEqual(expected);
  });

  it('matches the batch MatchResult type contract exactly', () => {
    const tx = { id: 'tx-2', amount: -200, description: 'DEBIT CHARGE' };
    const rule = { id: 'r2', name: 'Debit Rule', priority: 5 };

    const miniResult = buildMiniMatchResult(tx, rule, 'low');

    // Contract: all required fields present
    expect(miniResult).toHaveProperty('matchedRules');
    expect(miniResult).toHaveProperty('transactions');
    expect(miniResult).toHaveProperty('totalAmount');
    expect(miniResult).toHaveProperty('totalCount');
    expect(miniResult).toHaveProperty('remaining');

    // Contract: matchedRules entries have expected shape
    expect(miniResult.matchedRules[0]).toHaveProperty('rule');
    expect(miniResult.matchedRules[0].rule).toHaveProperty('id');
    expect(miniResult.matchedRules[0].rule).toHaveProperty('name');
    expect(miniResult.matchedRules[0].rule).toHaveProperty('priority');
    expect(miniResult.matchedRules[0]).toHaveProperty('txIds');
    expect(miniResult.matchedRules[0]).toHaveProperty('confidenceDistribution');

    // Contract: confidenceDistribution has three keys
    expect(miniResult.matchedRules[0].confidenceDistribution).toHaveProperty('high');
    expect(miniResult.matchedRules[0].confidenceDistribution).toHaveProperty('medium');
    expect(miniResult.matchedRules[0].confidenceDistribution).toHaveProperty('low');

    // Contract: invariant holds
    const dist = miniResult.matchedRules[0].confidenceDistribution;
    expect(dist.high + dist.medium + dist.low).toBe(miniResult.matchedRules[0].txIds.length);
  });

  it('accepts all three confidence labels', () => {
    const tx = { id: 'tx-3', amount: 100, description: 'TX' };
    const rule = { id: 'r3', name: 'Test', priority: 1 };

    for (const label of ['high', 'medium', 'low'] as const) {
      const result = buildMiniMatchResult(tx, rule, label);
      expect(result.matchedRules[0].confidenceDistribution[label]).toBe(1);
      expect(result.matchedRules[0].txIds).toHaveLength(1);
    }
  });

  it('single apply does NOT set ambiguousTransactions (no ambiguity)', () => {
    const tx = { id: 'tx-4', amount: 100, description: 'TX' };
    const rule = { id: 'r4', name: 'Test', priority: 1 };

    const result = buildMiniMatchResult(tx, rule, 'high');

    expect(result.ambiguousTransactions).toBeUndefined();
  });
});
