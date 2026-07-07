import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { findContext, saveContext } from '@/lib/services/entity-context-service';
import { entityContextSchema } from '@/lib/validations/entity-context';
import { logger } from '@/lib/logger';

// ─── GET /api/learning/context ──────────────────────────────────────
// Retrieve the entity context for a description.
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const description = searchParams.get('description') || searchParams.get('pattern');

  if (!description) {
    return NextResponse.json({ error: 'companyId and description are required' }, { status: 400 });
  }

  try {
    const context = await findContext(companyId, description);
    return NextResponse.json({ data: context });
  } catch (error) {
    logger.error('[GET ENTITY CONTEXT ERROR]', { error: String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

// ─── POST /api/learning/context ─────────────────────────────────────
// Save or update an entity context.
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    const body = await request.json();
    const parsed = entityContextSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { pattern, role, glAccountId } = parsed.data;

    // If glAccountId is provided, verify it exists and is active
    if (glAccountId) {
      const glAccount = await db.glAccount.findFirst({
        where: { id: glAccountId, companyId, isActive: true },
      });
      if (!glAccount) {
        return NextResponse.json({ error: 'GL Account not found or inactive' }, { status: 400 });
      }
    }

    const context = await saveContext({
      companyId,
      pattern,
      role,
      glAccountId: glAccountId || null,
      source: 'user',
      userId,
    });

    return NextResponse.json({ success: true, data: context });
  } catch (error: unknown) {
    logger.error('[POST ENTITY CONTEXT ERROR]', { error: String(error) });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
