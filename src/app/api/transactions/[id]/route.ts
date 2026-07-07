import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { logger } from '@/lib/logger';

// ─── PATCH /api/transactions/[id] ───────────────────────────────────────
// Manual GL account assignment: updates the transaction and creates the
// corresponding journal entry automatically.
export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { id } = await context.params;

  const body = await request.json();
  const { glAccountId } = body;

  if (!glAccountId) {
    return NextResponse.json(
      { error: 'glAccountId is required' },
      { status: 400 },
    );
  }

  // Verify the transaction exists and belongs to the company
  const transaction = await db.bankTransaction.findFirst({
    where: { id, statement: { bankAccount: { companyId } } },
    include: {
      statement: {
        select: {
          bankAccount: {
            select: { id: true, glAccountId: true },
          },
        },
      },
    },
  });

  if (!transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  }

  // Verify the GL account exists and belongs to the company
  const glAccount = await db.glAccount.findFirst({
    where: { id: glAccountId, companyId, isActive: true },
  });
  if (!glAccount) {
    return NextResponse.json(
      { error: 'GL account not found or inactive' },
      { status: 404 },
    );
  }

  // If transaction already has a journal entry, unlink it first
  if (transaction.journalEntryId) {
    await db.bankTransaction.update({
      where: { id },
      data: { journalEntryId: null },
    });
  }

  const bankGlAccountId = transaction.statement.bankAccount.glAccountId;

  const result = await db.$transaction(async (tx) => {
    // Update the transaction with the new GL account
    const updated = await tx.bankTransaction.update({
      where: { id },
      data: { glAccountId },
      select: {
        id: true,
        date: true,
        amount: true,
        description: true,
        glAccountId: true,
        journalEntryId: true,
      },
    });

    // Create the journal entry if the bank account has a GL account linked
    if (bankGlAccountId) {
       
      const entryId = await JournalEntryService.createFromBankTransaction(tx as any, {
        bankTxId: updated.id,
        bankTxDate: updated.date,
        bankTxAmount: Number(updated.amount),
        bankTxDescription: updated.description,
        bankGlAccountId,
        counterpartyGlAccountId: glAccountId,
        companyId,
      });
      updated.journalEntryId = entryId;
    }

    return updated;
  });

  logger.info('Transaction GL account updated + journal entry created', {
    transactionId: id,
    glAccountId,
    journalEntryId: result.journalEntryId,
  });

  return NextResponse.json({ transaction: result });
});
