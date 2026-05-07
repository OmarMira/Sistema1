import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── POST /api/reconciliation/adjustment ──────────────────────────
// Create an adjusting journal entry from the reconciliation screen.
// Body: { companyId, bankAccountId, date, description, debitAccountId, creditAccountId, amount, notes? }
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      companyId,
      bankAccountId,
      date,
      description,
      debitAccountId,
      creditAccountId,
      amount,
      notes,
    } = body;

    if (!companyId || !bankAccountId || !date || !description || !debitAccountId || !creditAccountId || !amount) {
      return NextResponse.json(
        { error: 'All fields are required: companyId, bankAccountId, date, description, debitAccountId, creditAccountId, amount' },
        { status: 400 }
      );
    }

    if (amount <= 0) {
      return NextResponse.json(
        { error: 'Amount must be greater than zero' },
        { status: 400 }
      );
    }

    // Verify access
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Verify bank account
    const bankAccount = await db.bankAccount.findFirst({
      where: { id: bankAccountId, companyId },
      include: { glAccount: { select: { id: true } } },
    });
    if (!bankAccount) {
      return NextResponse.json(
        { error: 'Bank account not found' },
        { status: 404 }
      );
    }

    // Verify GL accounts belong to company
    const [debitAccount, creditAccount] = await Promise.all([
      db.glAccount.findFirst({ where: { id: debitAccountId, companyId } }),
      db.glAccount.findFirst({ where: { id: creditAccountId, companyId } }),
    ]);

    if (!debitAccount || !creditAccount) {
      return NextResponse.json(
        { error: 'One or both GL accounts not found' },
        { status: 404 }
      );
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
  } catch (error) {
    console.error('[RECONCILIATION ADJUSTMENT ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
