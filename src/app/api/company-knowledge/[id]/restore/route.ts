import { NextRequest, NextResponse } from 'next/server';
import { restore } from '@/internal/company-knowledge';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  try {
    const record = await restore({ knowledgeId: id, companyId: body.companyId, changedByUserId: body.changedByUserId, reason: body.reason });
    return NextResponse.json({ knowledgeId: record.id, status: record.status, version: record.version });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
