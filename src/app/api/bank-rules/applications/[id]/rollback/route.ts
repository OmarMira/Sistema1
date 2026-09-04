import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { revertApplyRecord } from '@/lib/services/rollback-apply.service';

// ─── POST /api/bank-rules/applications/[id]/rollback ──────────────
// Reverts a covered rule application anchored by a durable RuleApplyRecord.
// Idempotent: returns { status: 'already-reverted' } on double invoke.
// All-or-nothing: if ANY affected transaction falls in a closed/locked
// fiscal period, the ENTIRE revert aborts.
//
// The authenticated userId is extracted from the request context — never
// from the client body — so the RULE_REVERTED audit event is reliably
// attributed to the actual actor.

export const POST = apiHandler(async (_request: NextRequest, context: RouteContext) => {
  const { companyId, userId } = await requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);
  const { id } = await context.params;
  const applicationId = id as string;

  const result = await revertApplyRecord(companyId, applicationId, userId);

  return NextResponse.json({ status: result.status });
});
