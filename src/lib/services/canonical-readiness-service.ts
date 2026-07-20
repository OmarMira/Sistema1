import type { ShadowMetricsReport, ShadowMetricsQuery } from './shadow-metrics-reader';
import { ValidationError } from '@/lib/api-error';

export interface SampleCriteria {
  minimumEvaluatedTransactions: number;
  minimumBatches: number;
}

export interface QualityCriteria {
  minimumAgreementRate: number;
  maximumDivergenceRate: number;
  maximumAmbiguityRate: number;
}

export interface IntegrityCriteria {
  maximumErrorRate: number;
  maximumInvalidRecordRate: number;
}

export interface ReadinessCriteria {
  sample: SampleCriteria;
  quality: QualityCriteria;
  integrity: IntegrityCriteria;
}

export type ReadinessCheckOperator = '>=' | '<=';

export type ReadinessCheckCode =
  | 'MINIMUM_EVALUATED_TRANSACTIONS'
  | 'MINIMUM_BATCHES'
  | 'MINIMUM_AGREEMENT_RATE'
  | 'MAXIMUM_DIVERGENCE_RATE'
  | 'MAXIMUM_AMBIGUITY_RATE'
  | 'MAXIMUM_ERROR_RATE'
  | 'MAXIMUM_INVALID_RECORD_RATE';

export interface ReadinessCheckResult {
  code: ReadinessCheckCode;
  operator: ReadinessCheckOperator;
  passed: boolean;
  actual: number | null;
  expected: number;
}

interface CanonicalReadinessBase {
  metrics: ShadowMetricsReport;
  checks: ReadinessCheckResult[];
}

export type CanonicalReadiness =
  | (CanonicalReadinessBase & { status: 'READY' })
  | (CanonicalReadinessBase & { status: 'NOT_READY'; failedChecks: ReadinessCheckResult[] })
  | (CanonicalReadinessBase & { status: 'INSUFFICIENT_DATA'; reasons: string[] });

export interface ShadowMetricsProvider {
  read(query: ShadowMetricsQuery): Promise<ShadowMetricsReport>;
}

function assertSampleField(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`Invalid sample criterion: ${name} must be a finite integer >= 0, got ${value}`);
  }
}

function assertRateField(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`Invalid rate criterion: ${name} must be a finite number in [0, 1], got ${value}`);
  }
}

export function validateReadinessCriteria(criteria: ReadinessCriteria): void {
  assertSampleField('minimumEvaluatedTransactions', criteria.sample.minimumEvaluatedTransactions);
  assertSampleField('minimumBatches', criteria.sample.minimumBatches);
  assertRateField('minimumAgreementRate', criteria.quality.minimumAgreementRate);
  assertRateField('maximumDivergenceRate', criteria.quality.maximumDivergenceRate);
  assertRateField('maximumAmbiguityRate', criteria.quality.maximumAmbiguityRate);
  assertRateField('maximumErrorRate', criteria.integrity.maximumErrorRate);
  assertRateField('maximumInvalidRecordRate', criteria.integrity.maximumInvalidRecordRate);
}

function buildAllChecks(
  report: ShadowMetricsReport,
  criteria: ReadinessCriteria,
): ReadinessCheckResult[] {
  const invalidRecordRate = report.batches > 0 ? report.invalidRecords / report.batches : null;

  const checks: ReadinessCheckResult[] = [
    buildCheck('MINIMUM_EVALUATED_TRANSACTIONS', '>=', report.totalEvaluated, criteria.sample.minimumEvaluatedTransactions),
    buildCheck('MINIMUM_BATCHES', '>=', report.batches, criteria.sample.minimumBatches),
    buildCheck('MINIMUM_AGREEMENT_RATE', '>=', report.agreementRate, criteria.quality.minimumAgreementRate),
    buildCheck('MAXIMUM_DIVERGENCE_RATE', '<=', report.divergenceRate, criteria.quality.maximumDivergenceRate),
    buildCheck('MAXIMUM_AMBIGUITY_RATE', '<=', report.ambiguityRate, criteria.quality.maximumAmbiguityRate),
    buildCheck('MAXIMUM_ERROR_RATE', '<=', report.errorRate, criteria.integrity.maximumErrorRate),
    buildCheck('MAXIMUM_INVALID_RECORD_RATE', '<=', invalidRecordRate, criteria.integrity.maximumInvalidRecordRate),
  ];

  return checks;
}

function buildCheck(
  code: ReadinessCheckCode,
  operator: ReadinessCheckOperator,
  actual: number | null,
  expected: number,
): ReadinessCheckResult {
  const passed = actual !== null && (operator === '>=' ? actual >= expected : actual <= expected);
  return { code, operator, passed, actual, expected };
}

export async function evaluateCanonicalReadiness(
  query: ShadowMetricsQuery,
  criteria: ReadinessCriteria,
  provider: ShadowMetricsProvider,
): Promise<CanonicalReadiness> {
  validateReadinessCriteria(criteria);
  const report = await provider.read(query);
  const checks = buildAllChecks(report, criteria);

  const sampleCodes: ReadinessCheckCode[] = ['MINIMUM_EVALUATED_TRANSACTIONS', 'MINIMUM_BATCHES'];
  const failedSample = checks.filter(c => sampleCodes.includes(c.code) && !c.passed);

  if (failedSample.length > 0) {
    return {
      status: 'INSUFFICIENT_DATA',
      metrics: report,
      checks,
      reasons: failedSample.map(c => `${c.code}: expected ${c.operator} ${c.expected}, got ${c.actual}`),
    };
  }

  const failedChecks = checks.filter(c => !c.passed);
  if (failedChecks.length > 0) {
    return {
      status: 'NOT_READY',
      metrics: report,
      checks,
      failedChecks,
    };
  }

  return {
    status: 'READY',
    metrics: report,
    checks,
  };
}
