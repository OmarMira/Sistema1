import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { createAuditLogWithRetry } from '@/lib/audit';
import { NotFoundError, ValidationError } from '@/lib/api-error';

export const POST = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);

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

      // Resolve the linked entry structurally (contract 1:1) instead of a
      // heuristic search by date + description, which is ambiguous when two
      // transactions share the same date and description.
      const pendingEntry = bankTx.journalEntryId
        ? await tx.journalEntry.findUnique({ where: { id: bankTx.journalEntryId } })
        : null;

      if (pendingEntry && pendingEntry.companyId === companyId && pendingEntry.status === 'pending_review') {
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

    const pendingEntry = bankTx.journalEntryId
      ? await tx.journalEntry.findUnique({ where: { id: bankTx.journalEntryId } })
      : null;

    if (pendingEntry && pendingEntry.companyId === companyId && pendingEntry.status === 'pending_review') {
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
