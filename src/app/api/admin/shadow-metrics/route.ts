import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { ShadowMetricsReader } from '@/lib/services/shadow-metrics-reader';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
import type { ShadowMetricsQuery, ShadowMetricsTrustPolicy } from '@/lib/services/shadow-metrics-reader';

/** @visibleForTesting */
export function parseDateOrError(value: string, label: string): Date | NextResponse {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return NextResponse.json(
      { error: `Invalid ${label}: "${value}" is not a valid date`, code: 'VALIDATION_ERROR' },
      { status: 400 },
    );
  }
  return d;
}

const VALID_SOURCES = ['IMPORT', 'APPLY_ALL', 'ALL'] as const;
const VALID_TRUST_POLICIES = ['TRUSTED_ONLY', 'INCLUDE_LEGACY_IMPORT', 'INCLUDE_UNTRUSTED_HISTORY'] as const;

function isErrorResponse(r: unknown): r is NextResponse {
  return r instanceof NextResponse;
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

    let from: Date;
    if (searchParams.has('from')) {
      const p = searchParams.get('from')!;
      const r = parseDateOrError(p, 'from');
      if (isErrorResponse(r)) return r;
      from = r;
    } else {
      from = new Date();
      from.setDate(from.getDate() - 90);
    }

    let to: Date;
    if (searchParams.has('to')) {
      const p = searchParams.get('to')!;
      const r = parseDateOrError(p, 'to');
      if (isErrorResponse(r)) return r;
      to = r;
    } else {
      to = new Date();
    }

    if (from > to) {
      return NextResponse.json(
        { error: 'from date must be before or equal to to date', code: 'VALIDATION_ERROR' },
        { status: 400 },
      );
    }

    const trustPolicy: ShadowMetricsTrustPolicy = (trustPolicyParam ?? 'INCLUDE_LEGACY_IMPORT') as ShadowMetricsTrustPolicy;

    const query: ShadowMetricsQuery = {
      companyId,
      source: sourceParam as 'IMPORT' | 'APPLY_ALL' | 'ALL',
      from,
      to,
      trustPolicy,
    };

    const repo = new PrismaAuditLogRepository(db);
    const reader = new ShadowMetricsReader(repo);
    const report = await reader.read(query);

    return NextResponse.json(report);
  },
  { requireSuperAdmin: true, requireMembership: false },
);
