import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { assertCompanyModuleEntitlement } from '@/lib/module-entitlement-guard';
import { requireActiveTenantAccess, requireCompanyRole } from '@/lib/rbac';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { compareCents, fromCents, sumCents, toCents } from '@/lib/money';
import { JournalCorrectionService } from '@/lib/services/journal-correction.service';
import { createAuditLogWithRetry } from '@/lib/audit';

/**
 * S24 — JournalCorrection disposition: ENABLED.
 *
 * The correction flow used to be hard-held at 503 while its blockers were open
 * (missing `model JournalCorrection`, stale service delegate). Both are
 * resolved, so the route is live behind `company_admin`: a correction is an
 * accounting-critical operation on a POSTED ledger entry, exactly like
 * post/void in the sibling route.
 *
 * The underlying service keeps the original posting intact and writes a
 * counter-entry + replacement entry, sealed into the company journal hash
 * chain, with balances recalculated — all inside one transaction.
 */

type CorrectedLine = { glAccountId: string; debit: number; credit: number; description?: string | null };

async function requireActiveTenantAccessForEntry(
  userId: string,
  entryCompanyId: string,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });
  await requireActiveTenantAccess(entryCompanyId, { userId, role: user?.platformRole ?? '' });
}

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const { id } = await context.params;

    const entry = await db.journalEntry.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });

    if (entry.status !== 'posted') {
      return NextResponse.json({ error: 'Only posted entries can be corrected' }, { status: 400 });
    }

    await requireActiveTenantAccessForEntry(userId, entry.companyId);
    await requireCompanyRole(entry.companyId, ['company_admin']);
    await assertCompanyModuleEntitlement(entry.companyId, 'accounting');

    // Instructions as of S24: an entry generated from a bank transaction is
    // covered by the bank flows (reconcile / apply / reclassify), same rule the
    // void action applies. Correcting it here would leave the transaction
    // linked to the neutralized original while the replacement is unlinked, so
    // the movement would vanish from bank reconciliation and reports.
    const linkedTransaction = await db.bankTransaction.findFirst({
      where: { journalEntryId: id },
      select: { id: true },
    });
    if (linkedTransaction) {
      return NextResponse.json(
        {
          error:
            'No se puede corregir un asiento vinculado a una transacción bancaria. Reclasificá la transacción en su lugar.',
        },
        { status: 400 },
      );
    }

    const body = await request.json();
    const { correctionDate, reason, correctedLines } = body;

    if (!correctionDate) {
      return NextResponse.json({ error: 'correctionDate is required' }, { status: 400 });
    }
    const correctionDateObj = new Date(correctionDate);
    if (isNaN(correctionDateObj.getTime())) {
      return NextResponse.json({ error: 'correctionDate must be a valid date' }, { status: 400 });
    }
    if (!reason || typeof reason !== 'string') {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 });
    }
    if (!Array.isArray(correctedLines) || correctedLines.length < 2) {
      return NextResponse.json({ error: 'At least 2 corrected journal lines are required' }, { status: 400 });
    }

    // Per-line shape: the replacement entry is POSTED, so it must satisfy the
    // same contract as every other posting path before it reaches the ledger.
    for (const line of correctedLines as CorrectedLine[]) {
      if (!line || typeof line.glAccountId !== 'string' || line.glAccountId.length === 0) {
        return NextResponse.json({ error: 'Each corrected line must have a glAccountId' }, { status: 400 });
      }
      if (typeof line.debit !== 'number' || typeof line.credit !== 'number') {
        return NextResponse.json(
          { error: 'Each corrected line must have numeric debit and credit amounts' },
          { status: 400 },
        );
      }
      if (!Number.isFinite(line.debit) || !Number.isFinite(line.credit)) {
        return NextResponse.json(
          { error: 'Each corrected line must have numeric debit and credit amounts' },
          { status: 400 },
        );
      }
      if (line.debit < 0 || line.credit < 0) {
        return NextResponse.json(
          { error: 'Debit and credit amounts must be non-negative' },
          { status: 400 },
        );
      }
    }

    // Exact cents — no ±tolerance (mirrors JournalService.create / PUT).
    // S3: accumulated through src/lib/money.ts (ROUND_HALF_UP) exactly like
    // JournalCorrectionService.assertBalancedCorrectionLines, so the route and
    // the service that re-checks the same lines can never disagree.
    let totalDebitCents = 0;
    let totalCreditCents = 0;
    for (const line of correctedLines as CorrectedLine[]) {
      totalDebitCents = sumCents(totalDebitCents, toCents(line.debit));
      totalCreditCents = sumCents(totalCreditCents, toCents(line.credit));
    }
    if (compareCents(totalDebitCents, totalCreditCents) !== 0) {
      return NextResponse.json(
        {
          error: `Correction entry must balance. Total debits (${fromCents(totalDebitCents).toFixed(2)}) must equal total credits (${fromCents(totalCreditCents).toFixed(2)})`,
        },
        { status: 400 },
      );
    }

    // Tenant boundary for the replacement lines: a GL account of another
    // company must never receive a line through this route.
    const accountIds = [...new Set(correctedLines.map((l: CorrectedLine) => l.glAccountId))];
    const accounts = await db.glAccount.findMany({
      where: { id: { in: accountIds }, companyId: entry.companyId },
      select: { id: true },
    });
    if (accounts.length !== accountIds.length) {
      return NextResponse.json(
        { error: 'One or more GL accounts not found or do not belong to this company' },
        { status: 400 },
      );
    }

    try {
      const result = await db.$transaction(async (tx) => {
        await assertActiveFiscalPeriod(
          entry.companyId,
          correctionDateObj,
          tx as any,
        );

        const correctionResult = await JournalCorrectionService.applyCorrection(
          tx as any,
          {
            originalEntryId: entry.id,
            companyId: entry.companyId,
            correctedLines: (correctedLines as CorrectedLine[]).map((l) => ({
              glAccountId: l.glAccountId,
              debit: l.debit,
              credit: l.credit,
              description: l.description ?? null,
            })),
            reason: reason,
            correctedByUserId: userId,
            correctionDate: correctionDateObj,
          },
        );

        await createAuditLogWithRetry(
          { companyId: entry.companyId, userId, action: 'correction', entity: 'journalEntry', entityId: entry.id },
          tx as any,
        );

        return correctionResult;
      });

      return NextResponse.json({
        originalEntryId: entry.id,
        counterEntryId: result.counterEntry.id,
        replacementEntryId: result.replacementEntry.id,
        correctionId: result.correctionId,
        message: 'Correction applied successfully',
      }, { status: 200 });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      if (errorMessage.includes('CORRECTION_DUPLICATE') || errorMessage.includes('CHAIN_')) {
        return NextResponse.json({ error: errorMessage }, { status: 409 });
      }
      if (
        errorMessage.includes('CORRECTION_INVALID') ||
        errorMessage.includes('must balance') ||
        errorMessage.includes('Only posted entries') ||
        errorMessage.includes('Only draft entries')
      ) {
        return NextResponse.json({ error: errorMessage }, { status: 400 });
      }
      if (errorMessage.includes('closed period') || errorMessage.includes('período cerrado')) {
        return NextResponse.json({ error: errorMessage }, { status: 403 });
      }
      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  },
);
