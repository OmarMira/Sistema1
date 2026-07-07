import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';
import { z } from 'zod';

// ─── GET /api/reconciliation/report ────────────────────────────────
// Get structured reconciliation report.
// Query params: bankAccountId (required), companyId (required)
const paramsSchema = z.object({
  bankAccountId: z.string().min(1, 'bankAccountId is required'),
  companyId: z.string().min(1, 'companyId is required'),
});

export async function GET(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const raw = {
    bankAccountId: searchParams.get('bankAccountId'),
    companyId: searchParams.get('companyId'),
  };

  const parsed = paramsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bankAccountId and companyId are required' },
      { status: 400 }
    );
  }

  const { bankAccountId, companyId } = parsed.data;

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

  // Get all statements for this bank account
  const statements = await db.bankStatement.findMany({
    where: { bankAccountId },
    select: { id: true },
  });
  const statementIds = statements.map((s) => s.id);

  // Calculate balancePerBooks from GL account journal lines
  const journalLines = await db.journalLine.findMany({
    where: {
      glAccountId: bankAccount.glAccountId,
      entry: { companyId, status: 'posted' },
    },
  });

  let balancePerBooks = 0;
  const isDebitNormal = bankAccount.glAccount.normalBalance === 'debit';
  for (const line of journalLines) {
    const debit = line.debit;
    const credit = line.credit;
    if (isDebitNormal) {
      balancePerBooks += debit - credit;
    } else {
      balancePerBooks += credit - debit;
    }
  }

  // Calculate balancePerStatement from bank account (sum of reconciled transactions)
  const reconciledResult = await db.bankTransaction.aggregate({
    where: {
      statementId: { in: statementIds },
      isReconciled: true,
    },
    _sum: { amount: true },
  });
  const balancePerStatement = Number(reconciledResult._sum.amount ?? 0);

  const difference = balancePerStatement - balancePerBooks;

  // Get reconciled items
  const reconciledItems = await db.bankTransaction.findMany({
    where: {
      statementId: { in: statementIds },
      isReconciled: true,
    },
    orderBy: { date: 'desc' },
    include: {
      glAccount: { select: { id: true, code: true, name: true } },
      journalEntry: { select: { id: true, reference: true } },
    },
  });

  // Get unreconciled (pending) items
  const unreconciledItems = await db.bankTransaction.findMany({
    where: {
      statementId: { in: statementIds },
      isReconciled: false,
      isIgnored: false,
    },
    orderBy: { date: 'desc' },
    include: {
      glAccount: { select: { id: true, code: true, name: true } },
    },
  });

  // Get ignored items
  const ignoredItems = await db.bankTransaction.findMany({
    where: {
      statementId: { in: statementIds },
      isIgnored: true,
    },
    orderBy: { date: 'desc' },
  });

  return NextResponse.json({
    bankAccount: {
      id: bankAccount.id,
      accountName: bankAccount.accountName,
      bankName: bankAccount.bankName,
      currency: bankAccount.currency,
      glAccount: bankAccount.glAccount,
    },
    report: {
      balancePerBooks: Math.round(balancePerBooks * 100) / 100,
      balancePerStatement: Math.round(balancePerStatement * 100) / 100,
      difference: Math.round(difference * 100) / 100,
      isBalanced: Math.abs(difference) < 0.01,
      generatedAt: new Date().toISOString(),
    },
    counts: {
      reconciledCount: reconciledItems.length,
      unreconciledCount: unreconciledItems.length,
      ignoredCount: ignoredItems.length,
      totalTransactions: reconciledItems.length + unreconciledItems.length + ignoredItems.length,
    },
    reconciledItems: reconciledItems.map((tx) => ({
      id: tx.id,
      date: tx.date.toISOString(),
      description: tx.description,
      amount: tx.amount,
      reference: tx.reference,
      glAccount: tx.glAccount,
      journalEntryId: tx.journalEntryId,
      journalEntryRef: tx.journalEntry?.reference ?? null,
      reconciledAt: tx.reconciledAt?.toISOString() ?? null,
    })),
    unreconciledItems: unreconciledItems.map((tx) => ({
      id: tx.id,
      date: tx.date.toISOString(),
      description: tx.description,
      amount: tx.amount,
      reference: tx.reference,
      glAccount: tx.glAccount,
    })),
    ignoredItems: ignoredItems.map((tx) => ({
      id: tx.id,
      date: tx.date.toISOString(),
      description: tx.description,
      amount: tx.amount,
      reference: tx.reference,
    })),
  });
}
