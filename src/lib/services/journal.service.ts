import { createHash } from 'crypto';
import { db } from '@/lib/db';
import { ValidationError, ConflictError } from '@/lib/api-error';
import { CreateJournalEntryInput } from '@/lib/validations/journal';
import { withTiming } from '@/lib/timing';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { createAuditLogWithRetry } from '@/lib/audit';
import { JournalEntryService } from '@/lib/services/journal-entry.service';

function canonicalizeInput(input: {
  date: string;
  description?: string | null;
  reference?: string | null;
  status: string;
  lines: { glAccountId: string; description?: string | null; debit: number; credit: number }[];
}) {
  return {
    date: input.date,
    description: input.description || null,
    reference: input.reference || null,
    status: input.status,
    lines: [...input.lines]
      .map((l) => ({
        glAccountId: l.glAccountId,
        description: l.description || null,
        debit: Number(l.debit),
        credit: Number(l.credit),
      }))
      .sort((a, b) =>
        a.glAccountId.localeCompare(b.glAccountId) ||
        (a.description ?? '').localeCompare(b.description ?? '') ||
        b.debit - a.debit ||
        b.credit - a.credit
      ),
  };
}

function computeRequestHash(input: {
  date: string;
  description?: string | null;
  reference?: string | null;
  status: string;
  lines: { glAccountId: string; description?: string | null; debit: number; credit: number }[];
}) {
  const canonical = canonicalizeInput(input);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const IDEMPOTENCY_INCLUDE = {
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
} as const;

export class JournalService {
  static create = withTiming(async (input: CreateJournalEntryInput, userId?: string) => {
    const { companyId, date, description, reference, status, lines, idempotencyKey } = input;

    // D2-H14: idempotency lookup BEFORE any mutable validation
    const requestHash = idempotencyKey ? computeRequestHash({ date, description, reference, status, lines }) : null;

    if (idempotencyKey) {
      const existing = await db.journalEntry.findUnique({
        where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
        include: IDEMPOTENCY_INCLUDE,
      });
      if (existing) {
        if (existing.idempotencyRequestHash === requestHash) {
          return { entry: existing, replayed: true };
        }
        throw new ConflictError('Idempotency key reused with a different payload');
      }
    }

    // Mutable validations — only after idempotency check
    if (!lines || lines.length < 2) {
      throw new ValidationError('Se requieren al menos 2 líneas de asiento contable');
    }

    const totalDebits = lines.reduce((sum, l) => sum + l.debit, 0);
    const totalCredits = lines.reduce((sum, l) => sum + l.credit, 0);

    if (Math.round(totalDebits * 100) !== Math.round(totalCredits * 100)) {
      throw new ValidationError('Unbalanced journal entry. Debits must equal Credits.');
    }

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

    if (!userId) {
      throw new ValidationError('userId is required when creating a journal entry');
    }

    // Create entry with lines in a transaction
    let entry;
    try {
      entry = await db.$transaction(async (tx) => {
        await assertActiveFiscalPeriod(companyId, date, tx as any);
        const newEntry = await tx.journalEntry.create({
          data: {
            companyId,
            date: new Date(date),
            description,
            reference: reference || null,
            status,
            idempotencyKey: idempotencyKey ?? null,
            idempotencyRequestHash: idempotencyKey ? requestHash : null,
            lines: {
              create: lines.map((l) => ({
                glAccountId: l.glAccountId,
                description: l.description || null,
                debit: l.debit,
                credit: l.credit,
              })),
            },
          },
          include: IDEMPOTENCY_INCLUDE,
        });

        await createAuditLogWithRetry(
          {
            companyId,
            userId,
            action: 'create',
            entity: 'journalEntry',
            entityId: newEntry.id,
            details: JSON.stringify({ description, status }),
          },
          tx as any,
        );

        if (status === 'posted') {
          const uniqueAccountIds = [...new Set(lines.map((l) => l.glAccountId))];
          for (const glAccountId of uniqueAccountIds) {
            await JournalEntryService.recalculateBalance(tx as any, glAccountId);
          }
        }

        return newEntry;
      });
    } catch (err: any) {
      if (idempotencyKey && err?.code === 'P2002') {
        const winner = await db.journalEntry.findUnique({
          where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
          include: IDEMPOTENCY_INCLUDE,
        });
        if (winner) {
          if (winner.idempotencyRequestHash === requestHash) {
            return { entry: winner, replayed: true };
          }
          throw new ConflictError('Idempotency key reused with a different payload');
        }
        throw err;
      }
      throw err;
    }

    return { entry, replayed: false };
  }, 'JournalService.create');
}
