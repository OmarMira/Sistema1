import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { assertCompanyModuleEntitlement } from '@/lib/module-entitlement-guard';
import { requireActiveTenantAccess, requireCompanyRole } from '@/lib/rbac';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { JournalCorrectionService } from '@/lib/services/journal-correction.service';
import { createAuditLogWithRetry } from '@/lib/audit';

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

// Keep the integration intact, but do not expose it before isolated tests are approved.
const integratedPOST = apiHandler(
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
            correctedLines: correctedLines.map((l: { glAccountId: string; debit: number; credit: number; description?: string | null }) => ({
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
      if (errorMessage.includes('Only posted entries') || errorMessage.includes('Only draft entries')) {
        return NextResponse.json({ error: errorMessage }, { status: 400 });
      }
      if (errorMessage.includes('closed period')) {
        return NextResponse.json({ error: errorMessage }, { status: 403 });
      }
      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  },
);

// Unconditional hold: neither environment flags nor request data can enable writes.
export const POST: typeof integratedPOST = async () => NextResponse.json(
  {
    blocked: true,
    message: 'Correction unavailable until isolated accounting integrity tests are approved.',
  },
  { status: 503, headers: { 'Cache-Control': 'no-store' } },
);
