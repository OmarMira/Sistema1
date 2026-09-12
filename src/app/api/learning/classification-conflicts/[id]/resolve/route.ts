import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { safeAuditLog } from '@/lib/services/audit-service';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { handleRouteError } from '@/lib/route-error-handler';
import {
  createAdapter,
  resolveClassificationConflict,
} from '@/memory/classification-knowledge';

const INVALID_INPUT_ERROR = 'conflictItemId and resolutionReason are required';

/**
 * POST /api/learning/classification-conflicts/[id]/resolve
 *
 * Records an explicit HUMAN resolution of a pending classification conflict.
 *
 * - conflictItemId from the route param; resolutionReason from the body.
 * - resolvedBy ALWAYS comes from the authenticated session — never accepted
 *   from the request body.
 * - Invokes ONLY resolveClassificationConflict. Resolution does NOT change
 *   any confidence, does NOT rehabilitate knowledge, does NOT pick a GL
 *   winner and does NOT touch accounting — the domain enforces this.
 * - Domain results are mapped explicitly: RESOLVED (success),
 *   ALREADY_RESOLVED (idempotent success), NOT_FOUND (tenant-safe absence),
 *   ERROR (internal failure — never converted to success).
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  try {
    const { userId, companyId } = requireCompanyContext();
    await requireCompanyRole(companyId, ['company_admin']);

    const { id } = await context.params;
    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: INVALID_INPUT_ERROR }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: INVALID_INPUT_ERROR }, { status: 400 });
    }
    const resolutionReason =
      typeof body === 'object' && body !== null
        && 'resolutionReason' in body
        ? (body as { resolutionReason: unknown }).resolutionReason
        : undefined;
    if (typeof resolutionReason !== 'string' || resolutionReason.trim() === '') {
      return NextResponse.json({ error: INVALID_INPUT_ERROR }, { status: 400 });
    }

    const adapter = createAdapter(db, (fn) => db.$transaction(fn));
    const result = await resolveClassificationConflict(
      adapter,
      companyId,
      id,
      userId,
      resolutionReason,
    );

    if (result.status === 'RESOLVED' || result.status === 'ALREADY_RESOLVED') {
      await safeAuditLog({
        companyId,
        userId,
        action: 'CLASSIFICATION_CONFLICT_RESOLVED',
        entity: 'MemoryItem',
        entityId: result.resolutionId,
        details: {
          conflictItemId: result.conflictItemId,
          result: result.status,
        },
      });
      return NextResponse.json({
        success: true,
        status: result.status,
        conflictItemId: result.conflictItemId,
        resolutionId: result.resolutionId,
      });
    }

    if (result.status === 'NOT_FOUND') {
      // Tenant-safe absence: no existence leak for foreign conflicts.
      return NextResponse.json(
        { error: 'Conflict not found', code: 'CONFLICT_NOT_FOUND' },
        { status: 404 },
      );
    }

    // ERROR — internal failure, mapped explicitly, never a generic success.
    logger.error('[CLASSIFICATION_CONFLICT_RESOLVE_ERROR]', {
      companyId,
      userId,
      conflictItemId: id,
      error: result.error,
    });
    return NextResponse.json(
      { error: 'Failed to resolve classification conflict' },
      { status: 500 },
    );
  } catch (error: unknown) {
    return handleRouteError(error, 'POST_CLASSIFICATION_CONFLICT_RESOLVE_ERROR');
  }
}, { requireMembership: true });
