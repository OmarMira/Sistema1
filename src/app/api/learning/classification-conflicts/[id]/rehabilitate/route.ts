import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
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
import { mapRehabilitationResult } from './helpers';

const INVALID_REHAB_INPUT_ERROR = 'conflictItemId and knowledgeItemId are required';

// ─── POST /api/learning/classification-conflicts/[id]/rehabilitate ─────────────────────────────────
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  try {
    const { userId, companyId } = requireCompanyContext();
    await requireCompanyRole(companyId, ['company_admin']);
    await requireModuleEntitlement('banking');

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
