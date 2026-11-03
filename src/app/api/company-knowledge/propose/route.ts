import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { AppError } from '@/lib/api-error';
import { proposeCreate } from '@/internal/company-knowledge';

export const POST = apiHandler(async (request: NextRequest, _context: RouteContext) => {
  // Any company member may propose. requestedBy is derived from the session —
  // a client-supplied value is ignored so attribution cannot be forged (S21b).
  const { companyId, userId } = requireCompanyContext();

  const body = await request.json();
  try {
    const pending = await proposeCreate({
      ...body,
      companyId,
      requestedBy: userId,
    });
    return NextResponse.json({ pendingApprovalId: pending.id });
  } catch (e) {
    if (e instanceof AppError) throw e;
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
