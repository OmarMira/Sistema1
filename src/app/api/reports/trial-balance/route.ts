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
    const companyId = searchParams.get('companyId');
    const asOfDateParam = searchParams.get('asOfDate');

    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    // Verify company membership
    const membership = await db.companyMember.findFirst({
      where: { userId, companyId },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Parse as-of date (defaults to today)
    const asOfDate = asOfDateParam
      ? new Date(asOfDateParam + 'T23:59:59.999Z')
      : new Date();

    if (isNaN(asOfDate.getTime())) {
      return NextResponse.json({ error: 'Invalid asOfDate format' }, { status: 400 });
    }

    // Get all posted journal lines up to the asOfDate for this company
    const journalLines = await db.journalLine.findMany({
      where: {
        entry: {
          companyId,
          status: 'posted',
          date: { lte: asOfDate },
        },
      },
      include: {
        glAccount: {
          select: {
            code: true,
            name: true,
            accountType: true,
            normalBalance: true,
            isActive: true,
          },
        },
      },
    });

    // Aggregate balances per GL account
    const accountBalances = new Map<
      string,
      {
        code: string;
        name: string;
        accountType: string;
        debitTotal: number;
        creditTotal: number;
        normalBalance: string;
      }
    >();

    for (const line of journalLines) {
      const acc = line.glAccount;
      if (!acc || !acc.isActive) continue;

      const key = acc.code;
      if (!accountBalances.has(key)) {
        accountBalances.set(key, {
          code: acc.code,
          name: acc.name,
          accountType: acc.accountType,
          debitTotal: 0,
          creditTotal: 0,
          normalBalance: acc.normalBalance,
        });
      }

      const entry = accountBalances.get(key)!;
      entry.debitTotal += line.debit || 0;
      entry.creditTotal += line.credit || 0;
    }

    // Build result: for each account, calculate net balance adjusted for normal balance
    const accounts: {
      code: string;
      name: string;
      accountType: string;
      debit: number;
      credit: number;
      balance: number;
    }[] = [];

    let totalDebits = 0;
    let totalCredits = 0;

    const sortedEntries = Array.from(accountBalances.values()).sort((a, b) =>
      a.code.localeCompare(b.code, undefined, { numeric: true })
    );

    for (const entry of sortedEntries) {
      // Calculate net balance: debits - credits, adjusted for normal balance
      // Debit-normal accounts (Asset, Expense): balance = debitTotal - creditTotal
      // Credit-normal accounts (Liability, Equity, Revenue): balance = creditTotal - debitTotal
      const netBalance =
        entry.normalBalance === 'debit'
          ? entry.debitTotal - entry.creditTotal
          : entry.creditTotal - entry.debitTotal;

      // Skip zero-balance accounts
      if (Math.abs(netBalance) < 0.005) continue;

      accounts.push({
        code: entry.code,
        name: entry.name,
        accountType: entry.accountType,
        debit: Math.round(entry.debitTotal * 100) / 100,
        credit: Math.round(entry.creditTotal * 100) / 100,
        balance: Math.round(netBalance * 100) / 100,
      });

      totalDebits += entry.debitTotal;
      totalCredits += entry.creditTotal;
    }

    return NextResponse.json({
      accounts,
      totalDebits: Math.round(totalDebits * 100) / 100,
      totalCredits: Math.round(totalCredits * 100) / 100,
      asOfDate: asOfDate.toISOString(),
    });
  } catch (error) {
    console.error('[TRIAL BALANCE ERROR]', error);
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
