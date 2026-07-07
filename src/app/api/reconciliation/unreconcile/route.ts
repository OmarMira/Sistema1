import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';

// ─── POST /api/reconciliation/unreconcile ─────────────────────────
// Undo reconciliation for selected transactions.
// Body: { companyId, bankAccountId, transactionIds: string[] }
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await request.json();
  const { bankAccountId, transactionIds } = body;

  if (!companyId || !bankAccountId) {
    return NextResponse.json(
      { error: 'companyId and bankAccountId are required' },
      { status: 400 },
    );
  }

  if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
    return NextResponse.json(
      { error: 'transactionIds array is required and must not be empty' },
      { status: 400 },
    );
  }

  // Verify bank account
  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
  });
  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  }

  // Count how many were actually reconciled
  const reconciledTxs = await db.bankTransaction.findMany({
    where: {
      id: { in: transactionIds },
      statement: { bankAccountId },
      isReconciled: true,
    },
  });

  if (reconciledTxs.length === 0) {
    return NextResponse.json({
      success: true,
      unreconciled: 0,
      message: 'No reconciled transactions found among the selected IDs.',
    });
  }

  const idsToUpdate = reconciledTxs.map((t) => t.id);

  // Update transactions
  const result = await db.bankTransaction.updateMany({
    where: { id: { in: idsToUpdate } },
    data: {
      isReconciled: false,
      reconciledAt: null,
      reconciliationPeriodId: null,
    },
  });

  // Audit log
  await db.auditLog.create({
    data: {
      companyId,
      userId,
      action: 'unreconcile_transactions',
      entity: 'BankTransaction',
      details: JSON.stringify({
        bankAccountId,
        transactionIds: idsToUpdate,
        count: result.count,
      }),
    },
  });

  return NextResponse.json({
    success: true,
    unreconciled: result.count,
  });
});
