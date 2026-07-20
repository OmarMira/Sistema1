import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));

const mockMatchTransactionsWithShadow = vi.hoisted(() => vi.fn());
const mockExecuteApplyAll = vi.hoisted(() => vi.fn());

// Wrapper that simulates best-effort behavior: catches errors internally
// Delegates to _persistInner for assertions
const _persistInner = vi.hoisted(() => vi.fn());
const mockPersist = vi.hoisted(() => vi.fn().mockImplementation(async (...a: any[]) => {
  try {
    await _persistInner(...a);
  } catch {
    // best-effort: error swallowed internally
  }
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/services/apply-all-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/apply-all-engine')>('@/lib/services/apply-all-engine');
  return {
    ...actual,
    matchTransactionsWithShadow: mockMatchTransactionsWithShadow,
    executeApplyAll: mockExecuteApplyAll,
  };
});

vi.mock('@/lib/services/rule-precedence-shadow', () => ({
  persistShadowSummaryBestEffort: mockPersist,
}));

import { executeApplyAllUseCase } from '@/lib/services/apply-all-use-case';

function makeSuccessResult(overrides = {}) {
  return {
    kind: 'with-shadow' as const,
    matchResult: {
      matchedRules: [{ rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: ['tx-1'] }],
      transactions: [{ id: 'tx-1', amount: -100, description: 'test' }],
      totalAmount: -100,
      totalCount: 1,
      remaining: 0,
    },
    shadow: {
      batchId: 'apply-all-test-batch',
      summary: {
        totalEvaluated: 1,
        sameWinner: 1,
        differentWinner: 0,
        shadowErrors: 0,
        divergenceReasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
      },
    },
    ...overrides,
  };
}

describe('S7-05A: executeApplyAllUseCase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists shadow after successful transaction', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(makeSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);

    const result = await executeApplyAllUseCase('c1');

    expect(_persistInner).toHaveBeenCalledTimes(1);
    expect(_persistInner).toHaveBeenCalledWith({
      companyId: 'c1',
      entity: 'ApplyAllBatch',
      entityId: 'apply-all-test-batch',
      summary: {
        totalEvaluated: 1,
        sameWinner: 1,
        differentWinner: 0,
        shadowErrors: 0,
        divergenceReasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
      },
    });
    expect(result.matchResult.totalCount).toBe(1);
    expect(result.applyResult.appliedCount).toBe(1);
  });

  it('does NOT persist shadow on rollback', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(makeSuccessResult());
    mockDb.$transaction.mockRejectedValue(new Error('rollback'));

    await expect(executeApplyAllUseCase('c1')).rejects.toThrow('rollback');
    expect(_persistInner).not.toHaveBeenCalled();
  });

  it('early return: no transaction or persistence when matchedRules is empty', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue({
      kind: 'without-shadow',
      matchResult: {
        matchedRules: [],
        transactions: [],
        totalAmount: 0,
        totalCount: 0,
        remaining: 0,
      },
    });

    const result = await executeApplyAllUseCase('c1');

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(_persistInner).not.toHaveBeenCalled();
    expect(result.applyResult).toEqual({ appliedCount: 0, journalEntryCount: 0 });
  });

  it('early return: no transaction or persistence when totalCount is 0', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue({
      kind: 'without-shadow',
      matchResult: {
        matchedRules: [],
        transactions: [],
        totalAmount: 0,
        totalCount: 0,
        remaining: 10,
      },
    });

    const result = await executeApplyAllUseCase('c1');

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(_persistInner).not.toHaveBeenCalled();
  });

  it('does NOT persist when kind is without-shadow', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue({
      kind: 'without-shadow',
      matchResult: {
        matchedRules: [{ rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: ['tx-1'] }],
        transactions: [{ id: 'tx-1', amount: -100, description: 'test' }],
        totalAmount: -100,
        totalCount: 1,
        remaining: 0,
      },
    });
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });

    const result = await executeApplyAllUseCase('c1');

    expect(_persistInner).not.toHaveBeenCalled();
    expect(result.applyResult.appliedCount).toBe(1);
  });

  it('best-effort failure does not affect productive result', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(makeSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 0 });
    _persistInner.mockRejectedValue(new Error('persist failed'));

    const result = await executeApplyAllUseCase('c1');

    expect(_persistInner).toHaveBeenCalledTimes(1);
    expect(result.matchResult.totalCount).toBe(1);
    expect(result.applyResult.appliedCount).toBe(1);
  });

  it('transaction is called before persistence', async () => {
    const callOrder: string[] = [];
    mockMatchTransactionsWithShadow.mockResolvedValue(makeSuccessResult());
    mockDb.$transaction.mockImplementation(async (fn: any) => {
      callOrder.push('transaction');
      return fn({});
    });
    mockExecuteApplyAll.mockImplementation(async () => {
      callOrder.push('executeApplyAll');
      return { appliedCount: 1, journalEntryCount: 1 };
    });
    _persistInner.mockImplementation(async () => {
      callOrder.push('persist');
    });

    await executeApplyAllUseCase('c1');

    expect(callOrder).toEqual(['transaction', 'executeApplyAll', 'persist']);
  });
});
