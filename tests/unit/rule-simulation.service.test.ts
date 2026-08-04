import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const matchTransactionsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/apply-all-engine', () => ({
  matchTransactions: matchTransactionsMock,
}));

import { simulateApply } from '@/lib/services/rule-simulation.service';

const baseMatch = {
  matchedRules: [
    {
      rule: { id: 'rule-b', priority: 20, name: 'B' },
      txIds: ['t3', 't1'],
    },
    {
      rule: { id: 'rule-a', priority: 5, name: 'A' },
      txIds: ['t2', 't0', 't1'],
    },
  ],
  totalMatched: 5,
};

describe('4.10 - simulateApply contract (unit, mocked engine)', () => {
  beforeEach(() => matchTransactionsMock.mockReset());
  afterEach(() => {});

  it('returns readOnly / recordCreated / ledgerAccuracyNotGuaranteed flags', async () => {
    matchTransactionsMock.mockResolvedValue(baseMatch as never);
    const result = await simulateApply('company-1', { limit: 200 });
    expect(result.readOnly).toBe(true);
    expect(result.recordCreated).toBe(false);
    expect(result.ledgerAccuracyNotGuaranteed).toBe(true);
  });

  it('forwards companyId and limit to the real engine and reuses its result', async () => {
    matchTransactionsMock.mockResolvedValue(baseMatch as never);
    await simulateApply('company-1', { limit: 7 });
    expect(matchTransactionsMock).toHaveBeenCalledTimes(1);
    expect(matchTransactionsMock).toHaveBeenCalledWith('company-1', { limit: 7 });
  });

  it('sorts rules by priority asc and txIds ascending (canonical ordering)', async () => {
    matchTransactionsMock.mockResolvedValue(baseMatch as never);
    const result = await simulateApply('company-1');
    const priorities = result.matchResult.matchedRules.map((r) => r.rule.priority);
    expect(priorities).toEqual([5, 20]);
    expect(result.matchResult.matchedRules[0].txIds).toEqual(['t0', 't1', 't2']);
    expect(result.matchResult.matchedRules[1].txIds).toEqual(['t1', 't3']);
  });
});