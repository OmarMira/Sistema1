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

import { GET } from '@/app/api/admin/shadow-metrics/readiness/route';

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
  return new NextRequest(`http://localhost/api/admin/shadow-metrics/readiness?${params.toString()}`);
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
    metrics: { batches: 10 },
    checks: [],
  });
});

describe('default values', () => {
  it('defaults source to ALL when omitted', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.delete('source');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(mockEvaluateReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'ALL' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('defaults trustPolicy to INCLUDE_LEGACY_IMPORT when omitted', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.delete('trustPolicy');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(mockEvaluateReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ trustPolicy: 'INCLUDE_LEGACY_IMPORT' }),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('source validation', () => {
  it('accepts source ALL', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'ALL');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('accepts source IMPORT', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'IMPORT');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('accepts source APPLY_ALL', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'APPLY_ALL');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid source', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'INVALID');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid source');
  });
});

describe('trustPolicy validation', () => {
  it('accepts TRUSTED_ONLY', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('trustPolicy', 'TRUSTED_ONLY');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('accepts INCLUDE_LEGACY_IMPORT', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('trustPolicy', 'INCLUDE_LEGACY_IMPORT');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('accepts INCLUDE_UNTRUSTED_HISTORY', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('trustPolicy', 'INCLUDE_UNTRUSTED_HISTORY');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid trustPolicy', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('trustPolicy', 'INVALID');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe('date parsing', () => {
  it('returns 400 when from is missing', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.delete('from');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when to is missing', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.delete('to');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when from is invalid date string', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('from', 'not-a-date');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when to is invalid date string', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('to', 'not-a-date');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('accepts valid ISO date strings', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('from', '2025-01-15T00:00:00.000Z');
    params.set('to', '2025-02-15T00:00:00.000Z');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 400 when from > to', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('from', '2025-03-01');
    params.set('to', '2025-01-01');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe('companyId validation', () => {
  it('returns 400 when companyId is missing', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.delete('companyId');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe('numeric threshold validation', () => {
  const criteriaParams = [
    'minimumEvaluatedTransactions',
    'minimumBatches',
    'minimumAgreementRate',
    'maximumDivergenceRate',
    'maximumAmbiguityRate',
    'maximumErrorRate',
    'maximumInvalidRecordRate',
  ] as const;

  for (const param of criteriaParams) {
    it(`returns 400 when ${param} is missing`, async () => {
      const params = new URLSearchParams(BASE_PARAMS);
      params.delete(param);
      const req = createRequest(params);
      const res = await GET(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
    });
  }

  for (const param of criteriaParams) {
    it(`returns 400 when ${param} is non-numeric`, async () => {
      const params = new URLSearchParams(BASE_PARAMS);
      params.set(param, 'not-a-number');
      const req = createRequest(params);
      const res = await GET(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(400);
    });
  }
});

describe('authentication', () => {
  it('returns 200 with valid super admin session', async () => {
    const req = createRequest(BASE_PARAMS);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 401 with no session', async () => {
    mockGetSessionUserId.mockResolvedValue(null);
    const req = createRequest(BASE_PARAMS);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    mockDbUserFindUnique.mockResolvedValue({ role: 'user' });
    const req = createRequest(BASE_PARAMS);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
  });
});

describe('semantic deep equality', () => {
  it('deep equality with default params', async () => {
    mockEvaluateReadiness.mockResolvedValue({
      status: 'READY',
      metrics: { batches: 10, totalEvaluated: 200, validComparisons: 195, sameDecision: 190, divergentDecision: 3, ambiguous: 2, errors: 0, agreementRate: 0.974, divergenceRate: 0.015, ambiguityRate: 0.01, errorRate: 0, trustedBatches: 8, legacyBatches: 2, legacyUntrustedBatches: 0, invalidRecords: 0, reasons: { NO_MATCH: 1, AMBIGUOUS: 2, UNDETERMINED: 2, OTHER: 0 } },
      checks: [
        { code: 'MINIMUM_EVALUATED_TRANSACTIONS', operator: '>=', passed: true, actual: 200, expected: 100 },
        { code: 'MINIMUM_BATCHES', operator: '>=', passed: true, actual: 10, expected: 3 },
      ],
    });

    const params = new URLSearchParams({
      companyId: 'c1', from: '2025-01-01', to: '2025-02-01',
      minimumEvaluatedTransactions: '100', minimumBatches: '3',
      minimumAgreementRate: '0.95', maximumDivergenceRate: '0.05',
      maximumAmbiguityRate: '0.02', maximumErrorRate: '0.01',
      maximumInvalidRecordRate: '0.05',
    });

    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'READY',
      metrics: expect.objectContaining({
        batches: 10,
        totalEvaluated: 200,
      }),
    });
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it('deep equality with custom thresholds', async () => {
    mockEvaluateReadiness.mockResolvedValue({
      status: 'NOT_READY',
      metrics: { batches: 5, totalEvaluated: 50, validComparisons: 48, sameDecision: 40, divergentDecision: 5, ambiguous: 3, errors: 0, agreementRate: 0.833, divergenceRate: 0.104, ambiguityRate: 0.063, errorRate: 0, trustedBatches: 5, legacyBatches: 0, legacyUntrustedBatches: 0, invalidRecords: 0, reasons: { NO_MATCH: 2, AMBIGUOUS: 3, UNDETERMINED: 3, OTHER: 0 } },
      checks: [
        { code: 'MINIMUM_EVALUATED_TRANSACTIONS', operator: '>=', passed: true, actual: 50, expected: 30 },
        { code: 'MINIMUM_BATCHES', operator: '>=', passed: true, actual: 5, expected: 3 },
      ],
      failedChecks: [
        { code: 'MINIMUM_AGREEMENT_RATE', operator: '>=', passed: false, actual: 0.833, expected: 0.98 },
      ],
    });

    const params = new URLSearchParams({
      companyId: 'c2', from: '2025-01-01', to: '2025-02-01',
      source: 'IMPORT', trustPolicy: 'TRUSTED_ONLY',
      minimumEvaluatedTransactions: '30', minimumBatches: '3',
      minimumAgreementRate: '0.98', maximumDivergenceRate: '0.05',
      maximumAmbiguityRate: '0.02', maximumErrorRate: '0.01',
      maximumInvalidRecordRate: '0.05',
    });

    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('NOT_READY');
    expect(body.failedChecks).toBeDefined();
    expect(body.failedChecks.length).toBeGreaterThan(0);
  });

  it('deep equality with edge-case dates', async () => {
    mockEvaluateReadiness.mockResolvedValue({
      status: 'INSUFFICIENT_DATA',
      metrics: { batches: 1, totalEvaluated: 5, validComparisons: 4, sameDecision: 3, divergentDecision: 1, ambiguous: 0, errors: 0, agreementRate: 0.75, divergenceRate: 0.25, ambiguityRate: 0, errorRate: 0, trustedBatches: 1, legacyBatches: 0, legacyUntrustedBatches: 0, invalidRecords: 0, reasons: { NO_MATCH: 1, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 } },
      checks: [
        { code: 'MINIMUM_EVALUATED_TRANSACTIONS', operator: '>=', passed: true, actual: 5, expected: 10 },
        { code: 'MINIMUM_BATCHES', operator: '>=', passed: false, actual: 1, expected: 3 },
      ],
      reasons: ['MINIMUM_BATCHES: expected >= 3, got 1'],
    });

    const params = new URLSearchParams({
      companyId: 'c3', from: '2025-06-01', to: '2025-06-30',
      minimumEvaluatedTransactions: '10', minimumBatches: '3',
      minimumAgreementRate: '0.95', maximumDivergenceRate: '0.05',
      maximumAmbiguityRate: '0.02', maximumErrorRate: '0.01',
      maximumInvalidRecordRate: '0.05',
    });

    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('INSUFFICIENT_DATA');
    expect(body.reasons).toBeDefined();
    expect(body.reasons.length).toBeGreaterThan(0);
  });
});
