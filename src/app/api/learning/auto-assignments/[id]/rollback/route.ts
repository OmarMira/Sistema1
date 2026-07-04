import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { safeAuditLog } from '@/lib/services/audit-service';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  try {
    const userId = requireCurrentUserId();
    const { id } = await context.params;

    // Load EntityContext by id
    const entityContext = await db.entityContext.findUnique({
      where: { id },
    });

    if (!entityContext) {
      return NextResponse.json(
        { error: 'Entity context not found' },
        { status: 404 },
      );
    }

    // Only allow rollback for auto-assigned contexts
    if (!entityContext.autoAssignedAt) {
      return NextResponse.json(
        { error: 'Cannot rollback manual assignment' },
        { status: 400 },
      );
    }

    // Find and delete linked BankRule first, then delete EntityContext
    await db.bankRule.deleteMany({
      where: { entityContextId: id },
    });

    await db.entityContext.delete({
      where: { id },
    });

    // Audit log
    await safeAuditLog({
      companyId: entityContext.companyId,
      userId,
      action: 'AUTO_ASSIGNMENT_ROLLBACK',
      entity: 'EntityContext',
      entityId: id,
      details: {
        pattern: entityContext.pattern,
        role: entityContext.role,
        autoAssignedAt: entityContext.autoAssignedAt,
      },
    });

    logger.info('[AUTO_ASSIGNMENT_ROLLBACK]', {
      entityContextId: id,
      pattern: entityContext.pattern,
      role: entityContext.role,
      userId,
    });

    return NextResponse.json({
      success: true,
      message: 'Auto-assignment rolled back',
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[AUTO_ASSIGNMENT_ROLLBACK_ERROR]', { error: msg });
    return NextResponse.json(
      { error: 'Failed to rollback auto-assignment' },
      { status: 500 },
    );
  }
}, { requireMembership: false });
