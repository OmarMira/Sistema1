import { describe, it, expect } from 'vitest';
import { matchTransactions } from '@/lib/services/apply-all-engine';

describe('S7-05A: Contract characterization', () => {
  it('matchTransactions returns Promise<MatchResult>', async () => {
    const result = matchTransactions('c1');
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(resolved).toHaveProperty('matchedRules');
    expect(resolved).toHaveProperty('transactions');
    expect(resolved).toHaveProperty('totalAmount');
    expect(resolved).toHaveProperty('totalCount');
    expect(resolved).toHaveProperty('remaining');
  });

  it('matchTransactions accepts options with limit', async () => {
    const result = await matchTransactions('c1', { limit: 200 });
    expect(result).toHaveProperty('matchedRules');
    expect(result).toHaveProperty('totalCount');
  });

  it('MatchResult does not contain shadow fields', async () => {
    const result = await matchTransactions('c1', { limit: 200 });
    const keys = Object.keys(result);
    expect(keys).toEqual(['matchedRules', 'transactions', 'totalAmount', 'totalCount', 'remaining']);
    expect(keys).not.toContain('shadowSummary');
    expect(keys).not.toContain('shadowBatchId');
    expect(keys).not.toContain('shadow');
  });
});
