import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { confirmCreate } from '@/internal/company-knowledge';

export const POST = apiHandler(async (request: NextRequest, _context: RouteContext) => {
  requireCompanyContext();

  const body = await request.json();
  try {
    const record = await confirmCreate({
      pendingApprovalId: body.pendingApprovalId,
      confirmedByUserId: body.confirmedByUserId,
    });
    return NextResponse.json({ knowledgeId: record.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
