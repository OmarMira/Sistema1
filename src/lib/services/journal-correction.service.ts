import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { JournalEntryService } from './journal-entry.service';
import { appendEntryToJournalChain } from '../journal-chain';
import { assertActiveFiscalPeriod } from '../fiscal-period-guard';

/**
 * Correction link records (original -> counter + replacement).
 *
 * The `JournalCorrection` table exists in the migrations
 * (prisma/migrations/20261026142303_journal_correction), but `model JournalCorrection` is
 * missing from prisma/schema.prisma, so the generated client exposes no such delegate:
 * the previous `tx.journalEntries` (plural, JournalEntry) reference never existed either
 * and would have thrown a TypeError. POST /api/journal/[id]/corregir is intentionally
 * held at 503 ("Correction unavailable until isolated accounting integrity tests are
 * approved"), so this service is unreachable through the public API. The delegate is
 * typed structurally to keep the module type-correct without inventing schema columns
 * or changing any runtime behavior.
 */
type CorrectionLinkRecord = { id: string };

type CorrectionLinkDelegate = {
  findFirst(args: {
    where: { companyId: string; originalEntryId: string };
  }): Promise<CorrectionLinkRecord | null>;
  create(args: {
    data: {
      companyId: string;
      originalEntryId: string;
      counterEntryId: string;
      replacementEntryId: string;
      reason: string;
      correctedByUserId: string;
    };
  }): Promise<CorrectionLinkRecord>;
};

function correctionLinks(tx: Prisma.TransactionClient): CorrectionLinkDelegate {
  return (tx as unknown as { journalCorrection: CorrectionLinkDelegate }).journalCorrection;
}

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
    const existing = await correctionLinks(tx).findFirst({
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
    const correction = await correctionLinks(tx).create({
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
