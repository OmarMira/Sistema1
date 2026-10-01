import { NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { resolveDecisionExplanation } from '@/lib/get-decision-explanation';

// §GAP9 — Minimal endpoint: return sanitized decision explanation for
// a single BankTransaction. Uses existing AuditLog provenance (Gap #8).
export const GET = apiHandler(async (_request: Request, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);
  const { id: transactionId } = await context.params;

  if (!transactionId || typeof transactionId !== 'string') {
    return NextResponse.json({ error: 'transactionId required' }, { status: 400 });
  }

  const explanation = await resolveDecisionExplanation(companyId, transactionId);

  return NextResponse.json({ explanation });
});
