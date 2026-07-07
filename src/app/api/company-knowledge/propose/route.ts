import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { proposeCreate } from '@/internal/company-knowledge';

export const POST = apiHandler(async (request: NextRequest, _context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  const body = await request.json();
  try {
    const pending = await proposeCreate({
      ...body,
      companyId,
      requestedBy: body.requestedBy || 'system',
    });
    return NextResponse.json({ pendingApprovalId: pending.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
