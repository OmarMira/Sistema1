import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { requireCompanyContext, requireCurrentUserId } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { rollbackAutomationDecision } from '@/lib/rollback-automation';

// §GAP10 Block C — HUMAN CONTROL BOUNDARY for the certified rollback core.
//
// Authentication: apiHandler resolves the session (401 without one) and
// validates tenant membership for the declared companyId. actorUserId is
// taken EXCLUSIVELY from the authenticated session context — the request
// body is never an authority for identity, companyId, provenance, or any
// rollback outcome flag (those fields are not read here at all).
//
// No automatic AI path reaches this endpoint: no importer, rule engine,
// AI proposal flow, or background automation references rollbackAutomationDecision
// (verified by call-site search). Rollback runs only on this explicit POST.
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  const actorUserId = requireCurrentUserId();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);
  await requireModuleEntitlement('banking');
  const { id: transactionId } = await context.params;

  if (!transactionId || typeof transactionId !== 'string') {
    return NextResponse.json({ error: 'transactionId required' }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  }
  const correctedGlAccountId =
    typeof body.correctedGlAccountId === 'string' && body.correctedGlAccountId.trim() !== ''
      ? body.correctedGlAccountId.trim()
      : undefined;

  try {
    const rollback = await rollbackAutomationDecision({
      companyId,
      transactionId,
      actorUserId,
      correctedGlAccountId,
      reason,
    });
    return NextResponse.json({ rollback });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    // Fail-closed core errors are surfaced truthfully — never as success.
    if (message.startsWith('ROLLBACK_FAIL_CLOSED: transaction not found')) {
      // Do not disclose whether the transaction exists in another tenant.
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }
    if (message.startsWith('ROLLBACK_FAIL_CLOSED: RULE provenance missing matchedRuleId')) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    if (message.startsWith('ROLLBACK_FAIL_CLOSED: missing required identity')) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (message.startsWith('ROLLBACK_FAIL_CLOSED: reclassifyTransaction rejected')) {
      const notFound = message.includes('TRANSACTION_NOT_FOUND') || message.includes('GL_ACCOUNT_NOT_FOUND');
      return NextResponse.json({ error: message }, { status: notFound ? 404 : 400 });
    }
    // AppError subclasses (e.g. fiscal-period ForbiddenError) and unexpected
    // errors follow the project's existing apiHandler mapping.
    throw error;
  }
});
