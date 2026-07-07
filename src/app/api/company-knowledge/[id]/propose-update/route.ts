import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { proposeUpdate } from '@/internal/company-knowledge';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const { companyId } = requireCompanyContext();

  const body = await request.json();
  try {
    const pending = await proposeUpdate({
      knowledgeId: id,
      companyId,
      updates: body.updates,
      requestedBy: body.requestedBy,
    });
    return NextResponse.json({ pendingApprovalId: pending.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
