import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { ValidationError } from '@/lib/api-error';
import { ShadowMetricsReader } from '@/lib/services/shadow-metrics-reader';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
import { evaluateCanonicalReadiness } from '@/lib/services/canonical-readiness-service';
import type { ReadinessCriteria } from '@/lib/services/canonical-readiness-service';
import type { ShadowMetricsQuery, ShadowMetricsTrustPolicy } from '@/lib/services/shadow-metrics-reader';

const VALID_SOURCES = ['IMPORT', 'APPLY_ALL', 'ALL'] as const;
const VALID_TRUST_POLICIES = ['TRUSTED_ONLY', 'INCLUDE_LEGACY_IMPORT', 'INCLUDE_UNTRUSTED_HISTORY'] as const;

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

export const GET = apiHandler(
  async (request: NextRequest) => {
    const { searchParams } = request.nextUrl;

    const companyId = searchParams.get('companyId');
    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId query param is required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      );
    }

    const sourceParam = searchParams.get('source') ?? 'ALL';
    if (!VALID_SOURCES.includes(sourceParam as typeof VALID_SOURCES[number])) {
      return NextResponse.json(
        { error: `Invalid source: "${sourceParam}". Valid values: ${VALID_SOURCES.join(', ')}`, code: 'VALIDATION_ERROR' },
        { status: 400 },
      );
    }

    const trustPolicyParam = searchParams.get('trustPolicy');
    if (trustPolicyParam !== null && !VALID_TRUST_POLICIES.includes(trustPolicyParam as typeof VALID_TRUST_POLICIES[number])) {
      return NextResponse.json(
        { error: `Invalid trustPolicy: "${trustPolicyParam}". Valid values: ${VALID_TRUST_POLICIES.join(', ')}`, code: 'VALIDATION_ERROR' },
        { status: 400 },
      );
    }

    const from = parseRequiredDate(searchParams.get('from'), 'from');
    const to = parseRequiredDate(searchParams.get('to'), 'to');
    if (from > to) {
      throw new ValidationError('from date must be before or equal to to date');
    }

    const trustPolicy: ShadowMetricsTrustPolicy = (trustPolicyParam ?? 'INCLUDE_LEGACY_IMPORT') as ShadowMetricsTrustPolicy;

    const minimumEvaluatedTransactions = parseRequiredNumber(searchParams.get('minimumEvaluatedTransactions'), 'minimumEvaluatedTransactions');
    const minimumBatches = parseRequiredNumber(searchParams.get('minimumBatches'), 'minimumBatches');
    const minimumAgreementRate = parseRequiredNumber(searchParams.get('minimumAgreementRate'), 'minimumAgreementRate');
    const maximumDivergenceRate = parseRequiredNumber(searchParams.get('maximumDivergenceRate'), 'maximumDivergenceRate');
    const maximumAmbiguityRate = parseRequiredNumber(searchParams.get('maximumAmbiguityRate'), 'maximumAmbiguityRate');
    const maximumErrorRate = parseRequiredNumber(searchParams.get('maximumErrorRate'), 'maximumErrorRate');
    const maximumInvalidRecordRate = parseRequiredNumber(searchParams.get('maximumInvalidRecordRate'), 'maximumInvalidRecordRate');

    const query: ShadowMetricsQuery = {
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

    const repo = new PrismaAuditLogRepository(db);
    const reader = new ShadowMetricsReader(repo);
    const result = await evaluateCanonicalReadiness(query, criteria, reader);

    return NextResponse.json(result);
  },
  { requireSuperAdmin: true, requireMembership: false },
);
