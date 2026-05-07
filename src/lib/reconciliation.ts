import { db } from '@/lib/db';

/**
 * Recalculate the bank account balance based on all reconciled transactions.
 * balance = initial_balance + SUM(reconciled transaction amounts)
 * Called after every reconciliation event (reconcile, auto, unreconcile, adjustment).
 */
export async function recalculateBankAccountBalance(bankAccountId: string): Promise<void> {
  // Get all statement IDs for this bank account
  const statements = await db.bankStatement.findMany({
    where: { bankAccountId },
    select: { id: true },
  });
  const statementIds = statements.map((s) => s.id);

  // Sum all reconciled transaction amounts
  const result = await db.bankTransaction.aggregate({
    where: {
      statementId: { in: statementIds },
      isReconciled: true,
    },
    _sum: {
      amount: true,
    },
  });

  const reconciledTotal = result._sum.amount ?? 0;

  // Update the bank account balance
  await db.bankAccount.update({
    where: { id: bankAccountId },
    data: { balance: reconciledTotal },
  });
}
