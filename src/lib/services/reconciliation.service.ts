import { db } from '@/lib/db';
import { NotFoundError, ValidationError } from '@/lib/api-error';
import { CreateReconciliationInput } from '@/lib/validations/reconciliation';
import { withTiming } from '@/lib/timing';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { validateSemanticDirection } from '@/lib/semantic-validator';

export class ReconciliationService {
  static reconcile = withTiming(async (input: CreateReconciliationInput) => {
    const { companyId, bankAccountId, transactions, createJournalEntries, periodId } = input;

    // Verify bank account with GL account info
    const bankAccount = await db.bankAccount.findFirst({
      where: { id: bankAccountId, companyId },
      include: {
        glAccount: {
          select: { id: true, code: true, name: true, normalBalance: true },
        },
      },
    });
    if (!bankAccount) {
      throw new NotFoundError('Bank account not found');
    }
    if (!bankAccount.glAccountId) {
      throw new ValidationError(
        'Bank account has no linked GL account. Link a GL account before reconciling.',
      );
    }

    let reconciledCount = 0;
    let journalEntriesCreated = 0;
    const warnings: string[] = [];

    await db.$transaction(async (tx) => {
      // Batch fetch all needed GL accounts before loop — elimina N+1
      const allGlAccountIds = new Set<string>();
      for (const txn of transactions) {
        if (txn.splits && txn.splits.length > 0) {
          for (const split of txn.splits) {
            allGlAccountIds.add(split.glAccountId);
          }
        } else if (txn.glAccountId) {
          allGlAccountIds.add(txn.glAccountId);
        }
      }
      const glAccountMap =
        allGlAccountIds.size > 0
          ? new Map(
              (
                await tx.glAccount.findMany({
                  where: { id: { in: Array.from(allGlAccountIds) }, companyId },
                })
              ).map((a) => [a.id, a]),
            )
          : new Map();

      for (const txn of transactions) {
        // Find unreconciled bank transaction
        const bankTx = await tx.bankTransaction.findFirst({
          where: {
            id: txn.id,
            isReconciled: false,
            statement: { bankAccountId },
          },
        });
        if (!bankTx) continue;

        // Verify that the transaction date is in an active fiscal period
        await assertActiveFiscalPeriod(companyId, bankTx.date);

        const txnWarnings: string[] = [];
        const updateData: Record<string, unknown> = {
          isReconciled: true,
          reconciledAt: new Date(),
        };

        // If splits are provided, we use the first split's GL account as the main one for the bank transaction record
        const mainGlId =
          txn.splits && txn.splits.length > 0 ? txn.splits[0]!.glAccountId : txn.glAccountId;

        // Perform semantic checks for splits or main GL account
        if (txn.splits && txn.splits.length > 0) {
          for (const split of txn.splits) {
            const splitAccount = glAccountMap.get(split.glAccountId);
            if (splitAccount) {
              const direction = Number(bankTx.amount) > 0 ? 'credit' : 'debit';
              const semanticWarning = validateSemanticDirection(
                splitAccount.accountType,
                direction,
                split.description || bankTx.description,
              );
              if (semanticWarning) {
                txnWarnings.push(semanticWarning);
              }
            }
          }
          updateData.glAccountId = mainGlId;
        } else if (mainGlId) {
          const glAccount = glAccountMap.get(mainGlId);
          if (glAccount) {
            updateData.glAccountId = mainGlId;
            const direction = Number(bankTx.amount) > 0 ? 'credit' : 'debit';
            const semanticWarning = validateSemanticDirection(
              glAccount.accountType,
              direction,
              bankTx.description,
            );
            if (semanticWarning) {
              txnWarnings.push(semanticWarning);
            }
          }
        }

        if (txnWarnings.length > 0) {
          updateData.status = 'pending_review';
          warnings.push(...txnWarnings);
        }

        if (periodId) {
          updateData.reconciliationPeriodId = periodId;
        }

        await tx.bankTransaction.update({
          where: { id: txn.id },
          data: updateData,
        });

        // Create journal entry if requested
        if (createJournalEntries) {
          const amount = Math.abs(bankTx.amount);
          const isDeposit = Number(bankTx.amount) > 0;
          const description = `Reconciliation: ${bankTx.description}`;
          const entryStatus = txnWarnings.length > 0 ? 'pending_review' : 'posted';

          // Case 1: Splits provided
          if (txn.splits && txn.splits.length > 0) {
            // Validate splits before creating the entry
            const absBankAmount = Math.abs(bankTx.amount);
            const splitSum = txn.splits.reduce((s, sp) => s + Math.abs(sp.amount), 0);
            if (Math.abs(splitSum - absBankAmount) > 0.01) {
              throw new ValidationError(
                `Split amounts sum to ${splitSum.toFixed(2)} but transaction amount is ${absBankAmount.toFixed(2)}`,
              );
            }
            if (txn.splits.some((sp) => Math.abs(sp.amount) === 0)) {
              throw new ValidationError('Split amounts must be greater than zero');
            }

            const lines: Array<{ glAccountId: string; description: string; debit: number; credit: number }> = [];

            // The bank side line
            lines.push({
              glAccountId: bankAccount.glAccountId,
              description,
              debit: isDeposit ? amount : 0,
              credit: isDeposit ? 0 : amount,
            });

            // The split side lines
            for (const split of txn.splits) {
              const splitAmount = Math.abs(split.amount);
              lines.push({
                glAccountId: split.glAccountId,
                description: split.description || description,
                debit: isDeposit ? 0 : splitAmount,
                credit: isDeposit ? splitAmount : 0,
              });
            }

            await tx.journalEntry.create({
              data: {
                companyId,
                date: bankTx.date,
                description,
                status: entryStatus,
                lines: { create: lines },
              },
            });
            journalEntriesCreated++;
          }
          // Case 2: No splits, but glAccountId provided
          else if (mainGlId) {
            const debitAccountId = isDeposit ? bankAccount.glAccountId : mainGlId;
            const creditAccountId = isDeposit ? mainGlId : bankAccount.glAccountId;

            await tx.journalEntry.create({
              data: {
                companyId,
                date: bankTx.date,
                description,
                status: entryStatus,
                lines: {
                  create: [
                    { glAccountId: debitAccountId, description, debit: amount, credit: 0 },
                    { glAccountId: creditAccountId, description, debit: 0, credit: amount },
                  ],
                },
              },
            });
            journalEntriesCreated++;
          }
        }

        reconciledCount++;
      }

      // Update period transaction count if period provided
      if (periodId) {
        const periodTxCount = await tx.bankTransaction.count({
          where: { reconciliationPeriodId: periodId },
        });
        await tx.reconciliationPeriod.update({
          where: { id: periodId, companyId },
          data: { transactionCount: periodTxCount },
        });
      }
    });

    return {
      reconciledCount,
      journalEntriesCreated,
      warnings,
    };
  }, 'ReconciliationService.reconcile');
}

