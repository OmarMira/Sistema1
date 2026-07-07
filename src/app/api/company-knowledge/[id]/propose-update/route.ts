import { NextRequest, NextResponse } from 'next/server';
import { proposeUpdate } from '@/internal/company-knowledge';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  try {
    const pending = await proposeUpdate({ knowledgeId: id, companyId: body.companyId, updates: body.updates, requestedBy: body.requestedBy });
    return NextResponse.json({ pendingApprovalId: pending.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
