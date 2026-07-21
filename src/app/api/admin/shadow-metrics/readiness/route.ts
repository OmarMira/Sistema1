import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { ShadowMetricsReader } from '@/lib/services/shadow-metrics-reader';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
import { evaluateCanonicalReadiness } from '@/lib/services/canonical-readiness-service';
import { parseReadinessQuery } from '@/lib/readiness/parse-readiness-query';

export const GET = apiHandler(
  async (request: NextRequest) => {
    const { metricsQuery, criteria } = parseReadinessQuery(request.nextUrl.searchParams);

    const repo = new PrismaAuditLogRepository(db);
    const reader = new ShadowMetricsReader(repo);
    const result = await evaluateCanonicalReadiness(metricsQuery, criteria, reader);

    return NextResponse.json(result);
  },
  { requireSuperAdmin: true, requireMembership: false },
);
