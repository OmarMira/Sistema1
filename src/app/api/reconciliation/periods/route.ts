import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── POST /api/reconciliation/periods ─────────────────────────────
// Create, complete, or cancel a reconciliation period.
// Body: { companyId, bankAccountId, action: 'start'|'complete'|'cancel', periodId?, notes? }
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { companyId, bankAccountId, action, periodId, notes } = body;

    if (!companyId || !bankAccountId || !action) {
      return NextResponse.json(
        { error: 'companyId, bankAccountId, and action are required' },
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
      include: { glAccount: { select: { id: true, normalBalance: true } } },
    });
    if (!bankAccount) {
      return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
    }

    switch (action) {
      case 'start': {
        // Check if there's already an open period
        const existing = await db.reconciliationPeriod.findFirst({
          where: { bankAccountId, companyId, status: 'open' },
        });
        if (existing) {
          return NextResponse.json({
            success: false,
            error: 'An open reconciliation period already exists for this account.',
            period: existing,
          }, { status: 409 });
        }

        // Calculate statement balance
        const latestStatement = await db.bankStatement.findFirst({
          where: { bankAccountId },
          orderBy: { endDate: 'desc' },
          select: { closingBalance: true },
        });

        // Calculate book balance
        const journalLines = await db.journalLine.findMany({
          where: {
            glAccountId: bankAccount.glAccountId,
            entry: { companyId, status: 'posted' },
          },
        });

        let bookBalance = 0;
        const isDebitNormal = bankAccount.glAccount.normalBalance === 'debit';
        for (const line of journalLines) {
          if (isDebitNormal) {
            bookBalance += line.debit - line.credit;
          } else {
            bookBalance += line.credit - line.debit;
          }
        }

        const stmtBalance = latestStatement?.closingBalance ?? bankAccount.balance;

        const period = await db.reconciliationPeriod.create({
          data: {
            companyId,
            bankAccountId,
            userId,
            statementBalance: stmtBalance,
            bookBalance,
            difference: stmtBalance - bookBalance,
            status: 'open',
            notes,
          },
        });

        await db.auditLog.create({
          data: {
            companyId,
            userId,
            action: 'start_reconciliation_period',
            entity: 'ReconciliationPeriod',
            entityId: period.id,
            details: JSON.stringify({ bankAccountId, statementBalance: stmtBalance, bookBalance, difference: stmtBalance - bookBalance }),
          },
        });

        return NextResponse.json({ success: true, period });
      }

      case 'complete': {
        if (!periodId) {
          return NextResponse.json({ error: 'periodId is required for complete action' }, { status: 400 });
        }

        const period = await db.reconciliationPeriod.findFirst({
          where: { id: periodId, bankAccountId, companyId, status: 'open' },
        });
        if (!period) {
          return NextResponse.json({ error: 'Open reconciliation period not found' }, { status: 404 });
        }

        // Recalculate balances
        const latestStatement = await db.bankStatement.findFirst({
          where: { bankAccountId },
          orderBy: { endDate: 'desc' },
          select: { closingBalance: true },
        });

        const journalLines = await db.journalLine.findMany({
          where: {
            glAccountId: bankAccount.glAccountId,
            entry: { companyId, status: 'posted' },
          },
        });

        let bookBalance = 0;
        const isDebitNormal = bankAccount.glAccount.normalBalance === 'debit';
        for (const line of journalLines) {
          if (isDebitNormal) {
            bookBalance += line.debit - line.credit;
          } else {
            bookBalance += line.credit - line.debit;
          }
        }

        const stmtBalance = latestStatement?.closingBalance ?? bankAccount.balance;

        const updated = await db.reconciliationPeriod.update({
          where: { id: periodId },
          data: {
            status: 'completed',
            completedAt: new Date(),
            statementBalance: stmtBalance,
            bookBalance,
            difference: stmtBalance - bookBalance,
            notes: notes || period.notes,
          },
        });

        await db.auditLog.create({
          data: {
            companyId,
            userId,
            action: 'complete_reconciliation_period',
            entity: 'ReconciliationPeriod',
            entityId: periodId,
            details: JSON.stringify({ statementBalance: stmtBalance, bookBalance, difference: stmtBalance - bookBalance }),
          },
        });

        return NextResponse.json({ success: true, period: updated });
      }

      case 'cancel': {
        if (!periodId) {
          return NextResponse.json({ error: 'periodId is required for cancel action' }, { status: 400 });
        }

        const period = await db.reconciliationPeriod.findFirst({
          where: { id: periodId, bankAccountId, companyId, status: 'open' },
        });
        if (!period) {
          return NextResponse.json({ error: 'Open reconciliation period not found' }, { status: 404 });
        }

        // Unlink transactions from this period
        await db.bankTransaction.updateMany({
          where: { reconciliationPeriodId: periodId },
          data: { reconciliationPeriodId: null },
        });

        const updated = await db.reconciliationPeriod.update({
          where: { id: periodId },
          data: { status: 'cancelled', completedAt: new Date() },
        });

        await db.auditLog.create({
          data: {
            companyId,
            userId,
            action: 'cancel_reconciliation_period',
            entity: 'ReconciliationPeriod',
            entityId: periodId,
          },
        });

        return NextResponse.json({ success: true, period: updated });
      }

      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: start, complete, or cancel' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[RECONCILIATION PERIODS ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ─── GET /api/reconciliation/periods ──────────────────────────────
// Get reconciliation history for a bank account.
export async function GET(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const bankAccountId = searchParams.get('bankAccountId');
  const companyId = searchParams.get('companyId');

  if (!bankAccountId || !companyId) {
    return NextResponse.json(
      { error: 'bankAccountId and companyId are required' },
      { status: 400 }
    );
  }

  const membership = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const periods = await db.reconciliationPeriod.findMany({
    where: { bankAccountId, companyId },
    orderBy: { startedAt: 'desc' },
    include: {
      user: { select: { id: true, firstName: true, lastName: true } },
      transactions: {
        select: { id: true },
      },
    },
  });

  return NextResponse.json({
    periods: periods.map((p) => ({
      ...p,
      startedAt: p.startedAt.toISOString(),
      completedAt: p.completedAt?.toISOString() ?? null,
      transactionCount: p.transactions.length,
      transactions: undefined,
    })),
  });
}
