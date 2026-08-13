import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { getExplainabilityPayload, getAuditTrail } from '@/internal/company-knowledge/audit/service';

export const GET = apiHandler(async (_request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const { companyId } = requireCompanyContext();

  const payload = await getExplainabilityPayload(id, companyId);
  if (!payload) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  const auditHistory = await getAuditTrail(id, companyId);
  return NextResponse.json({ ...payload, auditHistory });
});
