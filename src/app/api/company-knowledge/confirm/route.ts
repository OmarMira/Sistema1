import { NextRequest, NextResponse } from 'next/server';
import { confirmCreate } from '@/internal/company-knowledge';

export async function POST(request: NextRequest) {
  const body = await request.json();
  try {
    const record = await confirmCreate({ pendingApprovalId: body.pendingApprovalId, confirmedByUserId: body.confirmedByUserId });
    return NextResponse.json({ knowledgeId: record.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
