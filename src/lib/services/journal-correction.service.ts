import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { JournalEntryService } from './journal-entry.service';
import { appendEntryToJournalChain } from '../journal-chain';
import { assertActiveFiscalPeriod } from '../fiscal-period-guard';

export class JournalCorrectionService {
  static async applyCorrection(
    tx: Prisma.TransactionClient,
    params: {
      originalEntryId: string;
      companyId: string;
      correctedLines: Array<{ glAccountId: string; debit: number; credit: number; description?: string | null }>;
      reason: string;
      correctedByUserId: string;
      correctionDate: Date; // Explicit correction date (must be in open fiscal period)
    }
  ) {
    const original = await tx.journalEntry.findUnique({
      where: { id: params.originalEntryId, companyId: params.companyId },
      include: { lines: true },
    });
    if (!original) throw new Error('Original entry not found');
    if (original.status !== 'posted') throw new Error('Only posted entries can be corrected');

    // Duplicate-guard: determinism + DB unique enforcement together.
    const existing = await tx.journalCorrection.findFirst({
      where: { companyId: params.companyId, originalEntryId: params.originalEntryId },
    });
    if (existing) throw new Error('CORRECTION_DUPLICATE');

    // Fiscal period validated on the EXPLICIT correction date (NOT original.date)
    await assertActiveFiscalPeriod(params.companyId, params.correctionDate, tx as any);
    
    // Use explicit correction date for new entries
    const correctionDate = params.correctionDate;

    // 1) Counter-entry (swap debits/credits of original lines)
    const counterLines = original.lines.map((l) => ({
      glAccountId: l.glAccountId,
      debit: Number(l.credit) || 0,
      credit: Number(l.debit) || 0,
      description: l.description ?? 'Contraasiento por corrección',
    }));

    const counterEntry = await tx.journalEntry.create({
      data: {
        companyId: params.companyId,
        date: correctionDate,
        description: `Contraasiento — corrección de ${original.reference ?? original.id}`,
        reference: `CORR-COUNTER-${original.id}`,
        status: 'posted',
        lines: { create: counterLines },
      },
      include: { lines: true },
    });

    // 2) Replacement entry (corrected data from user)
    const replacementEntry = await tx.journalEntry.create({
      data: {
        companyId: params.companyId,
        date: correctionDate,
        description: `Asiento corregido — ${original.description}`,
        reference: `CORR-REPLACEMENT-${original.id}`,
        status: 'posted',
        lines: { create: params.correctedLines.map(l => ({
          glAccountId: l.glAccountId,
          debit: l.debit,
          credit: l.credit,
          description: l.description ?? null,
        })) },
      },
      include: { lines: true },
    });

    // Seal counter asiento into the journal hash chain FIRST
    await appendEntryToJournalChain(tx, { companyId: params.companyId, entryId: counterEntry.id });

    // 3) Link record: original kept intact; counter and replacement linked
    const correction = await tx.journalCorrection.create({
      data: {
        companyId: params.companyId,
        originalEntryId: original.id,
        counterEntryId: counterEntry.id,
        replacementEntryId: replacementEntry.id,
        reason: params.reason,
        correctedByUserId: params.correctedByUserId,
      },
    });

    // Seal replacement asiento into the journal hash chain AFTER counter
    await appendEntryToJournalChain(tx, { companyId: params.companyId, entryId: replacementEntry.id });

    // 4) Recalculate balances for affected GL accounts (original stays; counter+replacement count)
    const accountIds = new Set([
      ...original.lines.map((l) => l.glAccountId),
      ...counterLines.map((l) => l.glAccountId),
      ...params.correctedLines.map((l) => l.glAccountId),
    ]);
    for (const glId of accountIds) {
      await JournalEntryService.recalculateBalance(tx, glId);
    }

    return { counterEntry, replacementEntry, correctionId: correction.id };
  }
}
