import { NextRequest, NextResponse } from 'next/server';
import { proposeCreate } from '@/internal/company-knowledge';

export async function POST(request: NextRequest) {
  const body = await request.json();
  try {
    const pending = await proposeCreate({ ...body, requestedBy: body.requestedBy || 'system' });
    return NextResponse.json({ pendingApprovalId: pending.id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
