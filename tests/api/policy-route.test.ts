import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-admin'));
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockEvaluateReadiness = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockDbUserFindUnique },
    companyMember: { findUnique: mockDbCompanyMemberFindUnique },
  },
}));

vi.mock('@/lib/services/canonical-readiness-service', () => ({
  evaluateCanonicalReadiness: mockEvaluateReadiness,
}));

import { GET } from '@/app/api/admin/shadow-metrics/policy/route';

const BASE_PARAMS = new URLSearchParams({
  companyId: 'c1',
  from: '2025-01-01',
  to: '2025-02-01',
  minimumEvaluatedTransactions: '100',
  minimumBatches: '3',
  minimumAgreementRate: '0.95',
  maximumDivergenceRate: '0.05',
  maximumAmbiguityRate: '0.02',
  maximumErrorRate: '0.01',
  maximumInvalidRecordRate: '0.05',
});

function createRequest(params: URLSearchParams): NextRequest {
  return new NextRequest(`http://localhost/api/admin/shadow-metrics/policy?${params.toString()}`);
}

function mockSuperAdmin() {
  mockGetSessionUserId.mockResolvedValue('user-admin');
  mockDbUserFindUnique.mockResolvedValue({ role: 'super_admin' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSuperAdmin();
  mockEvaluateReadiness.mockResolvedValue({
    status: 'READY',
    metrics: { batches: 10, totalEvaluated: 200, validComparisons: 195, sameDecision: 190, divergentDecision: 3, ambiguous: 2, errors: 0, agreementRate: 0.974, divergenceRate: 0.015, ambiguityRate: 0.01, errorRate: 0, trustedBatches: 10, legacyBatches: 0, legacyUntrustedBatches: 0, invalidRecords: 0, reasons: { NO_MATCH: 1, AMBIGUOUS: 2, UNDETERMINED: 0, OTHER: 0 } },
    checks: [
      { code: 'MINIMUM_EVALUATED_TRANSACTIONS', operator: '>=', passed: true, actual: 200, expected: 100 },
      { code: 'MINIMUM_BATCHES', operator: '>=', passed: true, actual: 10, expected: 3 },
    ],
  });
});

describe('context validation', () => {
  it('returns 200 with APPLY_ALL context', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', 'APPLY_ALL');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 200 with IMPORT context', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', 'IMPORT');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 200 with RECONCILIATION context', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', 'RECONCILIATION');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 400 when context is missing', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when context is invalid', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', 'INVALID');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when context is empty string', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', '');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe('source/context independence', () => {
  it('source=ALL does not infer or default context', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'ALL');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe('response shape', () => {
  it('returns OperationalPolicyDecision with correct shape', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', 'APPLY_ALL');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body).toHaveProperty('action');
    expect(body).toHaveProperty('context', 'APPLY_ALL');
    expect(body).toHaveProperty('profileId');
    expect(body).toHaveProperty('profileVersion');
    expect(body).toHaveProperty('readiness');
    expect(body).toHaveProperty('rules');
    expect(body).toHaveProperty('reasons');
    expect(body.reasons).toHaveProperty('reasonCode');
    expect(body.reasons).toHaveProperty('summary');

    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.readiness).toHaveProperty('status');
    expect(body.readiness).toHaveProperty('metrics');
    expect(body.readiness).toHaveProperty('checks');
  });
});

describe('authentication', () => {
  it('returns 200 with valid super admin session', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', 'APPLY_ALL');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 401 with no session', async () => {
    mockGetSessionUserId.mockResolvedValue(null);
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', 'APPLY_ALL');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    mockDbUserFindUnique.mockResolvedValue({ role: 'user' });
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('context', 'APPLY_ALL');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
  });
});
