import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { ValidationError } from '@/lib/api-error';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
import { ShadowMetricsReader } from '@/lib/services/shadow-metrics-reader';
import { db } from '@/lib/db';
import { parseReadinessQuery } from '@/lib/readiness/parse-readiness-query';
import { OBSERVATIONAL_POLICY_PROFILE } from '@/lib/operational-policy/observational-policy-profile';
import { evaluateOperationalPolicy } from '@/lib/operational-policy/policy-service';
import type { OperationalContext, OperationalPolicyInput } from '@/lib/operational-policy/types';

const VALID_CONTEXTS = ['APPLY_ALL', 'IMPORT', 'RECONCILIATION'] as const;

export const GET = apiHandler(
  async (request: NextRequest) => {
    const { metricsQuery, criteria } = parseReadinessQuery(request.nextUrl.searchParams);

    const contextParam = request.nextUrl.searchParams.get('context');
    if (!contextParam || !VALID_CONTEXTS.includes(contextParam as typeof VALID_CONTEXTS[number])) {
      throw new ValidationError('Invalid or missing context parameter');
    }

    const input: OperationalPolicyInput = {
      context: contextParam as OperationalContext,
      metricsQuery,
    };
    const profile = OBSERVATIONAL_POLICY_PROFILE;
    const repo = new PrismaAuditLogRepository(db);
    const provider = new ShadowMetricsReader(repo);

    const decision = await evaluateOperationalPolicy(input, criteria, provider, profile);
    return NextResponse.json(decision);
  },
  { requireSuperAdmin: true, requireMembership: false },
);
