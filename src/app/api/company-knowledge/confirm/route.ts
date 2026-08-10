import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { AppError } from '@/lib/api-error';
import { confirmCreate } from '@/internal/company-knowledge';

export const POST = apiHandler(async (request: NextRequest, _context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  const body = await request.json();
  try {
    const record = await confirmCreate({
      pendingApprovalId: body.pendingApprovalId,
      companyId,
    });
    return NextResponse.json({ knowledgeId: record.id });
  } catch (e) {
    if (e instanceof AppError) throw e;
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
