import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { saveContext } from '@/lib/services/entity-context-service';

import { logger } from '@/lib/logger';

// ─── Request Schema ───────────────────────────────────────────────────
const createEntitySchema = z.object({
  pattern: z.string().min(1).max(255),
  role: z.string().min(1),
  glAccountId: z.string().optional(),
});

// ─── POST /api/learning/entities ─────────────────────────────────────
// Create a new entity context manually.
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

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
  } catch (error: unknown) {
    logger.error('[POST ENTITY CREATE ERROR]', { error: String(error) });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
