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
  rehabilitateClassificationKnowledge,
  type RehabilitationResult,
} from '@/memory/classification-knowledge';

const INVALID_REHAB_INPUT_ERROR = 'conflictItemId and knowledgeItemId are required';

/**
 * POST /api/learning/classification-conflicts/[id]/rehabilitate
 *
 * Explicit HUMAN rehabilitation of knowledge degraded by a RESOLVED
 * classification conflict. SEPARATE from resolution — calling this endpoint
 * never resolves anything and resolution never rehabilitates.
 *
 * - conflictItemId from the route param; knowledgeItemId from the body
 *   (never guessed by the API or the UI).
 * - rehabilitatedBy ALWAYS comes from the authenticated session.
 * - Invokes ONLY rehabilitateClassificationKnowledge. Every domain outcome is
 *   mapped explicitly — distinct outcomes are never collapsed into generic
 *   success:
 *     REHABILITATED                    → 200 success
 *     ALREADY_CERTAIN                  → 200 (idempotent end-state)
 *     CONFLICT_NOT_RESOLVED            → 409 (business precondition)
 *     OTHER_PENDING_CONFLICT           → 409 (business precondition)
 *     NOT_IMPLICATED                   → 409 (business precondition)
 *     NOT_UNCERTAIN                    → 409 (business precondition)
 *     NOT_FOUND                        → 404 (tenant-safe absence)
 *     ERROR                            → 500 (internal failure)
 */
const BUSINESS_PRECONDITION_STATUS = 409;

export function mapRehabilitationResult(
  result: RehabilitationResult,
): { body: Record<string, unknown>; status: number } {
  switch (result.status) {
    case 'REHABILITATED':
      return {
        body: {
          success: true,
          status: 'REHABILITATED',
          knowledgeItemId: result.knowledgeItemId,
          conflictItemId: result.conflictItemId,
          rehabilitationEventId: result.rehabilitationEventId,
        },
        status: 200,
      };
    case 'ALREADY_CERTAIN':
      return {
        body: {
          success: true,
          status: 'ALREADY_CERTAIN',
          knowledgeItemId: result.knowledgeItemId,
        },
        status: 200,
      };
    case 'CONFLICT_NOT_RESOLVED':
      return {
        body: {
          success: false,
          status: 'CONFLICT_NOT_RESOLVED',
          conflictItemId: result.conflictItemId,
          error: 'Conflict must be explicitly resolved before rehabilitation',
          code: 'CONFLICT_NOT_RESOLVED',
        },
        status: BUSINESS_PRECONDITION_STATUS,
      };
    case 'OTHER_PENDING_CONFLICT':
      return {
        body: {
          success: false,
          status: 'OTHER_PENDING_CONFLICT',
          conflictItemId: result.conflictItemId,
          blockingConflictItemIds: result.blockingConflictItemIds,
          error: 'Another pending conflict still implicates this knowledge item',
          code: 'OTHER_PENDING_CONFLICT',
        },
        status: BUSINESS_PRECONDITION_STATUS,
      };
    case 'NOT_IMPLICATED':
      return {
        body: {
          success: false,
          status: 'NOT_IMPLICATED',
          conflictItemId: result.conflictItemId,
          error: 'Knowledge item is not explicitly implicated by this conflict',
          code: 'NOT_IMPLICATED',
        },
        status: BUSINESS_PRECONDITION_STATUS,
      };
    case 'NOT_UNCERTAIN':
      return {
        body: {
          success: false,
          status: 'NOT_UNCERTAIN',
          knowledgeItemId: result.knowledgeItemId,
          error: 'Knowledge item is not in uncertain state',
          code: 'NOT_UNCERTAIN',
        },
        status: BUSINESS_PRECONDITION_STATUS,
      };
    // NOT_FOUND / ERROR are handled by the caller (status 404 / 500) and
    // must not be audited as productive actions.
    case 'NOT_FOUND':
      return {
        body: { error: 'Conflict not found', code: 'CONFLICT_NOT_FOUND' },
        status: 404,
      };
    case 'ERROR':
      return {
        body: { error: 'Failed to rehabilitate classification knowledge' },
        status: 500,
      };
  }
}

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  try {
    const { userId, companyId } = requireCompanyContext();
    await requireCompanyRole(companyId, ['company_admin']);

    const { id } = await context.params;
    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: INVALID_REHAB_INPUT_ERROR },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: INVALID_REHAB_INPUT_ERROR },
        { status: 400 },
      );
    }
    const knowledgeItemId =
      typeof body === 'object' && body !== null
        && 'knowledgeItemId' in body
        ? (body as { knowledgeItemId: unknown }).knowledgeItemId
        : undefined;
    if (typeof knowledgeItemId !== 'string' || knowledgeItemId.trim() === '') {
      return NextResponse.json(
        { error: INVALID_REHAB_INPUT_ERROR },
        { status: 400 },
      );
    }

    const adapter = createAdapter(db, (fn) => db.$transaction(fn));
    const result = await rehabilitateClassificationKnowledge(
      adapter,
      companyId,
      id,
      knowledgeItemId,
      userId,
    );

    const mapped = mapRehabilitationResult(result);

    if (result.status === 'REHABILITATED' || result.status === 'ALREADY_CERTAIN') {
      // AUDIT-SIDE-EFFECT-001: the domain rehabilitation is already persisted.
      // An audit failure must NOT convert the successful rehabilitation into
      // an HTTP failure (precedent: conversational-parse try/catch pattern).
      try {
        await safeAuditLog({
          companyId,
          userId,
          action: 'CLASSIFICATION_KNOWLEDGE_REHABILITATED',
          entity: 'MemoryItem',
          entityId: knowledgeItemId,
          details: {
            conflictItemId: id,
            knowledgeItemId,
            result: result.status,
            ...(result.status === 'REHABILITATED'
              ? { rehabilitationEventId: result.rehabilitationEventId }
              : {}),
          },
        });
      } catch (auditError) {
        logger.error('[CLASSIFICATION_KNOWLEDGE_REHABILITATED_AUDIT_FAILED]', {
          companyId,
          userId,
          conflictItemId: id,
          knowledgeItemId,
          result: result.status,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }
      return NextResponse.json(mapped.body, { status: mapped.status });
    }

    if (result.status === 'ERROR') {
      logger.error('[CLASSIFICATION_KNOWLEDGE_REHABILITATE_ERROR]', {
        companyId,
        userId,
        conflictItemId: id,
        knowledgeItemId,
        error: result.error,
      });
    }

    return NextResponse.json(mapped.body, { status: mapped.status });
  } catch (error: unknown) {
    return handleRouteError(error, 'POST_CLASSIFICATION_KNOWLEDGE_REHABILITATE_ERROR');
  }
}, { requireMembership: true });
