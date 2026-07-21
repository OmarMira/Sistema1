import { ValidationError } from '@/lib/api-error';
import type { ShadowMetricsQuery, ShadowMetricsTrustPolicy } from '@/lib/services/shadow-metrics-reader';
import type { ReadinessCriteria } from '@/lib/services/canonical-readiness-service';

const VALID_SOURCES = ['IMPORT', 'APPLY_ALL', 'ALL'] as const;
const VALID_TRUST_POLICIES = ['TRUSTED_ONLY', 'INCLUDE_LEGACY_IMPORT', 'INCLUDE_UNTRUSTED_HISTORY'] as const;

export interface ParsedReadinessRequest {
  metricsQuery: ShadowMetricsQuery;
  criteria: ReadinessCriteria;
}

function parseRequiredDate(value: string | null, label: string): Date {
  if (value === null) {
    throw new ValidationError(`${label} query param is required`);
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new ValidationError(`Invalid ${label}: "${value}" is not a valid date`);
  }
  return d;
}

function parseRequiredNumber(value: string | null, label: string): number {
  if (value === null) {
    throw new ValidationError(`${label} query param is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  return n;
}

export function parseReadinessQuery(params: URLSearchParams): ParsedReadinessRequest {
  const companyId = params.get('companyId');
  if (!companyId) {
    throw new ValidationError('companyId query param is required');
  }

  const sourceParam = params.get('source') ?? 'ALL';
  if (!VALID_SOURCES.includes(sourceParam as typeof VALID_SOURCES[number])) {
    throw new ValidationError(`Invalid source: "${sourceParam}". Valid values: ${VALID_SOURCES.join(', ')}`);
  }

  const trustPolicyParam = params.get('trustPolicy');
  if (trustPolicyParam !== null && !VALID_TRUST_POLICIES.includes(trustPolicyParam as typeof VALID_TRUST_POLICIES[number])) {
    throw new ValidationError(`Invalid trustPolicy: "${trustPolicyParam}". Valid values: ${VALID_TRUST_POLICIES.join(', ')}`);
  }

  const from = parseRequiredDate(params.get('from'), 'from');
  const to = parseRequiredDate(params.get('to'), 'to');
  if (from > to) {
    throw new ValidationError('from date must be before or equal to to date');
  }

  const trustPolicy: ShadowMetricsTrustPolicy = (trustPolicyParam ?? 'INCLUDE_LEGACY_IMPORT') as ShadowMetricsTrustPolicy;

  const minimumEvaluatedTransactions = parseRequiredNumber(params.get('minimumEvaluatedTransactions'), 'minimumEvaluatedTransactions');
  const minimumBatches = parseRequiredNumber(params.get('minimumBatches'), 'minimumBatches');
  const minimumAgreementRate = parseRequiredNumber(params.get('minimumAgreementRate'), 'minimumAgreementRate');
  const maximumDivergenceRate = parseRequiredNumber(params.get('maximumDivergenceRate'), 'maximumDivergenceRate');
  const maximumAmbiguityRate = parseRequiredNumber(params.get('maximumAmbiguityRate'), 'maximumAmbiguityRate');
  const maximumErrorRate = parseRequiredNumber(params.get('maximumErrorRate'), 'maximumErrorRate');
  const maximumInvalidRecordRate = parseRequiredNumber(params.get('maximumInvalidRecordRate'), 'maximumInvalidRecordRate');

  const metricsQuery: ShadowMetricsQuery = {
    companyId,
    source: sourceParam as 'IMPORT' | 'APPLY_ALL' | 'ALL',
    from,
    to,
    trustPolicy,
  };

  const criteria: ReadinessCriteria = {
    sample: { minimumEvaluatedTransactions, minimumBatches },
    quality: { minimumAgreementRate, maximumDivergenceRate, maximumAmbiguityRate },
    integrity: { maximumErrorRate, maximumInvalidRecordRate },
  };

  return { metricsQuery, criteria };
}
