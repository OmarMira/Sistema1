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

// S7-08 mocks
const mockIsObservationEnabled = vi.hoisted(() => vi.fn());
const mockObservePolicy = vi.hoisted(() => vi.fn());
const mockShadowMetricsReader = vi.hoisted(() => vi.fn());
const mockPrismaAuditLogRepo = vi.hoisted(() => vi.fn());

// S7-11 enforcement mock (default ALLOW so enforcement never blocks test flow)
const mockEvaluateEnforcement = vi.hoisted(() => vi.fn().mockResolvedValue({
  action: 'ALLOW' as const,
  context: 'APPLY_ALL' as const,
  profileId: 'standard-enforcement-v1',
  profileVersion: '1.0.0',
  readiness: { status: 'READY' as const, metrics: {}, failedChecks: [], checks: [] },
  rules: [],
  reasons: { reasonCode: 'DEFAULT_ACTION', summary: 'Default ALLOW' },
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

vi.mock('@/lib/rule-engine/flag', () => ({
  isOperationalPolicyObservationEnabled: mockIsObservationEnabled,
}));

vi.mock('@/lib/operational-policy/apply-all-observer', () => ({
  observePolicy: mockObservePolicy,
}));

vi.mock('@/lib/services/shadow-metrics-reader', () => ({
  ShadowMetricsReader: mockShadowMetricsReader,
}));

vi.mock('@/lib/db/audit-log-repository', () => ({
  PrismaAuditLogRepository: mockPrismaAuditLogRepo,
}));

vi.mock('@/lib/operational-policy/policy-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operational-policy/policy-service')>('@/lib/operational-policy/policy-service');
  return { ...actual, evaluateOperationalPolicy: mockEvaluateEnforcement };
});

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

// S7-08: Observational policy block

const OBSERVATION_DECISION = {
  action: 'WARN',
  context: 'APPLY_ALL',
  profileId: 'observational-policy-v1',
  profileVersion: '1.0.0',
  readiness: {
    status: 'NOT_READY',
    metrics: {
      batches: 5,
      totalEvaluated: 150,
      sameDecision: 130,
      divergentDecision: 15,
      ambiguous: 3,
      errors: 2,
      agreementRate: 0.87,
      divergenceRate: 0.1,
      ambiguityRate: 0.02,
      errorRate: 0.013,
      invalidRecords: 0,
      trustedBatches: 5,
      legacyBatches: 0,
      legacyUntrustedBatches: 0,
      reasons: { NO_MATCH: 8, AMBIGUOUS: 3, UNDETERMINED: 5, OTHER: 2 },
      validComparisons: 148,
    },
    failedChecks: [
      { code: 'MINIMUM_AGREEMENT_RATE', operator: '>=', passed: false, actual: 0.87, expected: 0.95 },
    ],
    checks: [],
  },
  rules: [
    { ruleId: 'apply-all-not-ready', matched: true, action: 'WARN', reasonCode: 'READINESS_NOT_MET', context: 'APPLY_ALL', readinessStatus: 'NOT_READY' },
  ],
  reasons: {
    reasonCode: 'READINESS_NOT_MET',
    summary: 'Rule "apply-all-not-ready" matched — READINESS_NOT_MET. Action: WARN.',
  },
};

function enableObservation() {
  mockIsObservationEnabled.mockReturnValue(true);
  mockDb.auditLog = { create: vi.fn() };
}

function successResult() {
  return makeSuccessResult();
}

describe('S7-08: observational policy block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // T1: Flag OFF, shadow present → undefined
  it('returns undefined policyObservation when flag is OFF', async () => {
    mockIsObservationEnabled.mockReturnValue(false);
    mockMatchTransactionsWithShadow.mockResolvedValue(successResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toBeUndefined();
  });

  // T2: Flag OFF, early return → undefined
  it('returns undefined policyObservation when flag is OFF and early return', async () => {
    mockIsObservationEnabled.mockReturnValue(false);
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

    expect(result.policyObservation).toBeUndefined();
  });

  // T3: Flag ON, shadow present, observePolicy succeeds → AVAILABLE
  it('returns AVAILABLE when observation succeeds', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(successResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);
    mockObservePolicy.mockResolvedValue({
      status: 'AVAILABLE',
      decision: OBSERVATION_DECISION,
    });
    mockDb.auditLog.create.mockResolvedValue({ id: 'audit-1' });

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({
      status: 'AVAILABLE',
      decision: OBSERVATION_DECISION,
    });
  });

  // T4: Flag ON, no shadow → undefined
  it('returns undefined policyObservation when kind is without-shadow', async () => {
    enableObservation();
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
    _persistInner.mockResolvedValue(undefined);

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toBeUndefined();
  });

  // T5: Flag ON, early return → undefined
  it('returns undefined policyObservation on early return', async () => {
    enableObservation();
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

    expect(result.policyObservation).toBeUndefined();
  });

  // T6: Flag ON, observePolicy throws plain Error → POLICY_INTERNAL_ERROR
  it('returns POLICY_INTERNAL_ERROR on plain Error', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(successResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);
    mockObservePolicy.mockRejectedValue(new Error('provider unavailable'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({
      status: 'UNAVAILABLE',
      errorCode: 'POLICY_INTERNAL_ERROR',
    });
  });

  // T6b: ValidationError → POLICY_VALIDATION_ERROR
  it('returns POLICY_VALIDATION_ERROR on ValidationError', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(successResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);
    const { ValidationError } = await import('@/lib/api-error');
    mockObservePolicy.mockRejectedValue(new ValidationError('invalid criteria'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({
      status: 'UNAVAILABLE',
      errorCode: 'POLICY_VALIDATION_ERROR',
    });
  });

  // T6c: AppError → POLICY_PROVIDER_ERROR
  it('returns POLICY_PROVIDER_ERROR on AppError', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(successResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);
    const { AppError } = await import('@/lib/api-error');
    mockObservePolicy.mockRejectedValue(new AppError(500, 'reader failed', 'READER_ERROR'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({
      status: 'UNAVAILABLE',
      errorCode: 'POLICY_PROVIDER_ERROR',
    });
  });

  // T7: Flag ON, audit log create fails → AVAILABLE not degraded (I9)
  it('does NOT degrade AVAILABLE when audit log fails', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(successResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);
    mockObservePolicy.mockResolvedValue({
      status: 'AVAILABLE',
      decision: OBSERVATION_DECISION,
    });
    mockDb.auditLog.create.mockRejectedValue(new Error('db write failed'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({
      status: 'AVAILABLE',
      decision: OBSERVATION_DECISION,
    });
  });

  // T8: Flag ON, audit log is written with correct payload
  it('persists audit log with correct payload', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(successResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);
    mockObservePolicy.mockResolvedValue({
      status: 'AVAILABLE',
      decision: OBSERVATION_DECISION,
    });
    mockDb.auditLog.create.mockResolvedValue({ id: 'audit-1' });

    await executeApplyAllUseCase('c1');

    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const callArg = mockDb.auditLog.create.mock.calls[0][0];
    expect(callArg.data.action).toBe('OPERATIONAL_POLICY_OBSERVATION');
    expect(callArg.data.entity).toBe('ApplyAllBatch');
    expect(callArg.data.entityId).toBe('apply-all-test-batch');

    const details = JSON.parse(callArg.data.details);
    expect(details.policySchemaVersion).toBe(1);
    expect(details.context).toBe('APPLY_ALL');
    expect(details.action).toBe('WARN');
    expect(details.reasonCode).toBe('READINESS_NOT_MET');
    expect(details.readinessStatus).toBe('NOT_READY');
    expect(details.metricsWindow.source).toBe('APPLY_ALL');
    expect(details.metricsWindow.trustPolicy).toBe('INCLUDE_LEGACY_IMPORT');
  });

  // T9: Observational block does not affect productive result
  it('does not alter productive result when observation succeeds', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(successResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);
    mockObservePolicy.mockResolvedValue({
      status: 'AVAILABLE',
      decision: OBSERVATION_DECISION,
    });
    mockDb.auditLog.create.mockResolvedValue({ id: 'audit-1' });

    const result = await executeApplyAllUseCase('c1');

    expect(result.matchResult.totalCount).toBe(1);
    expect(result.applyResult.appliedCount).toBe(1);
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });
});
