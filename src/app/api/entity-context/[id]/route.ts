import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import {
  updateEntityContext,
  removeEntityContext,
} from '@/lib/services/entity-context-crud-service';
import { logger } from '@/lib/logger';

// ─── PATCH /api/entity-context/[id] ───────────────────────────────────
// Update entity context (role, glAccountId, roles)
export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);
  const params = await context.params;
  const id = params.id as string;

  try {
    const body = await request.json();
    const { role, roles, transactionDirection } = body as {
      role?: string;
      roles?: string[];
      transactionDirection?: string | null;
    };

    // At least one field must be provided
    if (role === undefined && roles === undefined && transactionDirection === undefined) {
      return NextResponse.json(
        { error: 'At least one field (role, roles, transactionDirection) is required' },
        { status: 400 },
      );
    }

    const updated = await updateEntityContext(companyId, id, { role, roles, transactionDirection });

    if (!updated) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[PATCH ENTITY CONTEXT ERROR]', { error: errorMessage, id });
    return NextResponse.json({ error: 'Failed to update entity' }, { status: 500 });
  }
});

// ─── DELETE /api/entity-context/[id] ──────────────────────────────────
// Delete single entity context
export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);
  const params = await context.params;
  const id = params.id as string;

  try {
    const deleted = await removeEntityContext(companyId, id);

    if (!deleted) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[DELETE ENTITY CONTEXT ERROR]', { error: String(error), id });
    return NextResponse.json({ error: 'Failed to delete entity' }, { status: 500 });
  }
});
