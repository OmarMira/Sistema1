import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { saveContext } from '@/lib/services/entity-context-service';
import { handleRouteError } from '@/lib/route-error-handler';

// ─── Request Schema ───────────────────────────────────────────────────
const createEntitySchema = z.object({
  pattern: z.string().min(1).max(255),
  role: z.string().min(1),
  glAccountId: z.string().optional(),
});

// ─── POST /api/learning/entities ─────────────────────────────────────
// Create a new entity context manually.
export const POST = apiHandler(async (request: NextRequest, _routeCtx: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);

  try {
    const body = await request.json();
    const parsed = createEntitySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { pattern, role, glAccountId } = parsed.data;

    // Duplicate check: pattern + companyId must be unique
    const existing = await db.entityContext.findFirst({
      where: { companyId, pattern },
    });
    if (existing) {
      return NextResponse.json(
        { error: 'Entity with this pattern already exists' },
        { status: 409 },
      );
    }

    const context = await saveContext({
      companyId,
      pattern,
      role,
      glAccountId: glAccountId ?? null,
      source: 'user',
      userId,
    });

    return NextResponse.json({ success: true, data: context }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, '[POST ENTITY CREATE ERROR]');
  }
});
