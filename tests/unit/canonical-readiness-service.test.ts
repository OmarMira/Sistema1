import { describe, it, expect, vi } from 'vitest';
import {
  evaluateCanonicalReadiness,
  validateReadinessCriteria,
} from '@/lib/services/canonical-readiness-service';
import type {
  CanonicalReadiness,
  ReadinessCriteria,
  ShadowMetricsProvider,
} from '@/lib/services/canonical-readiness-service';
import type { ShadowMetricsQuery, ShadowMetricsReport } from '@/lib/services/shadow-metrics-reader';
import { ValidationError } from '@/lib/api-error';

function makeReport(overrides?: Partial<ShadowMetricsReport>): ShadowMetricsReport {
  return {
    batches: 10,
    trustedBatches: 8,
    legacyBatches: 2,
    legacyUntrustedBatches: 0,
    invalidRecords: 0,
    totalEvaluated: 500,
    validComparisons: 480,
    sameDecision: 460,
    divergentDecision: 15,
    ambiguous: 5,
    errors: 0,
    agreementRate: 0.9583,
    divergenceRate: 0.0313,
    ambiguityRate: 0.0104,
    errorRate: 0,
    reasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
    ...overrides,
  };
}

function makeCriteria(overrides?: Partial<ReadinessCriteria>): ReadinessCriteria {
  return {
    sample: { minimumEvaluatedTransactions: 100, minimumBatches: 3 },
    quality: { minimumAgreementRate: 0.95, maximumDivergenceRate: 0.05, maximumAmbiguityRate: 0.02 },
    integrity: { maximumErrorRate: 0.01, maximumInvalidRecordRate: 0.05 },
    ...overrides,
  };
}

function makeQuery(overrides?: Partial<ShadowMetricsQuery>): ShadowMetricsQuery {
  return {
    companyId: 'c1',
    source: 'ALL',
    from: new Date('2025-01-01'),
    to: new Date('2025-02-01'),
    trustPolicy: 'TRUSTED_ONLY',
    ...overrides,
  } as ShadowMetricsQuery;
}

function createMockProvider(report: ShadowMetricsReport): ShadowMetricsProvider {
  return { read: vi.fn().mockResolvedValue(report) };
}

const DEFAULT_REPORT = makeReport();
const DEFAULT_CRITERIA = makeCriteria();
const DEFAULT_QUERY = makeQuery();

describe('validateReadinessCriteria', () => {
  it('passes for valid criteria', () => {
    expect(() => validateReadinessCriteria(DEFAULT_CRITERIA)).not.toThrow();
  });

  const sampleFields = ['minimumEvaluatedTransactions', 'minimumBatches'] as const;
  for (const field of sampleFields) {
    it(`throws for negative ${field}`, () => {
      expect(() => validateReadinessCriteria(makeCriteria({ sample: { ...DEFAULT_CRITERIA.sample, [field]: -1 } })))
        .toThrow(ValidationError);
    });

    it(`throws for NaN ${field}`, () => {
      expect(() => validateReadinessCriteria(makeCriteria({ sample: { ...DEFAULT_CRITERIA.sample, [field]: NaN } })))
        .toThrow(ValidationError);
    });

    it(`throws for Infinity ${field}`, () => {
      expect(() => validateReadinessCriteria(makeCriteria({ sample: { ...DEFAULT_CRITERIA.sample, [field]: Infinity } })))
        .toThrow(ValidationError);
    });
  }

  const rateGroups = [
    { group: 'quality' as const, fields: ['minimumAgreementRate', 'maximumDivergenceRate', 'maximumAmbiguityRate'] as const },
    { group: 'integrity' as const, fields: ['maximumErrorRate', 'maximumInvalidRecordRate'] as const },
  ];

  for (const { group, fields } of rateGroups) {
    for (const field of fields) {
      it(`throws for NaN ${group}.${field}`, () => {
        const overrides: Partial<ReadinessCriteria> = { [group]: { ...DEFAULT_CRITERIA[group], [field]: NaN } as any };
        expect(() => validateReadinessCriteria(makeCriteria(overrides))).toThrow(ValidationError);
      });

      it(`throws for Infinity ${group}.${field}`, () => {
        const overrides = { [group]: { ...DEFAULT_CRITERIA[group], [field]: Infinity } as any };
        expect(() => validateReadinessCriteria(makeCriteria(overrides))).toThrow(ValidationError);
      });

      it(`throws for ${group}.${field} < 0`, () => {
        const overrides = { [group]: { ...DEFAULT_CRITERIA[group], [field]: -0.1 } as any };
        expect(() => validateReadinessCriteria(makeCriteria(overrides))).toThrow(ValidationError);
      });

      it(`throws for ${group}.${field} > 1`, () => {
        const overrides = { [group]: { ...DEFAULT_CRITERIA[group], [field]: 1.001 } as any };
        expect(() => validateReadinessCriteria(makeCriteria(overrides))).toThrow(ValidationError);
      });
    }
  }
});

describe('evaluateCanonicalReadiness', () => {
  describe('READY', () => {
    it('returns READY when all checks pass', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.status).toBe('READY');
    });
  });

  describe('NOT_READY', () => {
    it('returns NOT_READY when agreement rate is too low', async () => {
      const provider = createMockProvider(makeReport({ agreementRate: 0.90 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      expect(result.failedChecks.some(c => c.code === 'MINIMUM_AGREEMENT_RATE')).toBe(true);
    });

    it('returns NOT_READY when divergence rate is too high', async () => {
      const provider = createMockProvider(makeReport({ divergenceRate: 0.10 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      expect(result.failedChecks.some(c => c.code === 'MAXIMUM_DIVERGENCE_RATE')).toBe(true);
    });

    it('returns NOT_READY when ambiguity rate is too high', async () => {
      const provider = createMockProvider(makeReport({ ambiguityRate: 0.05 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      expect(result.failedChecks.some(c => c.code === 'MAXIMUM_AMBIGUITY_RATE')).toBe(true);
    });

    it('returns NOT_READY when error rate is too high', async () => {
      const provider = createMockProvider(makeReport({ errorRate: 0.02 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      expect(result.failedChecks.some(c => c.code === 'MAXIMUM_ERROR_RATE')).toBe(true);
    });

    it('returns NOT_READY when invalid record rate is too high', async () => {
      const provider = createMockProvider(makeReport({ invalidRecords: 3 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      expect(result.failedChecks.some(c => c.code === 'MAXIMUM_INVALID_RECORD_RATE')).toBe(true);
    });

    it('returns NOT_READY when all quality/integrity checks fail', async () => {
      const provider = createMockProvider(makeReport({
        agreementRate: 0.50,
        divergenceRate: 0.30,
        ambiguityRate: 0.20,
        errorRate: 0.15,
        invalidRecords: 10,
      }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      expect(result.failedChecks.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('INSUFFICIENT_DATA', () => {
    it('returns INSUFFICIENT_DATA when evaluated transactions are too few', async () => {
      const provider = createMockProvider(makeReport({ totalEvaluated: 50 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.status).toBe('INSUFFICIENT_DATA');
    });

    it('returns INSUFFICIENT_DATA when batches are too few', async () => {
      const provider = createMockProvider(makeReport({ batches: 1 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.status).toBe('INSUFFICIENT_DATA');
    });

    it('returns INSUFFICIENT_DATA when both sample checks fail', async () => {
      const provider = createMockProvider(makeReport({ totalEvaluated: 5, batches: 1 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.status).toBe('INSUFFICIENT_DATA');
    });

    it('reasons are derived only from sample checks', async () => {
      const provider = createMockProvider(makeReport({ totalEvaluated: 5, batches: 1 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertInsufficientData(result);
      expect(result.reasons.length).toBe(2);
      expect(result.reasons[0]).toContain('MINIMUM_EVALUATED_TRANSACTIONS');
      expect(result.reasons[1]).toContain('MINIMUM_BATCHES');
    });
  });

  describe('precedence', () => {
    it('INSUFFICIENT_DATA has absolute priority over NOT_READY', async () => {
      const provider = createMockProvider(makeReport({
        totalEvaluated: 5,
        batches: 1,
        agreementRate: 0.50,
        divergenceRate: 0.30,
      }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.status).toBe('INSUFFICIENT_DATA');
    });
  });

  describe('null rates', () => {
    it('null agreementRate produces passed: false and does NOT cause INSUFFICIENT_DATA', async () => {
      const provider = createMockProvider(makeReport({ agreementRate: null }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      const check = result.failedChecks.find(c => c.code === 'MINIMUM_AGREEMENT_RATE')!;
      expect(check.passed).toBe(false);
      expect(check.actual).toBeNull();
    });

    it('null divergenceRate produces passed: false', async () => {
      const provider = createMockProvider(makeReport({ divergenceRate: null }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      const check = result.failedChecks.find(c => c.code === 'MAXIMUM_DIVERGENCE_RATE')!;
      expect(check.passed).toBe(false);
      expect(check.actual).toBeNull();
    });

    it('null ambiguityRate produces passed: false', async () => {
      const provider = createMockProvider(makeReport({ ambiguityRate: null }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      const check = result.failedChecks.find(c => c.code === 'MAXIMUM_AMBIGUITY_RATE')!;
      expect(check.passed).toBe(false);
      expect(check.actual).toBeNull();
    });

    it('null errorRate produces passed: false', async () => {
      const provider = createMockProvider(makeReport({ errorRate: null }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      const check = result.failedChecks.find(c => c.code === 'MAXIMUM_ERROR_RATE')!;
      expect(check.passed).toBe(false);
      expect(check.actual).toBeNull();
    });
  });

  describe('invalidRecordRate', () => {
    it('is computed as invalidRecords / batches when batches > 0', async () => {
      const provider = createMockProvider(makeReport({ invalidRecords: 2, batches: 4 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      const check = result.checks.find(c => c.code === 'MAXIMUM_INVALID_RECORD_RATE')!;
      expect(check.actual).toBe(0.5);
    });

    it('is null when batches === 0', async () => {
      const provider = createMockProvider(makeReport({ invalidRecords: 0, batches: 0 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      const check = result.checks.find(c => c.code === 'MAXIMUM_INVALID_RECORD_RATE')!;
      expect(check.actual).toBeNull();
      expect(check.passed).toBe(false);
    });

    it('null invalidRecordRate with batches=0 produces passed: false and INSUFFICIENT_DATA', async () => {
      const provider = createMockProvider(makeReport({ invalidRecords: 0, batches: 0 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.status).toBe('INSUFFICIENT_DATA');
      const check = result.checks.find(c => c.code === 'MAXIMUM_INVALID_RECORD_RATE')!;
      expect(check.actual).toBeNull();
      expect(check.passed).toBe(false);
      expect(result.checks.every(c => c.code !== 'MAXIMUM_INVALID_RECORD_RATE' || !c.passed)).toBe(true);
    });
  });

  describe('provider interaction', () => {
    it('does NOT call provider.read when criteria is invalid', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      try {
        await evaluateCanonicalReadiness(DEFAULT_QUERY, makeCriteria({ sample: { minimumEvaluatedTransactions: -1, minimumBatches: 3 } }), provider);
      } catch { /* expected */ }
      expect(provider.read).not.toHaveBeenCalled();
    });

    it('calls provider.read exactly once for valid criteria', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(provider.read).toHaveBeenCalledTimes(1);
    });

    it('forwards the exact query and trustPolicy to provider', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      const query = makeQuery({ companyId: 'special-c1', trustPolicy: 'INCLUDE_LEGACY_IMPORT' as any });
      await evaluateCanonicalReadiness(query, DEFAULT_CRITERIA, provider);
      expect(provider.read).toHaveBeenCalledWith(query);
    });

    it('propagates provider errors uncaught', async () => {
      const provider: ShadowMetricsProvider = { read: vi.fn().mockRejectedValue(new Error('db down')) };
      await expect(evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider)).rejects.toThrow('db down');
    });
  });

  describe('reference identity and immutability', () => {
    it('returned metrics is the same reference from provider', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.metrics).toBe(DEFAULT_REPORT);
    });

    it('metrics is not mutated', async () => {
      const frozen = Object.freeze(makeReport());
      const provider = createMockProvider(frozen);
      await expect(evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider)).resolves.not.toThrow();
    });
  });

  describe('operator correctness', () => {
    const operatorMap: Record<string, string> = {
      MINIMUM_EVALUATED_TRANSACTIONS: '>=',
      MINIMUM_BATCHES: '>=',
      MINIMUM_AGREEMENT_RATE: '>=',
      MAXIMUM_DIVERGENCE_RATE: '<=',
      MAXIMUM_AMBIGUITY_RATE: '<=',
      MAXIMUM_ERROR_RATE: '<=',
      MAXIMUM_INVALID_RECORD_RATE: '<=',
    };

    for (const [code, expectedOp] of Object.entries(operatorMap)) {
      it(`${code} has operator ${expectedOp}`, async () => {
        const provider = createMockProvider(DEFAULT_REPORT);
        const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
        const check = result.checks.find(c => c.code === code)!;
        expect(check.operator).toBe(expectedOp);
      });
    }
  });

  describe('check order stability', () => {
    it('checks order follows sample → quality → integrity', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      const codes = result.checks.map(c => c.code);
      const expectedOrder = [
        'MINIMUM_EVALUATED_TRANSACTIONS',
        'MINIMUM_BATCHES',
        'MINIMUM_AGREEMENT_RATE',
        'MAXIMUM_DIVERGENCE_RATE',
        'MAXIMUM_AMBIGUITY_RATE',
        'MAXIMUM_ERROR_RATE',
        'MAXIMUM_INVALID_RECORD_RATE',
      ];
      expect(codes).toEqual(expectedOrder);
    });
  });

  describe('failedChecks invariant', () => {
    it('failedChecks equals checks.filter(c => !c.passed) for NOT_READY', async () => {
      const provider = createMockProvider(makeReport({ agreementRate: 0.50 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      assertNotReady(result);
      expect(result.failedChecks).toEqual(result.checks.filter(c => !c.passed));
    });

    it('failedChecks does not exist in READY', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.status).toBe('READY');
      expect('failedChecks' in result).toBe(false);
    });

    it('failedChecks does not exist in INSUFFICIENT_DATA', async () => {
      const provider = createMockProvider(makeReport({ totalEvaluated: 5 }));
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.status).toBe('INSUFFICIENT_DATA');
      expect('failedChecks' in result).toBe(false);
    });
  });

  describe('checks always 7', () => {
    it('returns exactly 7 checks', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      expect(result.checks).toHaveLength(7);
    });

    it('each ReadinessCheckCode appears exactly once', async () => {
      const provider = createMockProvider(DEFAULT_REPORT);
      const result = await evaluateCanonicalReadiness(DEFAULT_QUERY, DEFAULT_CRITERIA, provider);
      const codes = result.checks.map(c => c.code);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(7);
      expect(codes.length).toBe(uniqueCodes.size);
    });
  });
});

function assertNotReady(r: CanonicalReadiness): asserts r is CanonicalReadiness & { status: 'NOT_READY'; failedChecks: any[] } {
  expect(r.status).toBe('NOT_READY');
}

function assertInsufficientData(r: CanonicalReadiness): asserts r is CanonicalReadiness & { status: 'INSUFFICIENT_DATA'; reasons: string[] } {
  expect(r.status).toBe('INSUFFICIENT_DATA');
}
