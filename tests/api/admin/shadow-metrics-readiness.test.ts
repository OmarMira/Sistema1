import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
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
import type { ReadinessCriteria } from '@/lib/services/canonical-readiness-service';

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

function mockSuccess() {
  mockEvaluateReadiness.mockResolvedValue({
    status: 'READY',
    metrics: { batches: 10 },
    checks: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSuperAdmin();
  mockSuccess();
});

describe('validation', () => {
  it('returns 200 for valid params', async () => {
    const req = createRequest(BASE_PARAMS);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it('returns 400 when companyId is missing', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.delete('companyId');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when source is invalid', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'INVALID');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
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

  it('returns 400 when trustPolicy is invalid', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('trustPolicy', 'INVALID');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

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

  it('returns 400 when from is invalid', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('from', 'not-a-date');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when to is invalid', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('to', 'not-a-date');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when from > to', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('from', '2025-03-01');
    params.set('to', '2025-01-01');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

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

describe('criteria conversion', () => {
  it('converts valid numeric strings to numbers', async () => {
    mockEvaluateReadiness.mockImplementation((_query: unknown, criteria: ReadinessCriteria) => {
      expect(typeof criteria.sample.minimumEvaluatedTransactions).toBe('number');
      expect(typeof criteria.sample.minimumBatches).toBe('number');
      expect(typeof criteria.quality.minimumAgreementRate).toBe('number');
      expect(typeof criteria.quality.maximumDivergenceRate).toBe('number');
      expect(typeof criteria.quality.maximumAmbiguityRate).toBe('number');
      expect(typeof criteria.integrity.maximumErrorRate).toBe('number');
      expect(typeof criteria.integrity.maximumInvalidRecordRate).toBe('number');
      return { status: 'READY', metrics: {}, checks: [] };
    });

    const req = createRequest(BASE_PARAMS);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });
});

describe('source values', () => {
  it('preserves source=IMPORT in the query', async () => {
    mockEvaluateReadiness.mockImplementation((query: { source: string }) => {
      expect(query.source).toBe('IMPORT');
      return { status: 'READY', metrics: {}, checks: [] };
    });

    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'IMPORT');
    const req = createRequest(params);
    await GET(req, { params: Promise.resolve({}) });
    expect(mockEvaluateReadiness).toHaveBeenCalled();
  });

  it('preserves source=APPLY_ALL in the query', async () => {
    mockEvaluateReadiness.mockImplementation((query: { source: string }) => {
      expect(query.source).toBe('APPLY_ALL');
      return { status: 'READY', metrics: {}, checks: [] };
    });

    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'APPLY_ALL');
    const req = createRequest(params);
    await GET(req, { params: Promise.resolve({}) });
    expect(mockEvaluateReadiness).toHaveBeenCalled();
  });

  it('preserves source=ALL in the query', async () => {
    mockEvaluateReadiness.mockImplementation((query: { source: string }) => {
      expect(query.source).toBe('ALL');
      return { status: 'READY', metrics: {}, checks: [] };
    });

    const params = new URLSearchParams(BASE_PARAMS);
    params.set('source', 'ALL');
    const req = createRequest(params);
    await GET(req, { params: Promise.resolve({}) });
    expect(mockEvaluateReadiness).toHaveBeenCalled();
  });
});

describe('action param', () => {
  it('ignores action query param (never validated by route)', async () => {
    const params = new URLSearchParams(BASE_PARAMS);
    params.set('action', 'RULE_PRECEDENCE_SHADOW_SUMMARY');
    const req = createRequest(params);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });
});

describe('service interaction', () => {
  it('forwards exact query and criteria to evaluateCanonicalReadiness', async () => {
    mockEvaluateReadiness.mockResolvedValue({ status: 'READY', metrics: {}, checks: [] });

    const params = new URLSearchParams(BASE_PARAMS);
    const req = createRequest(params);
    await GET(req, { params: Promise.resolve({}) });

    expect(mockEvaluateReadiness).toHaveBeenCalledTimes(1);
    const [query, criteria] = mockEvaluateReadiness.mock.calls[0];

    expect(query).toMatchObject({
      companyId: 'c1',
      source: 'ALL',
      trustPolicy: 'INCLUDE_LEGACY_IMPORT',
    });
    expect(criteria).toMatchObject({
      sample: { minimumEvaluatedTransactions: 100, minimumBatches: 3 },
      quality: { minimumAgreementRate: 0.95, maximumDivergenceRate: 0.05, maximumAmbiguityRate: 0.02 },
      integrity: { maximumErrorRate: 0.01, maximumInvalidRecordRate: 0.05 },
    });
  });

  it('propagates service errors as 500', async () => {
    mockEvaluateReadiness.mockRejectedValue(new Error('service error'));

    const req = createRequest(BASE_PARAMS);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
  });
});
