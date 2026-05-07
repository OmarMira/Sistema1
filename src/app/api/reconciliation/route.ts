import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── GET /api/reconciliation ───────────────────────────────────────
// Get reconciliation data for a bank account.
// Query params: bankAccountId (required), companyId (required)
export async function GET(request: NextRequest) {
  const userId = getSessionUserId(request);
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

  // Verify access
  const membership = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Get bank account with GL account info
  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
    include: {
      glAccount: {
        select: { id: true, code: true, name: true, accountType: true, normalBalance: true },
      },
    },
  });

  if (!bankAccount) {
    return NextResponse.json(
      { error: 'Bank account not found' },
      { status: 404 }
    );
  }

  // Get latest statement (closing balance)
  const latestStatement = await db.bankStatement.findFirst({
    where: { bankAccountId },
    orderBy: { endDate: 'desc' },
    select: { id: true, endDate: true, closingBalance: true },
  });

  // Get unreconciled transactions
  const statements = await db.bankStatement.findMany({
    where: { bankAccountId },
    select: { id: true },
  });
  const statementIds = statements.map((s) => s.id);

  const unreconciledTransactions = await db.bankTransaction.findMany({
    where: {
      statementId: { in: statementIds },
      isReconciled: false,
    },
    orderBy: { date: 'asc' },
    include: {
      glAccount: {
        select: { id: true, code: true, name: true },
      },
      matchedRule: {
        select: { id: true, name: true },
      },
    },
  });

  // Get reconciled transactions count
  const reconciledCount = await db.bankTransaction.count({
    where: {
      statementId: { in: statementIds },
      isReconciled: true,
    },
  });

  const totalTransactions = await db.bankTransaction.count({
    where: {
      statementId: { in: statementIds },
    },
  });

  // Calculate book balance from GL account journal lines
  const journalLines = await db.journalLine.findMany({
    where: {
      glAccountId: bankAccount.glAccountId,
      entry: {
        companyId,
        status: 'posted',
      },
    },
    include: {
      entry: { select: { date: true } },
    },
  });

  // Calculate GL balance using normal balance rules
  let bookBalance = 0;
  const isDebitNormal = bankAccount.glAccount.normalBalance === 'debit';

  for (const line of journalLines) {
    if (isDebitNormal) {
      bookBalance += line.debit - line.credit;
    } else {
      bookBalance += line.credit - line.debit;
    }
  }

  // Statement balance
  const statementBalance = latestStatement?.closingBalance ?? bankAccount.balance;

  // Difference = Statement - Book
  const difference = statementBalance - bookBalance;

  // Categorize transactions
  const deposits = unreconciledTransactions.filter((tx) => tx.amount > 0);
  const payments = unreconciledTransactions.filter((tx) => tx.amount < 0);

  const depositsTotal = deposits.reduce((sum, tx) => sum + tx.amount, 0);
  const paymentsTotal = payments.reduce((sum, tx) => sum + tx.amount, 0);

  return NextResponse.json({
    bankAccount: {
      id: bankAccount.id,
      accountName: bankAccount.accountName,
      bankName: bankAccount.bankName,
      balance: bankAccount.balance,
      currency: bankAccount.currency,
      glAccount: bankAccount.glAccount,
    },
    latestStatement: latestStatement
      ? {
          ...latestStatement,
          endDate: latestStatement.endDate.toISOString(),
        }
      : null,
    summary: {
      statementBalance,
      bookBalance,
      difference,
      totalTransactions,
      reconciledCount,
      unreconciledCount: totalTransactions - reconciledCount,
      depositsTotal,
      paymentsTotal,
    },
    deposits: deposits.map((tx) => ({
      ...tx,
      date: tx.date.toISOString(),
      createdAt: tx.createdAt.toISOString(),
    })),
    payments: payments.map((tx) => ({
      ...tx,
      date: tx.date.toISOString(),
      createdAt: tx.createdAt.toISOString(),
    })),
  });
}

// ─── POST /api/reconciliation ──────────────────────────────────────
// Reconcile transactions. Sets isReconciled=true and updates glAccountId.
// Body: { companyId, bankAccountId, transactions: [{ id, glAccountId }] }
export async function POST(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { companyId, bankAccountId, transactions } = body;

    if (!companyId || !bankAccountId) {
      return NextResponse.json(
        { error: 'companyId and bankAccountId are required' },
        { status: 400 }
      );
    }

    if (!Array.isArray(transactions) || transactions.length === 0) {
      return NextResponse.json(
        { error: 'transactions array is required and must not be empty' },
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
    });
    if (!bankAccount) {
      return NextResponse.json(
        { error: 'Bank account not found' },
        { status: 404 }
      );
    }

    // Process each transaction
    let reconciledCount = 0;

    for (const tx of transactions) {
      if (!tx.id) continue;

      const updateData: Record<string, unknown> = { isReconciled: true };

      if (tx.glAccountId) {
        // Verify GL account belongs to company
        const glAccount = await db.glAccount.findFirst({
          where: { id: tx.glAccountId, companyId },
        });
        if (glAccount) {
          updateData.glAccountId = tx.glAccountId;
        }
      }

      await db.bankTransaction.update({
        where: { id: tx.id },
        data: updateData,
      });
      reconciledCount++;
    }

    return NextResponse.json({
      success: true,
      reconciled: reconciledCount,
    });
  } catch (error) {
    console.error('[RECONCILIATION ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
