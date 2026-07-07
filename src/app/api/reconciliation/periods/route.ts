import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { validateRequest } from '@/lib/validate-request';

const reconciliationPeriodSchema = z.object({
  bankAccountId: z.string().min(1),
  action: z.enum(['start', 'complete', 'cancel']),
  periodId: z.string().optional(),
  notes: z.string().optional().nullable(),
});

// ─── POST /api/reconciliation/periods ─────────────────────────────
// Create, complete, or cancel a reconciliation period.
// Body: { companyId, bankAccountId, action: 'start'|'complete'|'cancel', periodId?, notes? }
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await validateRequest(request, reconciliationPeriodSchema);
  if (body instanceof NextResponse) return body;
  const { bankAccountId, action, periodId, notes } = body;

  if (!companyId || !bankAccountId || !action) {
    return NextResponse.json(
      { error: 'companyId, bankAccountId, and action are required' },
      { status: 400 },
    );
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
        return NextResponse.json(
          {
            success: false,
            error: 'An open reconciliation period already exists for this account.',
            period: existing,
          },
          { status: 409 },
        );
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
          bookBalance += Number(line.debit) - Number(line.credit);
        } else {
          bookBalance += Number(line.credit) - Number(line.debit);
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
          details: JSON.stringify({
            bankAccountId,
            statementBalance: stmtBalance,
            bookBalance,
            difference: stmtBalance - bookBalance,
          }),
        },
      });

      return NextResponse.json({ success: true, period });
    }

    case 'complete': {
      if (!periodId) {
        return NextResponse.json(
          { error: 'periodId is required for complete action' },
          { status: 400 },
        );
      }

      const period = await db.reconciliationPeriod.findFirst({
        where: { id: periodId, bankAccountId, companyId, status: 'open' },
      });
      if (!period) {
        return NextResponse.json(
          { error: 'Open reconciliation period not found' },
          { status: 404 },
        );
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
          bookBalance += Number(line.debit) - Number(line.credit);
        } else {
          bookBalance += Number(line.credit) - Number(line.debit);
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
          details: JSON.stringify({
            statementBalance: stmtBalance,
            bookBalance,
            difference: stmtBalance - bookBalance,
          }),
        },
      });

      return NextResponse.json({ success: true, period: updated });
    }

    case 'cancel': {
      if (!periodId) {
        return NextResponse.json(
          { error: 'periodId is required for cancel action' },
          { status: 400 },
        );
      }

      const period = await db.reconciliationPeriod.findFirst({
        where: { id: periodId, bankAccountId, companyId, status: 'open' },
      });
      if (!period) {
        return NextResponse.json(
          { error: 'Open reconciliation period not found' },
          { status: 404 },
        );
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
        { status: 400 },
      );
  }
});

// ─── GET /api/reconciliation/periods ──────────────────────────────
// Get reconciliation history for a bank account.
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const bankAccountId = searchParams.get('bankAccountId');

  if (!bankAccountId || !companyId) {
    return NextResponse.json(
      { error: 'bankAccountId and companyId are required' },
      { status: 400 },
    );
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
});

