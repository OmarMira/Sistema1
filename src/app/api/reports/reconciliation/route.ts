import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const bankAccountId = searchParams.get('bankAccountId');

  if (!bankAccountId) {
    return NextResponse.json({ error: 'bankAccountId is required' }, { status: 400 });
  }

  // Get the bank account
  const bankAccount = await db.bankAccount.findUnique({
    where: { id: bankAccountId },
    include: {
      company: { select: { id: true } },
    },
  });

  if (!bankAccount || !bankAccount.company) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  }

  // Get all bank transactions for this bank account (via statements)
  const transactions = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccountId },
    },
    include: {
      glAccount: {
        select: { id: true, code: true, name: true },
      },
    },
    orderBy: { date: 'desc' },
  });

  // Categorize
  const reconciled = transactions.filter((t) => t.isReconciled);
  const unreconciled = transactions.filter((t) => !t.isReconciled);

  const reconciledTotal = reconciled.reduce((sum, t) => sum + (t.amount || 0), 0);
  const unreconciledTotal = unreconciled.reduce((sum, t) => sum + (t.amount || 0), 0);

  return NextResponse.json({
    bankAccount: {
      id: bankAccount.id,
      accountName: bankAccount.accountName,
      bankName: bankAccount.bankName,
      balance: bankAccount.balance,
      currency: bankAccount.currency,
    },
    summary: {
      totalTransactions: transactions.length,
      reconciledCount: reconciled.length,
      unreconciledCount: unreconciled.length,
      reconciledTotal: Math.round(reconciledTotal * 100) / 100,
      unreconciledTotal: Math.round(unreconciledTotal * 100) / 100,
      reconciledPercentage:
        transactions.length > 0 ? Math.round((reconciled.length / transactions.length) * 100) : 0,
    },
    reconciledTransactions: reconciled.map((t) => ({
      id: t.id,
      date: t.date.toISOString(),
      description: t.description,
      amount: t.amount,
      reference: t.reference,
      glAccount: t.glAccount
        ? { id: t.glAccount.id, code: t.glAccount.code, name: t.glAccount.name }
        : null,
    })),
    unreconciledTransactions: unreconciled.map((t) => ({
      id: t.id,
      date: t.date.toISOString(),
      description: t.description,
      amount: t.amount,
      reference: t.reference,
      glAccount: t.glAccount
        ? { id: t.glAccount.id, code: t.glAccount.code, name: t.glAccount.name }
        : null,
    })),
  });
});
