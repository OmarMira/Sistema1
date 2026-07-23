import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Hoisted mocks ─────────────────────────────────────────────────

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-1'));
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockExecuteApplyAllUseCase = vi.hoisted(() => vi.fn());

// ─── Module mocks ───────────────────────────────────────────────────

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/security/rate-limiter', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockDbUserFindUnique },
    companyMember: { findUnique: mockDbCompanyMemberFindUnique },
  },
}));

vi.mock('@/lib/services/apply-all-use-case', () => ({
  executeApplyAllUseCase: mockExecuteApplyAllUseCase,
}));

// ─── SUT ────────────────────────────────────────────────────────────

import { POST } from '@/app/api/bank-rules/apply-all/route';

// ─── Helpers ────────────────────────────────────────────────────────

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/bank-rules/apply-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function matchResult() {
  return {
    matchedRules: [
      { rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: ['tx-1'] },
      { rule: { id: 'r2', name: 'Rule 2', priority: 2 }, txIds: ['tx-2'] },
    ],
    transactions: [
      { id: 'tx-1', amount: -100, description: 'a' },
      { id: 'tx-2', amount: -200, description: 'b' },
    ],
    totalAmount: -300,
    totalCount: 2,
    remaining: 0,
  };
}

function makeDecision(overrides: Record<string, unknown> = {}) {
  return {
    action: 'WARN' as const,
    context: 'APPLY_ALL' as const,
    profileId: 'standard-enforcement-v1',
    profileVersion: '1.0.0',
    readiness: { status: 'NOT_READY' as const, metrics: {}, failedChecks: [], checks: [] },
    rules: [],
    reasons: { reasonCode: 'READINESS_NOT_MET', summary: 'Readiness not met for APPLY_ALL' },
    ...overrides,
  };
}

// ─── Default mocks ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionUserId.mockResolvedValue('user-1');
  mockDbUserFindUnique.mockResolvedValue({ role: 'admin' });
  mockDbCompanyMemberFindUnique.mockResolvedValue({ userId: 'user-1', companyId: 'c1' });
  mockCheckRateLimit.mockReturnValue({
    allowed: true, limit: 100, remaining: 99,
    resetAt: Math.ceil(Date.now() / 1000) + 60,
  });
});

// ===================================================================
// Enforcement HTTP Contract — POST /api/bank-rules/apply-all
//
// These tests define the expected HTTP response shapes AFTER
// enforcement is implemented. They will fail (red phase) against
// the current route. They pass when enforcement is correctly added.
// ===================================================================

describe('S7-11: Enforcement HTTP contract', () => {
  // ── ALLOW ────────────────────────────────────────────────────────

  it('ALLOW returns 200 with status EXECUTED and productive fields', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 2, journalEntryCount: 2 },
      enforcement: { status: 'EXECUTED' },
    });

    const res = await POST(createRequest({ companyId: 'c1' }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('EXECUTED');
    expect(body.success).toBe(true);
    expect(body.matched).toBe(2);
    expect(body.total).toBe(2);
    expect(body.remaining).toBe(0);
    expect(body.rulesApplied).toHaveLength(2);
    // No policy fields
    expect(body).not.toHaveProperty('policyWarning');
    expect(body).not.toHaveProperty('policyUnavailable');
  });

  // ── WARN ─────────────────────────────────────────────────────────

  it('WARN returns 200 with status EXECUTED and policyWarning', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 2, journalEntryCount: 2 },
      enforcement: {
        status: 'EXECUTED',
        policyWarning: {
          reasonCode: 'READINESS_NOT_MET',
          transactionCount: 2,
          profileId: 'standard-enforcement-v1',
          profileVersion: '1.0.0',
        },
      },
    });

    const res = await POST(createRequest({ companyId: 'c1' }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('EXECUTED');
    expect(body.success).toBe(true);
    expect(body.matched).toBe(2);

    expect(body).toHaveProperty('policyWarning');
    expect(body.policyWarning).toEqual({
      reasonCode: 'READINESS_NOT_MET',
      transactionCount: 2,
      profileId: 'standard-enforcement-v1',
      profileVersion: '1.0.0',
    });
    expect(body).not.toHaveProperty('policyUnavailable');
  });

  // ── CONFIRM ──────────────────────────────────────────────────────

  it('CONFIRM returns 200 with status CONFIRMATION_REQUIRED, decision and context', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
      enforcement: {
        status: 'CONFIRMATION_REQUIRED',
        decision: {
          reasonCode: 'READINESS_NOT_MET',
          summary: 'Readiness not met for APPLY_ALL',
          profileId: 'standard-enforcement-v1',
          profileVersion: '1.0.0',
          readinessStatus: 'NOT_READY',
        },
        context: {
          transactionCount: 2,
          matchedRuleCount: 2,
        },
      },
    });

    const res = await POST(createRequest({ companyId: 'c1' }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('CONFIRMATION_REQUIRED');
    expect(body.decision).toEqual({
      reasonCode: 'READINESS_NOT_MET',
      summary: 'Readiness not met for APPLY_ALL',
      profileId: 'standard-enforcement-v1',
      profileVersion: '1.0.0',
      readinessStatus: 'NOT_READY',
    });
    expect(body.context).toEqual({ transactionCount: 2, matchedRuleCount: 2 });
  });

  // ── BLOCKED (future) ────────────────────────────────────────────

  it('BLOCK returns 200 with status BLOCKED and reason', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
      enforcement: {
        status: 'BLOCKED',
        block: {
          reasonCode: 'HIGH_RISK',
          summary: 'High risk divergence blocks execution',
          profileId: 'standard-enforcement-v1',
          profileVersion: '1.0.0',
        },
      },
    });

    const res = await POST(createRequest({ companyId: 'c1' }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('BLOCKED');
    expect(body.reasonCode).toBe('HIGH_RISK');
    expect(body.summary).toBe('High risk divergence blocks execution');
    expect(body.profileId).toBe('standard-enforcement-v1');
    expect(body.profileVersion).toBe('1.0.0');
  });

  // ── POLICY_UNAVAILABLE (fail-open) ───────────────────────────────

  it('POLICY_UNAVAILABLE returns 200 with status EXECUTED and policyUnavailable', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 2, journalEntryCount: 2 },
      enforcement: {
        status: 'EXECUTED',
        policyUnavailable: { errorCode: 'POLICY_INTERNAL_ERROR' },
      },
    });

    const res = await POST(createRequest({ companyId: 'c1' }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('EXECUTED');
    expect(body.success).toBe(true);
    expect(body.matched).toBe(2);

    expect(body).toHaveProperty('policyUnavailable');
    expect(body.policyUnavailable).toEqual({ errorCode: 'POLICY_INTERNAL_ERROR' });
    expect(body).not.toHaveProperty('policyWarning');
  });

  // ── Second call (confirmed: true) ────────────────────────────────

  it('confirmed:true + ALLOW re-evaluates and returns EXECUTED', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 2, journalEntryCount: 2 },
      enforcement: { status: 'EXECUTED' },
    });

    const res = await POST(createRequest({ companyId: 'c1', confirmed: true }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('EXECUTED');
    expect(mockExecuteApplyAllUseCase).toHaveBeenCalledWith('c1', { confirmed: true });
  });

  it('confirmed:true + CONFIRM returns EXECUTED (user already consented)', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 2, journalEntryCount: 2 },
      enforcement: { status: 'EXECUTED' },
    });

    const res = await POST(createRequest({ companyId: 'c1', confirmed: true }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('EXECUTED');
    expect(mockExecuteApplyAllUseCase).toHaveBeenCalledWith('c1', { confirmed: true });
  });

  it('confirmed:true + BLOCK returns BLOCKED (conditions worsened)', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
      enforcement: {
        status: 'BLOCKED',
        block: { reasonCode: 'CONDITIONS_WORSENED', summary: 'Conditions worsened since confirmation', profileId: 'standard-enforcement-v1', profileVersion: '1.0.0' },
      },
    });

    const res = await POST(createRequest({ companyId: 'c1', confirmed: true }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('BLOCKED');
  });

  it('confirmed:true + UNAVAILABLE returns EXECUTED (conservative fail-open)', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: matchResult(),
      applyResult: { appliedCount: 2, journalEntryCount: 2 },
      enforcement: {
        status: 'EXECUTED',
        policyUnavailable: { errorCode: 'POLICY_PROVIDER_ERROR' },
      },
    });

    const res = await POST(createRequest({ companyId: 'c1', confirmed: true }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('EXECUTED');
    expect(body).toHaveProperty('policyUnavailable');
  });

  // ── Coexistence with legacy fields ───────────────────────────────

  it('coexists with legacy warning (cap) when remaining > 0', async () => {
    const mr = matchResult();
    mr.remaining = 5;

    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: mr,
      applyResult: { appliedCount: 2, journalEntryCount: 2 },
      enforcement: {
        status: 'EXECUTED',
        policyWarning: {
          reasonCode: 'READINESS_NOT_MET',
          transactionCount: 2,
          profileId: 'standard-enforcement-v1',
          profileVersion: '1.0.0',
        },
      },
    });

    const res = await POST(createRequest({ companyId: 'c1' }), { params: Promise.resolve({}) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('EXECUTED');
    // Legacy cap warning
    expect(body).toHaveProperty('warning');
    expect(typeof body.warning).toBe('string');
    // Enforcement policy warning
    expect(body).toHaveProperty('policyWarning');
    expect(body.policyWarning.reasonCode).toBe('READINESS_NOT_MET');
  });
});
