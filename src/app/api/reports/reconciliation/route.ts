import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sessionStore } from '@/app/api/auth/me/route';

export async function GET(request: NextRequest) {
  try {
    const userId = getSessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const bankAccountId = searchParams.get('bankAccountId');

    if (!bankAccountId) {
      return NextResponse.json(
        { error: 'bankAccountId is required' },
        { status: 400 }
      );
    }

    // Get the bank account and verify access
    const bankAccount = await db.bankAccount.findUnique({
      where: { id: bankAccountId },
      include: {
        company: { select: { id: true } },
      },
    });

    if (!bankAccount || !bankAccount.company) {
      return NextResponse.json(
        { error: 'Bank account not found' },
        { status: 404 }
      );
    }

    // Verify company membership
    const membership = await db.companyMember.findFirst({
      where: { userId, companyId: bankAccount.company.id },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
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

    const reconciledTotal = reconciled.reduce(
      (sum, t) => sum + (t.amount || 0),
      0
    );
    const unreconciledTotal = unreconciled.reduce(
      (sum, t) => sum + (t.amount || 0),
      0
    );

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
          transactions.length > 0
            ? Math.round((reconciled.length / transactions.length) * 100)
            : 0,
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
  } catch (error) {
    console.error('[RECONCILIATION REPORT ERROR]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Get session user ID from the shared session store.
 */
function getSessionUserId(request: NextRequest): string | null {
  const token =
    request.cookies.get('session')?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const session = sessionStore.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
    sessionStore.delete(token);
    return null;
  }
  return session.userId;
}
