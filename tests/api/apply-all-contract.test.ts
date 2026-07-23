import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Hoisted mocks (infrastructure) ─────────────────────────────────

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

// Mock the use case at module level so the route import gets the mock
vi.mock('@/lib/services/apply-all-use-case', () => ({
  executeApplyAllUseCase: mockExecuteApplyAllUseCase,
}));

// ─── SUT ────────────────────────────────────────────────────────────

import { POST } from '@/app/api/bank-rules/apply-all/route';

// ─── Helpers ────────────────────────────────────────────────────────

function createApplyAllRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/bank-rules/apply-all', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function makeUseCaseResult(overrides: Record<string, unknown> = {}) {
  return {
    matchResult: {
      matchedRules: [
        { rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: ['tx-1'] },
        { rule: { id: 'r2', name: 'Rule 2', priority: 2 }, txIds: ['tx-2'] },
      ],
      transactions: [
        { id: 'tx-1', amount: -100, description: 'test-1' },
        { id: 'tx-2', amount: -200, description: 'test-2' },
      ],
      totalAmount: -300,
      totalCount: 2,
      remaining: 0,
    },
    applyResult: { appliedCount: 2, journalEntryCount: 2 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default auth: user is authenticated and has membership
  mockGetSessionUserId.mockResolvedValue('user-1');
  mockDbUserFindUnique.mockResolvedValue({ role: 'admin' });
  mockDbCompanyMemberFindUnique.mockResolvedValue({ userId: 'user-1', companyId: 'c1' });

  // Default rate limit: allow
  mockCheckRateLimit.mockReturnValue({
    allowed: true,
    limit: 100,
    remaining: 99,
    resetAt: Math.ceil(Date.now() / 1000) + 60,
  });
});

// ===================================================================
// Current HTTP Contract — POST /api/bank-rules/apply-all
//
// These tests freeze the current API response shape BEFORE enforcement
// is added. Any change to the contract must update these tests.
// ===================================================================

describe('POST /api/bank-rules/apply-all — current HTTP contract', () => {
  it('returns 200 with success:true and basic fields', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue(makeUseCaseResult());

    const req = createApplyAllRequest({ companyId: 'c1' });
    const res = await POST(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Core success contract
    expect(body).toHaveProperty('success', true);
    expect(body).toHaveProperty('matched', 2);
    expect(body).toHaveProperty('total', 2);
    expect(body).toHaveProperty('remaining', 0);
    expect(body).toHaveProperty('rulesApplied');

    // rulesApplied shape
    expect(body.rulesApplied).toHaveLength(2);
    expect(body.rulesApplied[0]).toEqual({
      ruleId: 'r1',
      ruleName: 'Rule 1',
      count: 1,
    });
    expect(body.rulesApplied[1]).toEqual({
      ruleId: 'r2',
      ruleName: 'Rule 2',
      count: 1,
    });

    // Optional fields should NOT be present
    expect(body).not.toHaveProperty('warning');
    expect(body).not.toHaveProperty('policyObservation');
  });

  it('includes total = matched + remaining when remaining > 0', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue(
      makeUseCaseResult({
        matchResult: {
          matchedRules: [{ rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: ['tx-1'] }],
          transactions: [{ id: 'tx-1', amount: -100, description: 'test' }],
          totalAmount: -100,
          totalCount: 1,
          remaining: 5,
        },
        applyResult: { appliedCount: 1, journalEntryCount: 1 },
      }),
    );

    const req = createApplyAllRequest({ companyId: 'c1' });
    const res = await POST(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(body.matched).toBe(1);
    expect(body.total).toBe(6); // matched + remaining = 1 + 5
    expect(body.remaining).toBe(5);
  });

  it('includes warning string when remaining > 0', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue(
      makeUseCaseResult({
        matchResult: {
          matchedRules: [{ rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: ['tx-1'] }],
          transactions: [{ id: 'tx-1', amount: -100, description: 'test' }],
          totalAmount: -100,
          totalCount: 1,
          remaining: 3,
        },
        applyResult: { appliedCount: 1, journalEntryCount: 1 },
      }),
    );

    const req = createApplyAllRequest({ companyId: 'c1' });
    const res = await POST(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(body).toHaveProperty('warning');
    expect(typeof body.warning).toBe('string');
    expect(body.warning).toContain('1'); // applied count
    expect(body.warning).toContain('4'); // total
    expect(body.warning).toContain('3'); // remaining
  });

  it('omits warning when remaining is 0', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue(makeUseCaseResult());

    const req = createApplyAllRequest({ companyId: 'c1' });
    const res = await POST(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(body).not.toHaveProperty('warning');
  });

  it('includes policyObservation when present in use case result', async () => {
    const policyObservation = {
      status: 'AVAILABLE' as const,
      decision: {
        action: 'WARN' as const,
        context: 'APPLY_ALL' as const,
        profileId: 'observational-policy-v1',
        profileVersion: '1.0.0',
        readiness: { status: 'NOT_READY' as const, metrics: {}, failedChecks: [], checks: [] },
        rules: [],
        reasons: { reasonCode: 'READINESS_NOT_MET', summary: 'Readiness not met' },
      },
    };

    mockExecuteApplyAllUseCase.mockResolvedValue(
      makeUseCaseResult({ policyObservation }),
    );

    const req = createApplyAllRequest({ companyId: 'c1' });
    const res = await POST(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(body).toHaveProperty('policyObservation');
    expect(body.policyObservation).toEqual(policyObservation);
  });

  it('includes both warning and policyObservation when both present', async () => {
    const policyObservation = {
      status: 'AVAILABLE' as const,
      decision: {
        action: 'WARN' as const,
        context: 'APPLY_ALL' as const,
        profileId: 'observational-policy-v1',
        profileVersion: '1.0.0',
        readiness: { status: 'NOT_READY' as const, metrics: {}, failedChecks: [], checks: [] },
        rules: [],
        reasons: { reasonCode: 'READINESS_NOT_MET', summary: 'Not ready' },
      },
    };

    mockExecuteApplyAllUseCase.mockResolvedValue(
      makeUseCaseResult({
        policyObservation,
        matchResult: {
          matchedRules: [{ rule: { id: 'r1', name: 'Rule 1', priority: 1 }, txIds: ['tx-1'] }],
          transactions: [{ id: 'tx-1', amount: -100, description: 'test' }],
          totalAmount: -100,
          totalCount: 1,
          remaining: 2,
        },
        applyResult: { appliedCount: 1, journalEntryCount: 1 },
      }),
    );

    const req = createApplyAllRequest({ companyId: 'c1' });
    const res = await POST(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(body).toHaveProperty('warning');
    expect(body).toHaveProperty('policyObservation');
  });

  it('returns 400 with code VALIDATION_ERROR when companyId is missing from body', async () => {
    // apiHandler requires companyId — body without companyId
    const req = createApplyAllRequest({}); // no companyId
    const res = await POST(req, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('code');
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('includes security headers in the response', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue(makeUseCaseResult());

    const req = createApplyAllRequest({ companyId: 'c1' });
    const res = await POST(req, { params: Promise.resolve({}) });

    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();
  });

  it('returns 200 with matched=0 and rulesApplied=[] when no rules matched', async () => {
    mockExecuteApplyAllUseCase.mockResolvedValue({
      matchResult: {
        matchedRules: [],
        transactions: [],
        totalAmount: 0,
        totalCount: 0,
        remaining: 0,
      },
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
    });

    const req = createApplyAllRequest({ companyId: 'c1' });
    const res = await POST(req, { params: Promise.resolve({}) });
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.matched).toBe(0);
    expect(body.total).toBe(0);
    expect(body.remaining).toBe(0);
    expect(body.rulesApplied).toEqual([]);
  });
});
