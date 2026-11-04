import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { AppError } from '@/lib/api-error';
import { requireCompanyRole } from '@/lib/rbac';
import { rollbackEntityIdentity } from '@/internal/company-knowledge/entity/service';

// S9 — one-step undo of a CompanyKnowledge identity from the audit trail.
// Four-eyes pattern of 42d61f8: undoing a confirmed identity is an
// administrative act, so it is company_admin only (the entity service forces the
// audit actor from the session inside the same transaction).
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { id } = await context.params;
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  try {
    const record = await rollbackEntityIdentity({
      knowledgeId: id,
      companyId,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    return NextResponse.json({
      knowledgeId: record.id,
      canonicalName: record.canonicalName,
      aliases: record.aliases,
      version: record.version,
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
});
