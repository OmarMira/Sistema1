import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { AppError } from '@/lib/api-error';
import { requireCompanyRole } from '@/lib/rbac';
import { proposeUpdate } from '@/internal/company-knowledge';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  // Any company member may propose. requestedBy is derived from the session —
  // a client-supplied value is ignored so attribution cannot be forged (S21b).
  const { companyId, userId } = requireCompanyContext();

  const body = await request.json();
  try {
    const pending = await proposeUpdate({
      knowledgeId: id,
      companyId,
      updates: body.updates,
      requestedBy: userId,
    });
    return NextResponse.json({ pendingApprovalId: pending.id });
  } catch (e) {
    if (e instanceof AppError) throw e;
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
