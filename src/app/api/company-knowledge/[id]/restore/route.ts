import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { restore } from '@/internal/company-knowledge';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const { companyId } = requireCompanyContext();

  const body = await request.json();
  try {
    const record = await restore({
      knowledgeId: id,
      companyId,
      changedByUserId: body.changedByUserId,
      reason: body.reason,
    });
    return NextResponse.json({ knowledgeId: record.id, status: record.status, version: record.version });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
