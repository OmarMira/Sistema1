import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { createAuditLogWithRetry } from '@/lib/audit';
import { NotFoundError, ValidationError } from '@/lib/api-error';

export const POST = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await request.json();
  const { transactionId, action } = body;

  if (!transactionId) {
    throw new ValidationError('transactionId is required');
  }
  if (action !== 'approve' && action !== 'reject') {
    throw new ValidationError('action must be "approve" or "reject"');
  }

  const bankTx = await db.bankTransaction.findFirst({
    where: { id: transactionId, status: 'pending_review' },
    include: {
      statement: {
        include: { bankAccount: { select: { id: true, companyId: true } } },
      },
    },
  });

  if (!bankTx) {
    throw new NotFoundError('Transaction not found or not in pending_review status');
  }
  if (bankTx.statement.bankAccount.companyId !== companyId) {
    throw new NotFoundError('Transaction not found');
  }

  if (action === 'approve') {
    await db.$transaction(async (tx) => {
      await tx.bankTransaction.update({
        where: { id: transactionId },
        data: { status: 'posted' },
      });

      const pendingEntry = await tx.journalEntry.findFirst({
        where: {
          companyId,
          date: bankTx.date,
          description: `Reconciliation: ${bankTx.description}`,
          status: 'pending_review',
        },
      });

      if (pendingEntry) {
        await tx.journalEntry.update({
          where: { id: pendingEntry.id },
          data: { status: 'posted' },
        });
      }

      await createAuditLogWithRetry(
        {
          companyId,
          userId,
          action: 'approve_pending_review',
          entity: 'BankTransaction',
          entityId: transactionId,
          details: `Approved pending review transaction: ${bankTx.description}`,
        },
         
        tx as any,
      );
    });

    return NextResponse.json({ success: true, action: 'approved' });
  }

  // Reject — reverse journal entry, move to suspense
  const suspenseAccount = await db.glAccount.findFirst({
    where: { companyId, code: '1050', isActive: true },
  });

  await db.$transaction(async (tx) => {
    await tx.bankTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'suspense',
        isReconciled: false,
        reconciledAt: null,
        glAccountId: suspenseAccount?.id ?? bankTx.glAccountId,
      },
    });

    const pendingEntry = await tx.journalEntry.findFirst({
      where: {
        companyId,
        date: bankTx.date,
        description: `Reconciliation: ${bankTx.description}`,
        status: 'pending_review',
      },
      include: { lines: true },
    });

    if (pendingEntry) {
      await tx.journalEntry.update({
        where: { id: pendingEntry.id },
        data: { status: 'void' },
      });
    }

    await createAuditLogWithRetry(
      {
        companyId,
        userId,
        action: 'reject_pending_review',
        entity: 'BankTransaction',
        entityId: transactionId,
        details: `Rejected pending review transaction: ${bankTx.description}${suspenseAccount ? `. Moved to Suspense Account (${suspenseAccount.code})` : ''}`,
      },
       
      tx as any,
    );
  });

  return NextResponse.json({ success: true, action: 'rejected' });
});
