import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { merge } from '@/internal/company-knowledge';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const { companyId } = requireCompanyContext();

  const body = await request.json();

  if (!body.sourceKnowledgeId) {
    return NextResponse.json({ error: 'sourceKnowledgeId is required' }, { status: 400 });
  }

  if (body.sourceKnowledgeId === id) {
    return NextResponse.json({ error: 'Cannot merge an entity into itself' }, { status: 400 });
  }

  try {
    const record = await merge({
      sourceKnowledgeId: body.sourceKnowledgeId,
      targetKnowledgeId: id,
      companyId,
      fieldResolutions: body.fieldResolutions,
      changedByUserId: body.changedByUserId,
    });
    return NextResponse.json({ knowledgeId: record.id, version: record.version });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
