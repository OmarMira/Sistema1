import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ───────────────────────────────────────────────────
// All mocks are hoisted to top of module scope before any imports

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  auditLog: { create: vi.fn() },
}));

const mockMatchTransactionsWithShadow = vi.hoisted(() => vi.fn());
const mockExecuteApplyAll = vi.hoisted(() => vi.fn());

// S7-08 observer mocks
const mockIsObservationEnabled = vi.hoisted(() => vi.fn());
const mockObservePolicy = vi.hoisted(() => vi.fn());

// S7-11 enforcement mock (registered now for future use — harmless when not imported)
const mockEvaluateOperationalPolicy = vi.hoisted(() => vi.fn().mockResolvedValue({
  action: 'ALLOW' as const,
  context: 'APPLY_ALL' as const,
  profileId: 'standard-enforcement-v1',
  profileVersion: '1.0.0',
  readiness: { status: 'READY' as const, metrics: {}, failedChecks: [], checks: [] },
  rules: [],
  reasons: { reasonCode: 'DEFAULT_ACTION', summary: 'Default ALLOW' },
}));

// Shadow persist best-effort wrapper (mirrors actual implementation)
const _persistInner = vi.hoisted(() => vi.fn());
const mockPersist = vi.hoisted(() => vi.fn().mockImplementation(async (...a: any[]) => {
  try { await _persistInner(...a); } catch { /* best-effort */ }
}));

// ─── Module mocks ─────────────────────────────────────────────────────
// Must be at module level, before any imports

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/services/apply-all-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/apply-all-engine')>('@/lib/services/apply-all-engine');
  return { ...actual, matchTransactionsWithShadow: mockMatchTransactionsWithShadow, executeApplyAll: mockExecuteApplyAll };
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

// External deps — no side effects, just structural mocks
vi.mock('@/lib/services/shadow-metrics-reader', () => ({ ShadowMetricsReader: vi.fn() }));
vi.mock('@/lib/db/audit-log-repository', () => ({ PrismaAuditLogRepository: vi.fn() }));

// Register mock for policy-service even though use-case doesn't import it yet
// When enforcement is added and use-case imports evaluateOperationalPolicy,
// it automatically gets the mock. Harmless until then.
vi.mock('@/lib/operational-policy/policy-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operational-policy/policy-service')>('@/lib/operational-policy/policy-service');
  return { ...actual, evaluateOperationalPolicy: mockEvaluateOperationalPolicy };
});

// ─── SUT ──────────────────────────────────────────────────────────────

import { executeApplyAllUseCase } from '@/lib/services/apply-all-use-case';

// ─── Factories ────────────────────────────────────────────────────────

function makeMatchResult(overrides: Partial<{
  matchedRules: Array<{ rule: { id: string; name: string; priority: number }; txIds: string[] }>;
  transactions: Array<{ id: string; amount: number; description: string }>;
  totalAmount: number;
  totalCount: number;
  remaining: number;
}> = {}) {
  return {
    matchedRules: [{ rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: ['tx-1'] }],
    transactions: [{ id: 'tx-1', amount: -100, description: 'test' }],
    totalAmount: -100,
    totalCount: 1,
    remaining: 0,
    ...overrides,
  };
}

function buildSuccessResult(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'with-shadow' as const,
    matchResult: makeMatchResult(),
    shadow: {
      batchId: 'batch-1',
      summary: {
        totalEvaluated: 1, sameWinner: 1, differentWinner: 0, shadowErrors: 0,
        divergenceReasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
      },
    },
    ...overrides,
  };
}

function buildEmptyResult() {
  return {
    kind: 'without-shadow' as const,
    matchResult: {
      matchedRules: [] as never[],
      transactions: [] as never[],
      totalAmount: 0,
      totalCount: 0,
      remaining: 0,
    },
  };
}

function enableObservation() {
  mockIsObservationEnabled.mockReturnValue(true);
  mockObservePolicy.mockResolvedValue({
    status: 'AVAILABLE' as const,
    decision: {
      action: 'WARN' as const,
      context: 'APPLY_ALL' as const,
      profileId: 'observational-policy-v1',
      profileVersion: '1.0.0',
      readiness: {
        status: 'NOT_READY' as const,
        metrics: {},
        failedChecks: [{ code: 'MINIMUM_AGREEMENT_RATE', operator: '>=' as const, passed: false, actual: 0.87, expected: 0.95 }],
        checks: [],
      },
      rules: [],
      reasons: { reasonCode: 'READINESS_NOT_MET', summary: 'Readiness not met' },
    },
  });
  mockDb.auditLog.create.mockResolvedValue({ id: 'audit-1' });
}

// ===================================================================
// S7-11: Baseline — Current Behavior Regression
//
// These tests capture the current contract of executeApplyAllUseCase
// BEFORE enforcement is added. They must ALL pass against current code.
// Once enforcement is implemented, they serve as regression tests to
// ensure ALLOW/WARN paths still work as before.
// ===================================================================

describe('S7-11: Baseline — current behavior regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path (matching → transaction → shadow → observation) ──

  it('executes the full flow: matching → transaction → shadow → observation', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockExecuteApplyAll.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    mockDb.$transaction.mockImplementation(async (fn: any) => fn({}));
    _persistInner.mockResolvedValue(undefined);
    enableObservation();

    const result = await executeApplyAllUseCase('c1');

    // Matching
    expect(mockMatchTransactionsWithShadow).toHaveBeenCalledWith('c1', { limit: 200 });
    // Transaction + engine execution
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteApplyAll).toHaveBeenCalledTimes(1);
    // Shadow persist
    expect(_persistInner).toHaveBeenCalledTimes(1);
    expect(_persistInner).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'batch-1' }));
    // Observation
    expect(mockObservePolicy).toHaveBeenCalledTimes(1);
    // Result shape
    expect(result.matchResult.totalCount).toBe(1);
    expect(result.applyResult.appliedCount).toBe(1);
    expect(result.policyObservation).toBeDefined();
  });

  // ── Early returns ──

  it('early returns on empty matchedRules — no transaction, no shadow, no observation', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(buildEmptyResult());
    enableObservation();

    const result = await executeApplyAllUseCase('c1');

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(_persistInner).not.toHaveBeenCalled();
    expect(mockObservePolicy).not.toHaveBeenCalled();
    expect(result.applyResult).toEqual({ appliedCount: 0, journalEntryCount: 0 });
  });

  it('early returns on totalCount 0 — no transaction, no shadow, no observation', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue({
      ...buildEmptyResult(),
      matchResult: { matchedRules: [{ rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: [] }], transactions: [], totalAmount: 0, totalCount: 0, remaining: 10 },
    });
    enableObservation();

    const result = await executeApplyAllUseCase('c1');

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(_persistInner).not.toHaveBeenCalled();
    expect(mockObservePolicy).not.toHaveBeenCalled();
    expect(result.applyResult).toEqual({ appliedCount: 0, journalEntryCount: 0 });
  });

  // ── Shadow persistence ──

  it('does NOT persist shadow on transaction rollback', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockRejectedValue(new Error('deadlock'));

    await expect(executeApplyAllUseCase('c1')).rejects.toThrow('deadlock');
    expect(_persistInner).not.toHaveBeenCalled();
  });

  it('does NOT persist shadow when kind is without-shadow', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult({ kind: 'without-shadow' }));
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });

    await executeApplyAllUseCase('c1');

    expect(_persistInner).not.toHaveBeenCalled();
  });

  it('best-effort shadow failure does NOT affect productive result', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockRejectedValue(new Error('disk full'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.matchResult.totalCount).toBe(1);
    expect(result.applyResult.appliedCount).toBe(1);
  });

  it('executes transaction BEFORE shadow persist', async () => {
    const callOrder: string[] = [];
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockImplementation(async (fn: any) => {
      callOrder.push('transaction');
      return fn({});
    });
    mockExecuteApplyAll.mockImplementation(async () => {
      callOrder.push('executeApplyAll');
      return { appliedCount: 1, journalEntryCount: 1 };
    });
    _persistInner.mockImplementation(async () => { callOrder.push('persist'); });

    await executeApplyAllUseCase('c1');

    expect(callOrder).toEqual(['transaction', 'executeApplyAll', 'persist']);
  });

  // ── Observational policy (S7-08 backward-compatibility) ──

  it('returns undefined policyObservation when observation flag is OFF', async () => {
    mockIsObservationEnabled.mockReturnValue(false);
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toBeUndefined();
  });

  it('returns AVAILABLE policyObservation when observation succeeds', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    _persistInner.mockResolvedValue(undefined);

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({ status: 'AVAILABLE', decision: expect.any(Object) });
  });

  it('returns UNAVAILABLE policyObservation when observation throws', async () => {
    mockIsObservationEnabled.mockReturnValue(true);
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    mockObservePolicy.mockRejectedValue(new Error('provider unavailable'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({ status: 'UNAVAILABLE', errorCode: 'POLICY_INTERNAL_ERROR' });
  });

  it('maps observation error to POLCY_VALIDATION_ERROR on ValidationError', async () => {
    mockIsObservationEnabled.mockReturnValue(true);
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    const { ValidationError } = await import('@/lib/api-error');
    mockObservePolicy.mockRejectedValue(new ValidationError('invalid criteria'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({ status: 'UNAVAILABLE', errorCode: 'POLICY_VALIDATION_ERROR' });
  });

  it('maps observation error to POLCY_PROVIDER_ERROR on AppError', async () => {
    mockIsObservationEnabled.mockReturnValue(true);
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    const { AppError } = await import('@/lib/api-error');
    mockObservePolicy.mockRejectedValue(new AppError(500, 'provider failed', 'PROVIDER_ERROR'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({ status: 'UNAVAILABLE', errorCode: 'POLICY_PROVIDER_ERROR' });
  });

  it('does NOT degrade AVAILABLE when audit log best-effort fails', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    mockDb.auditLog.create.mockRejectedValue(new Error('db write failed'));

    const result = await executeApplyAllUseCase('c1');

    expect(result.policyObservation).toEqual({ status: 'AVAILABLE', decision: expect.any(Object) });
  });

  it('writes audit log with correct OPERATIONAL_POLICY_OBSERVATION payload', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
    mockDb.auditLog.create.mockResolvedValue({ id: 'audit-1' });

    await executeApplyAllUseCase('c1');

    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = mockDb.auditLog.create.mock.calls[0][0];
    expect(arg.data.action).toBe('OPERATIONAL_POLICY_OBSERVATION');
    expect(arg.data.entity).toBe('ApplyAllBatch');
    expect(arg.data.entityId).toBe('batch-1');
  });

  it('does NOT alter productive result when observation is available', async () => {
    enableObservation();
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    mockDb.$transaction.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });

    const result = await executeApplyAllUseCase('c1');

    expect(result.matchResult.totalCount).toBe(1);
    expect(result.applyResult.appliedCount).toBe(1);
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ===================================================================
// S7-11: Enforcement behavior tests
// ===================================================================

type DecisionAction = 'ALLOW' | 'WARN' | 'CONFIRM' | 'BLOCK';

function makeDecision(action: DecisionAction, overrides: Record<string, unknown> = {}) {
  const base = {
    action,
    context: 'APPLY_ALL' as const,
    profileId: 'standard-enforcement-v1',
    profileVersion: '1.0.0',
    readiness: {
      status: ('NOT_READY' as const),
      metrics: {},
      failedChecks: [],
      checks: [],
    },
    rules: [],
    reasons: { reasonCode: 'DEFAULT_ACTION', summary: 'Default action' },
  };

  switch (action) {
    case 'ALLOW':
      return { ...base, readiness: { status: 'READY' as const, metrics: {}, failedChecks: [], checks: [] }, reasons: { reasonCode: 'DEFAULT_ACTION', summary: 'Default ALLOW' }, ...overrides };
    case 'WARN':
      return { ...base, reasons: { reasonCode: 'READINESS_NOT_MET', summary: 'Readiness not met for Apply All' }, ...overrides };
    case 'CONFIRM':
      return { ...base, reasons: { reasonCode: 'READINESS_NOT_MET', summary: 'Readiness not met. Confirmation required.' }, ...overrides };
    case 'BLOCK':
      return { ...base, reasons: { reasonCode: 'HIGH_RISK', summary: 'High risk divergence blocks execution' }, ...overrides };
  }
}

function setupTransaction() {
  mockDb.$transaction.mockImplementation(async (fn: any) => fn({}));
  mockExecuteApplyAll.mockResolvedValue({ appliedCount: 1, journalEntryCount: 1 });
}

function expectNoExecution() {
  expect(mockDb.$transaction).not.toHaveBeenCalled();
  expect(mockExecuteApplyAll).not.toHaveBeenCalled();
}

describe('S7-11: Enforcement behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── ALLOW ─────────────────────────────────────────────────────────

  it('ALLOW executes and returns enforcement: EXECUTED', async () => {
    mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('ALLOW'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    setupTransaction();
    _persistInner.mockResolvedValue(undefined);

    const result = await executeApplyAllUseCase('c1');

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(result.applyResult.appliedCount).toBe(1);
    expect(result.enforcement).toEqual({ status: 'EXECUTED' });
  });

  // ── WARN ──────────────────────────────────────────────────────────

  it('WARN executes and returns enforcement with policyWarning', async () => {
    const decision = makeDecision('WARN');
    mockEvaluateOperationalPolicy.mockResolvedValue(decision);
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    setupTransaction();
    _persistInner.mockResolvedValue(undefined);

    const result = await executeApplyAllUseCase('c1');

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(result.applyResult.appliedCount).toBe(1);
    expect(result.enforcement).toEqual({
      status: 'EXECUTED',
      policyWarning: {
        reasonCode: 'READINESS_NOT_MET',
        transactionCount: 1,
        profileId: 'standard-enforcement-v1',
        profileVersion: '1.0.0',
      },
    });
  });

  // ── CONFIRM (first call — no confirmed flag) ──────────────────────

  it('CONFIRM without confirmed returns CONFIRMATION_REQUIRED and does NOT execute', async () => {
    mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('CONFIRM'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());

    const result = await executeApplyAllUseCase('c1');

    expectNoExecution();
    expect(result.applyResult).toEqual({ appliedCount: 0, journalEntryCount: 0 });
    expect(result.enforcement).toEqual({
      status: 'CONFIRMATION_REQUIRED',
      decision: {
        reasonCode: 'READINESS_NOT_MET',
        summary: 'Readiness not met. Confirmation required.',
        profileId: 'standard-enforcement-v1',
        profileVersion: '1.0.0',
        readinessStatus: 'NOT_READY',
      },
      context: {
        transactionCount: 1,
        matchedRuleCount: 1,
      },
    });
  });

  // ── confirmed:true + CONFIRM (second call — user consented) ──────

  it('confirmed:true overrides CONFIRM: executes and returns EXECUTED', async () => {
    mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('CONFIRM'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    setupTransaction();
    _persistInner.mockResolvedValue(undefined);

    const result = await executeApplyAllUseCase('c1', { confirmed: true });

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(result.applyResult.appliedCount).toBe(1);
    expect(result.enforcement).toEqual({ status: 'EXECUTED' });
  });

  // ── BLOCK ─────────────────────────────────────────────────────────

  it('BLOCK returns BLOCKED and does NOT execute', async () => {
    mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('BLOCK'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());

    const result = await executeApplyAllUseCase('c1');

    expectNoExecution();
    expect(result.applyResult).toEqual({ appliedCount: 0, journalEntryCount: 0 });
    expect(result.enforcement).toEqual({
      status: 'BLOCKED',
      block: {
        reasonCode: 'HIGH_RISK',
        summary: 'High risk divergence blocks execution',
        profileId: 'standard-enforcement-v1',
        profileVersion: '1.0.0',
      },
    });
  });

  // ── Policy error — fail-open ──────────────────────────────────────

  it('policy error does NOT block execution (fail-open) and returns policyUnavailable', async () => {
    mockEvaluateOperationalPolicy.mockRejectedValue(new Error('policy service unreachable'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    setupTransaction();
    _persistInner.mockResolvedValue(undefined);

    const result = await executeApplyAllUseCase('c1');

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(result.applyResult.appliedCount).toBe(1);
    expect(result.enforcement).toEqual({
      status: 'EXECUTED',
      policyUnavailable: { errorCode: 'POLICY_INTERNAL_ERROR' },
    });
  });

  // ── Policy error classification ───────────────────────────────────

  it('maps policy ValidationError to POLICY_VALIDATION_ERROR', async () => {
    const { ValidationError } = await import('@/lib/api-error');
    mockEvaluateOperationalPolicy.mockRejectedValue(new ValidationError('invalid criteria'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    setupTransaction();

    const result = await executeApplyAllUseCase('c1');

    expect(result.enforcement).toEqual({
      status: 'EXECUTED',
      policyUnavailable: { errorCode: 'POLICY_VALIDATION_ERROR' },
    });
  });

  it('maps policy AppError to POLICY_PROVIDER_ERROR', async () => {
    const { AppError } = await import('@/lib/api-error');
    mockEvaluateOperationalPolicy.mockRejectedValue(new AppError(502, 'provider timeout', 'PROVIDER_ERROR'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    setupTransaction();

    const result = await executeApplyAllUseCase('c1');

    expect(result.enforcement).toEqual({
      status: 'EXECUTED',
      policyUnavailable: { errorCode: 'POLICY_PROVIDER_ERROR' },
    });
  });

  // ── CONFIRMED re-evaluation edge: blocked second time ─────────────

  it('confirmed:true with BLOCK decision still blocks (conditions worsened)', async () => {
    mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('BLOCK'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());

    const result = await executeApplyAllUseCase('c1', { confirmed: true });

    expectNoExecution();
    expect(result.enforcement?.status).toBe('BLOCKED');
  });

  // ── ALLOW produces enforcement in result ─────────────────────────

  it('returns enforcement field (not undefined) on successful execution', async () => {
    mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('ALLOW'));
    mockMatchTransactionsWithShadow.mockResolvedValue(buildSuccessResult());
    setupTransaction();

    const result = await executeApplyAllUseCase('c1');

    expect(result.enforcement).toBeDefined();
    expect(result.enforcement?.status).toBe('EXECUTED');
  });

  // ── Early return does NOT include enforcement ────────────────────

  it('early return (no matched rules) does NOT include enforcement', async () => {
    mockMatchTransactionsWithShadow.mockResolvedValue(buildEmptyResult());

    const result = await executeApplyAllUseCase('c1');

    expect(result.enforcement).toBeUndefined();
  });
});
