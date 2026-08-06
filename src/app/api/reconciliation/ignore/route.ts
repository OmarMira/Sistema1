import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { logger } from '@/lib/logger';

// ─── PATCH /api/reconciliation/ignore ──────────────────────────────
// Toggle ignore status for transactions.
// Body: { companyId, transactionIds: string[], ignore: boolean }
export const PATCH = apiHandler(async (request: NextRequest) => {
  const userId = requireCurrentUserId();

  try {
    const body = await request.json();
    const { companyId, transactionIds, ignore } = body;

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
        { status: 400 }
      );
    }

    if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
      return NextResponse.json(
        { error: 'transactionIds array is required and must not be empty' },
        { status: 400 }
      );
    }

    if (typeof ignore !== 'boolean') {
      return NextResponse.json(
        { error: 'ignore must be a boolean' },
        { status: 400 }
      );
    }

    // Verify access delegated to apiHandler tenant gate (requireActiveTenantAccess)

    // If ignoring, ensure transactions are not already reconciled
    if (ignore) {
      const reconciledTxs = await db.bankTransaction.findMany({
        where: {
          id: { in: transactionIds },
          isReconciled: true,
        },
        select: { id: true },
      });

      if (reconciledTxs.length > 0) {
        return NextResponse.json(
          {
            error: `Cannot ignore already reconciled transactions (${reconciledTxs.length} found)`,
          },
          { status: 400 }
        );
      }
    }

    // If un-ignoring, ensure transactions exist
    const existingTxs = await db.bankTransaction.findMany({
      where: {
        id: { in: transactionIds },
        statement: { companyId },
      },
      select: { id: true },
    });

    if (existingTxs.length === 0) {
      return NextResponse.json(
        { error: 'No valid transactions found for the given IDs' },
        { status: 404 }
      );
    }

    const validIds = existingTxs.map((t) => t.id);

    // Update transactions
    const result = await db.bankTransaction.updateMany({
      where: { id: { in: validIds } },
      data: { isIgnored: ignore },
    });

    // Audit log
    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: ignore ? 'ignore_transactions' : 'unignore_transactions',
        entity: 'BankTransaction',
        details: JSON.stringify({
          transactionIds: validIds,
          count: result.count,
          ignore,
        }),
      },
    });

    return NextResponse.json({
      success: true,
      updated: result.count,
      ignore,
    });
  } catch (error) {
    logger.error('Failed to toggle ignore on transactions', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
});
