import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { Prisma } from '@prisma/client';

interface AccountBalance {
  code: string;
  name: string;
  accountType: string;
  debitTotal: number;
  creditTotal: number;
  normalBalance: string;
}

interface GlAccountInfo {
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  isActive: boolean;
}

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const asOfDateParam = searchParams.get('asOfDate');

  // Parse as-of date (defaults to today)
  const asOfDate = asOfDateParam ? new Date(asOfDateParam + 'T23:59:59.999Z') : new Date();

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
      entry: {
        select: {
          description: true,
        },
      },
    },
  });

  // Fetch virtual entries from reconciled bank transactions
  const bankTxWhere: Prisma.BankTransactionWhereInput = {
    statement: { bankAccount: { companyId } },
    isReconciled: true,
    glAccountId: { not: null },
    date: { lte: asOfDate },
  };

  const reconciledTxs = await db.bankTransaction.findMany({
    where: bankTxWhere,
    select: {
      amount: true,
      description: true,
      journalLineId: true,
      glAccount: {
        select: {
          code: true,
          name: true,
          accountType: true,
          normalBalance: true,
          isActive: true,
        },
      },
      statement: {
        select: {
          bankAccount: {
            select: {
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
          },
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

  const addBalance = (acc: GlAccountInfo, debit: number, credit: number) => {
    if (!acc || !acc.isActive) return;
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
    entry.debitTotal += debit || 0;
    entry.creditTotal += credit || 0;
  };

  for (const line of journalLines) {
    addBalance(line.glAccount, line.debit || 0, line.credit || 0);
  }

  for (const tx of reconciledTxs) {
    if (!tx.glAccount) continue;
    if (tx.journalLineId) continue;

    const isDeposit = Number(tx.amount) > 0;
    const absAmount = Math.abs(tx.amount);

    addBalance(tx.glAccount, isDeposit ? 0 : absAmount, isDeposit ? absAmount : 0);

    const bankGlAccount = tx.statement.bankAccount.glAccount;
    if (bankGlAccount) {
      addBalance(bankGlAccount, isDeposit ? absAmount : 0, isDeposit ? 0 : absAmount);
    }
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
    a.code.localeCompare(b.code, undefined, { numeric: true }),
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
});

