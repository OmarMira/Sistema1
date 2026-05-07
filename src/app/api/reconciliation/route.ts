import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── GET /api/reconciliation ───────────────────────────────────────
// Get reconciliation data for a bank account with filters.
// Query params: bankAccountId (required), companyId (required)
// Optional: startDate, endDate, status (all|unreconciled|reconciled), search, statementId, showReconciled
export async function GET(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const bankAccountId = searchParams.get('bankAccountId');
  const companyId = searchParams.get('companyId');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const statusFilter = searchParams.get('status') || 'unreconciled'; // all | unreconciled | reconciled
  const search = searchParams.get('search');
  const statementId = searchParams.get('statementId');

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

  // Get all statements for this bank account
  const statements = await db.bankStatement.findMany({
    where: { bankAccountId },
    select: { id: true, startDate: true, endDate: true, openingBalance: true, closingBalance: true, format: true, fileName: true },
    orderBy: { startDate: 'desc' },
  });
  const statementIds = statements.map((s) => s.id);

  // Build transaction query with filters
  const txWhere: Record<string, unknown> = {
    statementId: { in: statementIds },
  };

  // Status filter
  if (statusFilter === 'unreconciled') {
    txWhere.isReconciled = false;
  } else if (statusFilter === 'reconciled') {
    txWhere.isReconciled = true;
  }
  // 'all' = no filter

  // Statement filter
  if (statementId) {
    txWhere.statementId = statementId;
  }

  // Date range filter
  if (startDate || endDate) {
    txWhere.date = {};
    if (startDate) (txWhere.date as Record<string, unknown>).gte = new Date(startDate + 'T00:00:00.000Z');
    if (endDate) (txWhere.date as Record<string, unknown>).lte = new Date(endDate + 'T23:59:59.999Z');
  }

  // Search filter
  if (search) {
    txWhere.OR = [
      { description: { contains: search } },
      { reference: { contains: search } },
    ];
  }

  // Get transactions
  const transactions = await db.bankTransaction.findMany({
    where: txWhere,
    orderBy: { date: 'asc' },
    include: {
      glAccount: {
        select: { id: true, code: true, name: true },
      },
      matchedRule: {
        select: { id: true, name: true },
      },
      reconciliationPeriod: {
        select: { id: true, startedAt: true, completedAt: true },
      },
    },
  });

  // Get overall counts (all statements, no date/search filter)
  const reconciledCount = await db.bankTransaction.count({
    where: { statementId: { in: statementIds }, isReconciled: true },
  });
  const totalTransactions = await db.bankTransaction.count({
    where: { statementId: { in: statementIds } },
  });

  // Calculate book balance from GL account journal lines
  const journalLines = await db.journalLine.findMany({
    where: {
      glAccountId: bankAccount.glAccountId,
      entry: { companyId, status: 'posted' },
    },
    include: { entry: { select: { date: true } } },
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

  // Statement balance
  const statementBalance = latestStatement?.closingBalance ?? bankAccount.balance;
  const difference = statementBalance - bookBalance;

  // Categorize transactions
  const deposits = transactions.filter((tx) => tx.amount > 0);
  const payments = transactions.filter((tx) => tx.amount < 0);

  const depositsTotal = deposits.reduce((sum, tx) => sum + tx.amount, 0);
  const paymentsTotal = payments.reduce((sum, tx) => sum + tx.amount, 0);

  // Get current open reconciliation period
  const openPeriod = await db.reconciliationPeriod.findFirst({
    where: { bankAccountId, companyId, status: 'open' },
  });

  // Get recent completed periods (last 5)
  const recentPeriods = await db.reconciliationPeriod.findMany({
    where: { bankAccountId, companyId, status: 'completed' },
    orderBy: { completedAt: 'desc' },
    take: 5,
    include: {
      user: { select: { firstName: true, lastName: true } },
    },
  });

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
      ? { ...latestStatement, endDate: latestStatement.endDate.toISOString() }
      : null,
    statements: statements.map((s) => ({
      ...s,
      startDate: s.startDate.toISOString(),
      endDate: s.endDate.toISOString(),
    })),
    openPeriod,
    recentPeriods: recentPeriods.map((p) => ({
      ...p,
      startedAt: p.startedAt.toISOString(),
      completedAt: p.completedAt?.toISOString() ?? null,
    })),
    summary: {
      statementBalance,
      bookBalance,
      difference,
      totalTransactions,
      reconciledCount,
      unreconciledCount: totalTransactions - reconciledCount,
      depositsTotal,
      paymentsTotal,
      filteredCount: transactions.length,
    },
    deposits: deposits.map((tx) => ({
      ...tx,
      date: tx.date.toISOString(),
      createdAt: tx.createdAt.toISOString(),
      reconciledAt: tx.reconciledAt?.toISOString() ?? null,
    })),
    payments: payments.map((tx) => ({
      ...tx,
      date: tx.date.toISOString(),
      createdAt: tx.createdAt.toISOString(),
      reconciledAt: tx.reconciledAt?.toISOString() ?? null,
    })),
  });
}

// ─── POST /api/reconciliation ──────────────────────────────────────
// Reconcile transactions. Sets isReconciled=true and updates glAccountId.
// Can optionally create journal entries.
// Body: { companyId, bankAccountId, transactions: [{ id, glAccountId }], createJournalEntries?: boolean, periodId?: string }
export async function POST(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      companyId,
      bankAccountId,
      transactions,
      createJournalEntries = false,
      periodId,
    } = body;

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

    // Verify bank account with GL account info
    const bankAccount = await db.bankAccount.findFirst({
      where: { id: bankAccountId, companyId },
      include: {
        glAccount: {
          select: { id: true, code: true, name: true, normalBalance: true },
        },
      },
    });
    if (!bankAccount) {
      return NextResponse.json(
        { error: 'Bank account not found' },
        { status: 404 }
      );
    }

    let reconciledCount = 0;
    let journalEntriesCreated = 0;

    await db.$transaction(async (tx) => {
      for (const txn of transactions) {
        if (!txn.id) continue;

        const bankTx = await tx.bankTransaction.findUnique({
          where: { id: txn.id },
        });
        if (!bankTx || bankTx.isReconciled) continue;

        const updateData: Record<string, unknown> = {
          isReconciled: true,
          reconciledAt: new Date(),
        };

        if (txn.glAccountId) {
          const glAccount = await tx.glAccount.findFirst({
            where: { id: txn.glAccountId, companyId },
          });
          if (glAccount) {
            updateData.glAccountId = txn.glAccountId;
          }
        }

        if (periodId) {
          updateData.reconciliationPeriodId = periodId;
        }

        await tx.bankTransaction.update({
          where: { id: txn.id },
          data: updateData,
        });

        // Create journal entry if requested
        if (createJournalEntries) {
          const targetGlId = txn.glAccountId || bankTx.glAccountId;
          if (targetGlId) {
            const amount = Math.abs(bankTx.amount);
            const debitAccountId = bankTx.amount > 0
              ? bankAccount.glAccountId
              : targetGlId;
            const creditAccountId = bankTx.amount > 0
              ? targetGlId
              : bankAccount.glAccountId;

            const description = `Reconciliation: ${bankTx.description}`;

            await tx.journalEntry.create({
              data: {
                companyId,
                date: bankTx.date,
                description,
                status: 'posted',
                lines: {
                  create: [
                    { glAccountId: debitAccountId, description, debit: amount, credit: 0 },
                    { glAccountId: creditAccountId, description, debit: 0, credit: amount },
                  ],
                },
              },
            });
            journalEntriesCreated++;
          }
        }

        reconciledCount++;
      }

      // Update period transaction count if period provided
      if (periodId) {
        const periodTxCount = await tx.bankTransaction.count({
          where: { reconciliationPeriodId: periodId },
        });
        await tx.reconciliationPeriod.update({
          where: { id: periodId },
          data: { transactionCount: periodTxCount },
        });
      }
    });

    // Audit log
    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'reconcile_transactions',
        entity: 'BankTransaction',
        details: JSON.stringify({
          bankAccountId,
          count: reconciledCount,
          journalEntriesCreated,
          periodId,
        }),
      },
    });

    return NextResponse.json({
      success: true,
      reconciled: reconciledCount,
      journalEntriesCreated,
    });
  } catch (error) {
    console.error('[RECONCILIATION ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
