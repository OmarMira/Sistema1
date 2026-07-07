import { NextRequest, NextResponse } from 'next/server';
import { merge } from '@/internal/company-knowledge';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  try {
    const record = await merge({ sourceKnowledgeId: id, targetKnowledgeId: body.targetKnowledgeId, companyId: body.companyId, fieldResolutions: body.fieldResolutions, changedByUserId: body.changedByUserId });
    return NextResponse.json({ knowledgeId: record.id, version: record.version });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
