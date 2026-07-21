import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-admin'));
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockDbAuditLogFindMany = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockDbUserFindUnique },
    companyMember: { findUnique: mockDbCompanyMemberFindUnique },
    auditLog: { findMany: mockDbAuditLogFindMany },
  },
}));

import { GET } from '@/app/api/admin/shadow-metrics/readiness/route';
import { buildReadinessQueryParams } from '@/lib/readiness/build-readiness-query-params';
import type { ReadinessForm } from '@/lib/readiness/default-readiness-profile';
import type { CanonicalReadiness, ReadinessCheckCode } from '@/lib/services/canonical-readiness-service';

const ALL_CHECK_CODES: ReadinessCheckCode[] = [
  'MINIMUM_EVALUATED_TRANSACTIONS',
  'MINIMUM_BATCHES',
  'MINIMUM_AGREEMENT_RATE',
  'MAXIMUM_DIVERGENCE_RATE',
  'MAXIMUM_AMBIGUITY_RATE',
  'MAXIMUM_ERROR_RATE',
  'MAXIMUM_INVALID_RECORD_RATE',
];

const DEFAULT_FORM: ReadinessForm = {
  source: 'ALL',
  trustPolicy: 'INCLUDE_LEGACY_IMPORT',
  from: '2025-01-01',
  to: '2025-02-01',
  minimumEvaluatedTransactions: 100,
  minimumBatches: 3,
  minimumAgreementRate: 0.95,
  maximumDivergenceRate: 0.05,
  maximumAmbiguityRate: 0.02,
  maximumErrorRate: 0.01,
  maximumInvalidRecordRate: 0.05,
};

function createRequest(companyId: string, form?: ReadinessForm): NextRequest {
  const f = form ?? DEFAULT_FORM;
  const params = buildReadinessQueryParams(f, companyId);
  return new NextRequest(`http://localhost/api/admin/shadow-metrics/readiness?${params.toString()}`);
}

function v1ImportRecord(overrides?: {
  totalEvaluated?: number;
  sameWinner?: number;
  bothNoMatch?: number;
  productiveMatchCanonicalNoMatch?: number;
  productiveNoMatchCanonicalMatch?: number;
  differentWinner?: number;
  canonicalAmbiguous?: number;
  shadowErrors?: number;
}) {
  const m = {
    totalEvaluated: 50,
    sameWinner: 46,
    bothNoMatch: 2,
    productiveMatchCanonicalNoMatch: 0,
    productiveNoMatchCanonicalMatch: 0,
    differentWinner: 1,
    canonicalAmbiguous: 1,
    shadowErrors: 0,
    ...overrides,
  };
  const sum =
    m.sameWinner + m.bothNoMatch + m.productiveMatchCanonicalNoMatch +
    m.productiveNoMatchCanonicalMatch + m.differentWinner + m.canonicalAmbiguous +
    m.shadowErrors;
  if (sum !== m.totalEvaluated) {
    throw new Error(`V1 Import invariant: sum ${sum} !== totalEvaluated ${m.totalEvaluated}`);
  }
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    companyId: 'c1',
    action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
    entity: 'BankStatement',
    entityId: 'stmt-1',
    details: JSON.stringify({ schemaVersion: 1, source: 'IMPORT', metrics: m }),
    createdAt: new Date('2025-01-15'),
  };
}

function v0ImportRecord(overrides?: {
  totalEvaluated?: number;
  sameWinner?: number;
  bothNoMatch?: number;
  productiveMatchCanonicalNoMatch?: number;
  productiveNoMatchCanonicalMatch?: number;
  differentWinner?: number;
  canonicalAmbiguous?: number;
  shadowErrors?: number;
}) {
  const m = {
    totalEvaluated: 30,
    sameWinner: 25,
    bothNoMatch: 1,
    productiveMatchCanonicalNoMatch: 1,
    productiveNoMatchCanonicalMatch: 1,
    differentWinner: 1,
    canonicalAmbiguous: 1,
    shadowErrors: 0,
    ...overrides,
  };
  const sum =
    m.sameWinner + m.bothNoMatch + m.productiveMatchCanonicalNoMatch +
    m.productiveNoMatchCanonicalMatch + m.differentWinner + m.canonicalAmbiguous +
    m.shadowErrors;
  if (sum !== m.totalEvaluated) {
    throw new Error(`V0 Import invariant: sum ${sum} !== totalEvaluated ${m.totalEvaluated}`);
  }
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    companyId: 'c1',
    action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
    entity: 'BankStatement',
    entityId: null,
    details: JSON.stringify(m),
    createdAt: new Date('2025-01-10'),
  };
}

function v0ApplyAllRecord(overrides?: {
  totalEvaluated?: number;
  sameWinner?: number;
  differentWinner?: number;
  shadowErrors?: number;
  divergenceReasons?: { NO_MATCH: number; AMBIGUOUS: number; UNDETERMINED: number; OTHER: number };
}) {
  const dr = {
    NO_MATCH: 0,
    AMBIGUOUS: 0,
    UNDETERMINED: overrides?.differentWinner ?? 1,
    OTHER: 0,
    ...overrides?.divergenceReasons,
  };
  const m = {
    totalEvaluated: 20,
    sameWinner: 18,
    differentWinner: 1,
    shadowErrors: 1,
    divergenceReasons: dr,
    ...overrides,
    divergenceReasons: dr,
  };
  if (m.differentWinner !== dr.UNDETERMINED) {
    throw new Error(`V0 Apply All invariant: differentWinner ${m.differentWinner} !== UNDETERMINED ${dr.UNDETERMINED}`);
  }
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    companyId: 'c1',
    action: 'APPLY_ALL',
    entity: 'ApplyAllBatch',
    entityId: null,
    details: JSON.stringify(m),
    createdAt: new Date('2025-01-20'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionUserId.mockResolvedValue('user-admin');
  mockDbUserFindUnique.mockResolvedValue({ role: 'super_admin' });
});

describe('readiness end-to-end wiring', () => {
  it('routes query+criteria through real reader+service, returns READY when all checks pass', async () => {
    const records = Array.from({ length: 10 }, () => v1ImportRecord());
    mockDbAuditLogFindMany.mockResolvedValue(records);

    const req = createRequest('c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body: CanonicalReadiness = await res.json();
    expect(body.status).toBe('READY');

    expect(body.metrics.batches).toBe(10);
    expect(body.metrics.trustedBatches).toBe(10);
    expect(body.metrics.totalEvaluated).toBe(500);
    expect(body.metrics.validComparisons).toBe(500);
    expect(body.metrics.invalidRecords).toBe(0);

    expect(body.checks).toHaveLength(7);
    for (const code of ALL_CHECK_CODES) {
      const check = body.checks.find(c => c.code === code);
      expect(check).toBeDefined();
      expect(check!.passed).toBe(true);
    }

    expect('failedChecks' in body).toBe(false);
  });

  it('returns INSUFFICIENT_DATA when batches < minimumBatches', async () => {
    mockDbAuditLogFindMany.mockResolvedValue([
      v1ImportRecord({
        totalEvaluated: 100,
        sameWinner: 92,
        bothNoMatch: 3,
        productiveMatchCanonicalNoMatch: 1,
        productiveNoMatchCanonicalMatch: 1,
        differentWinner: 1,
        canonicalAmbiguous: 1,
        shadowErrors: 1,
      }),
    ]);

    const req = createRequest('c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body: CanonicalReadiness = await res.json();
    expect(body.status).toBe('INSUFFICIENT_DATA');

    expect(body.metrics.batches).toBe(1);
    expect(body.metrics.totalEvaluated).toBe(100);

    expect(body.checks).toHaveLength(7);

    const evalCheck = body.checks.find(c => c.code === 'MINIMUM_EVALUATED_TRANSACTIONS')!;
    expect(evalCheck.passed).toBe(true);
    expect(evalCheck.expected).toBe(100);
    expect(evalCheck.actual).toBe(100);

    const batchCheck = body.checks.find(c => c.code === 'MINIMUM_BATCHES')!;
    expect(batchCheck.passed).toBe(false);
    expect(batchCheck.expected).toBe(3);
    expect(batchCheck.actual).toBe(1);

    expect(body.reasons).toBeDefined();
    expect(body.reasons!.length).toBeGreaterThan(0);
    expect(body.reasons![0]).toContain('MINIMUM_BATCHES');
  });

  it('returns NOT_READY when agreement rate is below threshold', async () => {
    const records = Array.from({ length: 10 }, () =>
      v1ImportRecord({
        sameWinner: 20,
        bothNoMatch: 2,
        productiveMatchCanonicalNoMatch: 8,
        productiveNoMatchCanonicalMatch: 8,
        differentWinner: 8,
        canonicalAmbiguous: 4,
        shadowErrors: 0,
        totalEvaluated: 50,
      }),
    );
    mockDbAuditLogFindMany.mockResolvedValue(records);

    const req = createRequest('c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body: CanonicalReadiness = await res.json();
    expect(body.status).toBe('NOT_READY');

    const agreeCheck = body.checks.find(c => c.code === 'MINIMUM_AGREEMENT_RATE')!;
    expect(agreeCheck.passed).toBe(false);

    expect('failedChecks' in body).toBe(true);
    expect(body.failedChecks!.length).toBeGreaterThan(0);
  });

  it('preserves all 7 criteria params through to response checks', async () => {
    const records = Array.from({ length: 10 }, () => v1ImportRecord());
    mockDbAuditLogFindMany.mockResolvedValue(records);

    const customForm: ReadinessForm = {
      ...DEFAULT_FORM,
      minimumEvaluatedTransactions: 600,
      minimumBatches: 15,
      minimumAgreementRate: 0.99,
      maximumDivergenceRate: 0.01,
      maximumAmbiguityRate: 0.01,
      maximumErrorRate: 0.001,
      maximumInvalidRecordRate: 0.01,
    };

    const req = createRequest('c1', customForm);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body: CanonicalReadiness = await res.json();
    expect(body.status).toBe('INSUFFICIENT_DATA');

    for (const check of body.checks) {
      switch (check.code) {
        case 'MINIMUM_EVALUATED_TRANSACTIONS':
          expect(check.expected).toBe(600);
          break;
        case 'MINIMUM_BATCHES':
          expect(check.expected).toBe(15);
          break;
        case 'MINIMUM_AGREEMENT_RATE':
          expect(check.expected).toBe(0.99);
          break;
        case 'MAXIMUM_DIVERGENCE_RATE':
          expect(check.expected).toBe(0.01);
          break;
        case 'MAXIMUM_AMBIGUITY_RATE':
          expect(check.expected).toBe(0.01);
          break;
        case 'MAXIMUM_ERROR_RATE':
          expect(check.expected).toBe(0.001);
          break;
        case 'MAXIMUM_INVALID_RECORD_RATE':
          expect(check.expected).toBe(0.01);
          break;
      }
    }
  });

  it('forwards companyId, source, trustPolicy, from, to to PrismaAuditLogRepository', async () => {
    mockDbAuditLogFindMany.mockResolvedValue([v1ImportRecord()]);

    const req = createRequest('c1');
    await GET(req, { params: Promise.resolve({}) });

    expect(mockDbAuditLogFindMany).toHaveBeenCalledTimes(1);
    expect(mockDbAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'c1',
          entity: { in: ['BankStatement', 'ApplyAllBatch'] },
          action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
          createdAt: {
            gte: new Date('2025-01-01T00:00:00.000Z'),
            lte: new Date('2025-02-01T23:59:59.999Z'),
          },
        }),
      }),
    );
  });

  it('enforces source=IMPORT entity filter', async () => {
    mockDbAuditLogFindMany.mockResolvedValue([]);

    const customForm = { ...DEFAULT_FORM, source: 'IMPORT' as const };
    const req = createRequest('c1', customForm);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    expect(mockDbAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entity: { in: ['BankStatement'] },
        }),
      }),
    );
  });

  it('enforces source=APPLY_ALL entity filter', async () => {
    mockDbAuditLogFindMany.mockResolvedValue([]);

    const customForm = { ...DEFAULT_FORM, source: 'APPLY_ALL' as const };
    const req = createRequest('c1', customForm);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    expect(mockDbAuditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entity: { in: ['ApplyAllBatch'] },
        }),
      }),
    );
  });

  it('applies trustPolicy=TRUSTED_ONLY via reader aggregation', async () => {
    mockDbAuditLogFindMany.mockResolvedValue([
      v1ImportRecord(),
      v0ImportRecord(),
    ]);

    const customForm = { ...DEFAULT_FORM, trustPolicy: 'TRUSTED_ONLY' as const };
    const req = createRequest('c1', customForm);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body: CanonicalReadiness = await res.json();
    expect(body.metrics.trustedBatches).toBe(1);
    expect(body.metrics.legacyBatches).toBe(1);
    expect(body.metrics.totalEvaluated).toBe(50);
  });

  it('includes LEGACY data with INCLUDE_LEGACY_IMPORT', async () => {
    mockDbAuditLogFindMany.mockResolvedValue([
      v1ImportRecord(),
      v0ImportRecord(),
    ]);

    const customForm = { ...DEFAULT_FORM, trustPolicy: 'INCLUDE_LEGACY_IMPORT' as const };
    const req = createRequest('c1', customForm);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body: CanonicalReadiness = await res.json();
    expect(body.metrics.batches).toBe(2);
    expect(body.metrics.totalEvaluated).toBe(80);
  });

  it('includes LEGACY_UNTRUSTED only with INCLUDE_UNTRUSTED_HISTORY', async () => {
    mockDbAuditLogFindMany.mockResolvedValue([
      v1ImportRecord(),
      v0ApplyAllRecord(),
    ]);

    const customForm = { ...DEFAULT_FORM, trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' as const };
    const req = createRequest('c1', customForm);
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const body: CanonicalReadiness = await res.json();
    expect(body.metrics.batches).toBe(2);
    expect(body.metrics.legacyUntrustedBatches).toBe(1);
    expect(body.metrics.totalEvaluated).toBe(70);
  });

  it('propagates reader errors as 500', async () => {
    mockDbAuditLogFindMany.mockRejectedValue(new Error('database connection failed'));

    const req = createRequest('c1');
    const res = await GET(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
  });
});
