import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import {
  listEntityContexts,
  bulkRemoveEntityContexts,
} from '@/lib/services/entity-context-crud-service';
import { logger } from '@/lib/logger';

// ─── GET /api/entity-context ──────────────────────────────────────────
// Paginated list of entity contexts scoped to the user's company
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
  const sortBy = searchParams.get('sortBy') || 'createdAt';
  const sortDir = (searchParams.get('sortDir') || 'desc') as 'asc' | 'desc';

  // Validate sortBy to prevent injection
  const allowedSortFields = ['createdAt', 'role', 'pattern', 'updatedAt'];
  const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';

  const search = searchParams.get('search') || undefined;
  const role = searchParams.get('role') || undefined;

  try {
    const result = await listEntityContexts(
      companyId,
      page,
      limit,
      safeSortBy,
      sortDir,
      search,
      role,
    );
    return NextResponse.json(result);
  } catch (error) {
    logger.error('[GET ENTITY CONTEXTS ERROR]', { error: String(error) });
    return NextResponse.json({ error: 'Failed to load entities' }, { status: 500 });
  }
});

// ─── POST /api/entity-context/bulk-delete ─────────────────────────────
// Batch delete entity contexts scoped to the user's company
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  try {
    const body = await request.json();
    const { ids } = body as { ids?: string[] };

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'At least one entity ID is required' }, { status: 400 });
    }

    const count = await bulkRemoveEntityContexts(companyId, ids);
    return NextResponse.json({ success: true, count });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage === 'EMPTY_IDS') {
      return NextResponse.json({ error: 'At least one entity ID is required' }, { status: 400 });
    }
    logger.error('[BULK DELETE ENTITY CONTEXTS ERROR]', { error: errorMessage });
    return NextResponse.json({ error: 'Failed to delete entities' }, { status: 500 });
  }
});
