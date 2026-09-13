import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { handleRouteError } from '@/lib/route-error-handler';
import {
  createAdapter,
  authorizeStructuralCandidate,
} from '@/memory/classification-knowledge';
import { safeAuditLog } from '@/lib/services/audit-service';

/**
 * POST /api/learning/structural-candidates/[id]/authorize
 *
 * EXPLICIT HUMAN authorization of one persisted structural candidate
 * (KE-GENERALIZATION-UI-001). This is the ONLY productive writer of
 * authorized structural patterns: discovery never authorizes.
 *
 * - authorizedBy comes exclusively from the authenticated session; the
 *   client body carries no actor identity.
 * - Tenant ownership, candidate existence, type, content validity,
 *   idempotency and conflict policy are ALL enforced by the existing domain
 *   authority authorizeStructuralCandidate — nothing is duplicated here.
 * - No BankRule, no AI, no PendingApproval, no direct MemoryItem writes.
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  try {
    const { userId, companyId } = requireCompanyContext();
    await requireCompanyRole(companyId, ['company_admin']);
    const { id } = await context.params;

    const adapter = createAdapter(db, (fn) => db.$transaction(fn));
    const result = await authorizeStructuralCandidate(adapter, companyId, id, userId);

    if (result.status === 'AUTHORIZED' || result.status === 'ALREADY_AUTHORIZED') {
      // AUDIT-SIDE-EFFECT-001: the domain authorization is already persisted.
      // An audit failure must NOT convert the successful authorization into
      // an HTTP failure (precedent: conversational-parse try/catch pattern).
      try {
        await safeAuditLog({
          companyId,
          userId,
          action: 'STRUCTURAL_PATTERN_AUTHORIZED',
          entity: 'MemoryItem',
          entityId: result.authorizedPatternId,
          details: {
            candidateItemId: id,
            authorizedPatternId: result.authorizedPatternId,
            result: result.status,
          },
        });
      } catch (auditError) {
        logger.error('[STRUCTURAL_PATTERN_AUTHORIZED_AUDIT_FAILED]', {
          companyId,
          userId,
          candidateItemId: id,
          authorizedPatternId: result.authorizedPatternId,
          result: result.status,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }
      return NextResponse.json({
        success: true,
        status: result.status,
        authorizedPatternId: result.authorizedPatternId,
      });
    }

    if (result.status === 'NOT_FOUND') {
      return NextResponse.json(
        { success: false, status: 'NOT_FOUND' },
        { status: 404 },
      );
    }

    if (result.status === 'CONFLICT') {
      // Domain refusal: an authorized pattern for the same entity+direction
      // with a different treatment already exists. Nothing was persisted.
      return NextResponse.json(
        { success: false, status: 'CONFLICT', conflictingPatternIds: result.conflictingPatternIds },
        { status: 409 },
      );
    }

    logger.error('[STRUCTURAL_AUTHORIZE_ERROR]', {
      companyId,
      userId,
      candidateItemId: id,
      error: result.error,
    });
    return NextResponse.json(
      { success: false, status: 'ERROR', error: result.error },
      { status: 500 },
    );
  } catch (error: unknown) {
    return handleRouteError(error, 'POST_STRUCTURAL_AUTHORIZE_ERROR');
  }
}, { requireMembership: true });
