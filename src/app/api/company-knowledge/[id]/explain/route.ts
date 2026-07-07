import { NextRequest, NextResponse } from 'next/server';
import { getExplainabilityPayload, getAuditTrail } from '@/internal/company-knowledge/audit/service';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payload = await getExplainabilityPayload(id);
  if (!payload) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  const auditHistory = await getAuditTrail(id);
  return NextResponse.json({ ...payload, auditHistory });
}
