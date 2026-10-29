import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { handleRouteError } from '@/lib/route-error-handler';
import {
  createAdapter,
  getPendingConflicts,
  type PendingConflictEntry,
} from '@/memory/classification-knowledge';
import { type PendingConflictApiEntry, toPendingConflictApiEntry } from './helpers';

/**
 * GET /api/learning/classification-conflicts
 *
 * Lists pending (unresolved) classification conflicts for the ACTIVE company.
 * Company context comes from existing infrastructure (no client-supplied
 * companyId); tenant isolation is delegated to getPendingConflicts.
 *
 * Exposes ONLY fields that exist in the domain contract — no invented
 * descriptive data, no guessing.
 */

export const GET = apiHandler(async (request: NextRequest, _context: RouteContext) => {
  try {
    const { userId, companyId } = requireCompanyContext();
    await requireCompanyRole(companyId, ['company_admin']);
    await requireModuleEntitlement('banking');

    const adapter = createAdapter(db, (fn) => db.$transaction(fn));
    const result = await getPendingConflicts(adapter, companyId);

    if (result.status === 'ERROR') {
      logger.error('[CLASSIFICATION_CONFLICTS_LIST_ERROR]', {
        companyId,
        userId,
        error: result.error,
      });
      return NextResponse.json(
        { error: 'Failed to list pending conflicts' },
        { status: 500 },
      );
    }

    // FOUND → conflicts; EMPTY → empty list. Never convert a read failure
    // into a success shape (domain reports ERROR separately, handled above).
    const conflicts = result.status === 'FOUND' ? result.conflicts.map(toPendingConflictApiEntry) : [];

    return NextResponse.json({ success: true, conflicts });
  } catch (error: unknown) {
    return handleRouteError(error, 'GET_CLASSIFICATION_CONFLICTS_ERROR');
  }
}, { requireMembership: true });
