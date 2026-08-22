import { db } from '@/lib/db';
import { ValidationError, ForbiddenError } from '@/lib/api-error';
import { CreateJournalEntryInput } from '@/lib/validations/journal';
import { withTiming } from '@/lib/timing';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { createAuditLogWithRetry } from '@/lib/audit';
import { JournalEntryService } from '@/lib/services/journal-entry.service';

export class JournalService {
  static create = withTiming(async (input: CreateJournalEntryInput, userId?: string) => {
    const { companyId, date, description, reference, status, lines } = input;

    if (!lines || lines.length < 2) {
      throw new ValidationError('Se requieren al menos 2 líneas de asiento contable');
    }

    // Validate balanced entry (total debits must equal total credits)
    const totalDebits = lines.reduce((sum, l) => sum + l.debit, 0);
    const totalCredits = lines.reduce((sum, l) => sum + l.credit, 0);

    // Round to nearest cent to prevent floating-point drift, but enforce exact equality
    if (Math.round(totalDebits * 100) !== Math.round(totalCredits * 100)) {
      throw new ValidationError('Unbalanced journal entry. Debits must equal Credits.');
    }

    // Verify all GL accounts belong to the company and are active
    const accountIds = lines.map((l) => l.glAccountId);
    const accounts = await db.glAccount.findMany({
      where: { id: { in: accountIds }, companyId },
    });

    if (accounts.length !== new Set(accountIds).size) {
      throw new ValidationError(
        'Una o más cuentas contables no fueron encontradas o no pertenecen a esta empresa',
      );
    }

    const inactiveAccounts = accounts.filter((a) => !a.isActive);
    if (inactiveAccounts.length > 0) {
      throw new ValidationError('Una o más cuentas contables seleccionadas están inactivas');
    }

    // D2-H4: posted entries must always carry an actor
    if (status === 'posted' && !userId) {
      throw new ValidationError('userId is required when creating a posted journal entry');
    }

    // Create entry with lines in a transaction
    const entry = await db.$transaction(async (tx) => {
      // Check fiscal period INSIDE the transaction to prevent TOCTOU race
       
      await assertActiveFiscalPeriod(companyId, date, tx as any);
      const newEntry = await tx.journalEntry.create({
        data: {
          companyId,
          date: new Date(date),
          description,
          reference: reference || null,
          status,
          lines: {
            create: lines.map((l) => ({
              glAccountId: l.glAccountId,
              description: l.description || null,
              debit: l.debit,
              credit: l.credit,
            })),
          },
        },
        include: {
          lines: {
            include: {
              glAccount: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  accountType: true,
                  normalBalance: true,
                },
              },
            },
          },
        },
      });

      // D2-H4: When creating directly as posted, audit + recalculate atomically
      if (status === 'posted') {
        await createAuditLogWithRetry(
          {
            companyId,
            userId: userId ?? null,
            action: 'create',
            entity: 'journalEntry',
            entityId: newEntry.id,
            details: JSON.stringify({ description, status: 'posted' }),
          },
          tx as any,
        );

        const uniqueAccountIds = [...new Set(lines.map((l) => l.glAccountId))];
        for (const glAccountId of uniqueAccountIds) {
          await JournalEntryService.recalculateBalance(tx as any, glAccountId);
        }
      }

      return newEntry;
    });

    return entry;
  }, 'JournalService.create');
}
