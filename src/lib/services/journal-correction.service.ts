import { Prisma } from '@prisma/client';
import { compareCents, fromCents, sumCents, toCents } from '@/lib/money';
import { JournalEntryService } from './journal-entry.service';
import { appendEntryToJournalChain } from '../journal-chain';
import { assertActiveFiscalPeriod } from '../fiscal-period-guard';

/**
 * JournalCorrection (S24) — the accounting-critical correction flow.
 *
 * Disposition: ENABLED behind `company_admin` at the HTTP boundary
 * (POST /api/journal/[id]/corregir). The `JournalCorrection` model exists in
 * prisma/schema.prisma and pins migration 20261026142303, so the delegate is
 * used directly (no structural cast).
 *
 * Contract, executed inside the caller's transaction:
 *  1. the original posting is never edited or deleted (`posted` only);
 *  2. a real counter-entry reverses the original lines (debit <-> credit);
 *  3. a replacement entry carries the corrected figures;
 *  4. both new entries are sealed into the per-company journal hash chain
 *     through the shared `appendEntryToJournalChain` primitive;
 *  5. affected GL account balances are recalculated from posted lines;
 *  6. a link record is created; a second correction of the same original is
 *     refused with CORRECTION_DUPLICATE (pre-check + DB unique constraint).
 *
 * The replacement lines are validated here too (defense in depth: the HTTP
 * route returns the user-facing 400s, this is the last line before writing an
 * unbalanced entry into the ledger).
 */
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
    assertBalancedCorrectionLines(params.correctedLines);

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

    // 3) Link record: original kept intact; counter and replacement linked.
    // The pre-check above is TOCTOU-exposed; the @@unique([companyId,
    // originalEntryId]) constraint is the real guard, so a concurrent duplicate
    // is translated into the same CORRECTION_DUPLICATE contract instead of
    // leaking a raw Prisma error.
    const correction = await createCorrectionLink(tx, {
      companyId: params.companyId,
      originalEntryId: original.id,
      counterEntryId: counterEntry.id,
      replacementEntryId: replacementEntry.id,
      reason: params.reason,
      correctedByUserId: params.correctedByUserId,
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

/**
 * Creates the correction link, mapping the unique-constraint violation to the
 * public CORRECTION_DUPLICATE contract.
 */
async function createCorrectionLink(
  tx: Prisma.TransactionClient,
  data: {
    companyId: string;
    originalEntryId: string;
    counterEntryId: string;
    replacementEntryId: string;
    reason: string;
    correctedByUserId: string;
  },
) {
  try {
    return await tx.journalCorrection.create({ data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new Error('CORRECTION_DUPLICATE');
    }
    throw err;
  }
}

/**
 * Exact-cents invariant for the replacement entry: debits === credits (no
 * tolerance, same contract as GET/PUT/POST /api/journal/[id]) and single lines
 * carry a real GL account with finite, non-negative amounts.
 *
 * S3: the totals are accumulated as integer cents through src/lib/money.ts
 * (ROUND_HALF_UP) and compared with `compareCents`, so the accepted/rejected
 * decision never depends on float accumulation. For every 2-decimal amount this
 * is identical to the previous `Math.round(x * 100)` sum, and the user-facing
 * message keeps the same format.
 */
function assertBalancedCorrectionLines(
  lines: Array<{ glAccountId: string; debit: number; credit: number }>,
): void {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('CORRECTION_INVALID: at least 2 corrected journal lines are required');
  }
  let debitCents = 0;
  let creditCents = 0;
  for (const line of lines) {
    if (!line || typeof line.glAccountId !== 'string' || line.glAccountId.length === 0) {
      throw new Error('CORRECTION_INVALID: each corrected line must have a glAccountId');
    }
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    if (!Number.isFinite(debit) || !Number.isFinite(credit)) {
      throw new Error('CORRECTION_INVALID: debit and credit must be numeric');
    }
    if (debit < 0 || credit < 0) {
      throw new Error('CORRECTION_INVALID: debit and credit must be non-negative');
    }
    debitCents = sumCents(debitCents, toCents(debit));
    creditCents = sumCents(creditCents, toCents(credit));
  }
  if (compareCents(debitCents, creditCents) !== 0) {
    throw new Error(
      `Correction entry must balance. Total debits (${fromCents(debitCents).toFixed(2)}) must equal total credits (${fromCents(creditCents).toFixed(2)})`,
    );
  }
}
