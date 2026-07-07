import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { validateRequest } from '@/lib/validate-request';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';

const adjustmentSchema = z.object({
  bankAccountId: z.string().min(1),
  date: z.string().min(1),
  description: z.string().min(1),
  debitAccountId: z.string().min(1),
  creditAccountId: z.string().min(1),
  amount: z.number().positive('Amount must be greater than zero'),
  notes: z.string().optional().nullable(),
});

// ─── POST /api/reconciliation/adjustment ──────────────────────────
// Create an adjusting journal entry from the reconciliation screen.
// Body: { companyId, bankAccountId, date, description, debitAccountId, creditAccountId, amount, notes? }
export const POST = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await validateRequest(request, adjustmentSchema);
  if (body instanceof NextResponse) return body;
  const { bankAccountId, date, description, debitAccountId, creditAccountId, amount, notes } = body;

  if (!bankAccountId || !date || !description || !debitAccountId || !creditAccountId || !amount) {
    return NextResponse.json(
      {
        error:
          'All fields are required: bankAccountId, date, description, debitAccountId, creditAccountId, amount',
      },
      { status: 400 },
    );
  }

  if (amount <= 0) {
    return NextResponse.json({ error: 'Amount must be greater than zero' }, { status: 400 });
  }

  // Verify that the adjustment date is in an active fiscal period
  await assertActiveFiscalPeriod(companyId, date);

  // Verify bank account
  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
    include: { glAccount: { select: { id: true } } },
  });
  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  }

  // Verify GL accounts belong to company
  const [debitAccount, creditAccount] = await Promise.all([
    db.glAccount.findFirst({ where: { id: debitAccountId, companyId } }),
    db.glAccount.findFirst({ where: { id: creditAccountId, companyId } }),
  ]);

  if (!debitAccount || !creditAccount) {
    return NextResponse.json({ error: 'One or both GL accounts not found' }, { status: 404 });
  }

  const ref = `RECON-ADJ-${new Date().toISOString().split('T')[0]}`;

  // Create journal entry
  const entry = await db.journalEntry.create({
    data: {
      companyId,
      date: new Date(date),
      description: `[Reconciliation Adjustment] ${description}`,
      reference: ref,
      status: 'posted',
      lines: {
        create: [
          {
            glAccountId: debitAccountId,
            description,
            debit: amount,
            credit: 0,
          },
          {
            glAccountId: creditAccountId,
            description,
            debit: 0,
            credit: amount,
          },
        ],
      },
    },
  });

  // Audit log
  await db.auditLog.create({
    data: {
      companyId,
      userId,
      action: 'reconciliation_adjustment',
      entity: 'JournalEntry',
      entityId: entry.id,
      details: JSON.stringify({
        bankAccountId,
        journalEntryId: entry.id,
        debitAccountId,
        creditAccountId,
        amount,
        notes,
      }),
    },
  });

  return NextResponse.json({
    success: true,
    journalEntry: {
      id: entry.id,
      date: entry.date.toISOString(),
      reference: entry.reference,
      description: entry.description,
      debitAmount: amount,
      creditAmount: amount,
      debitAccount: { id: debitAccount.id, code: debitAccount.code, name: debitAccount.name },
      creditAccount: { id: creditAccount.id, code: creditAccount.code, name: creditAccount.name },
    },
  });
});
