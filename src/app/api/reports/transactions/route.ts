import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { Prisma } from '@prisma/client';

interface TransactionLine {
  id: string;
  glAccountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  description: string;
  debit: number;
  credit: number;
}

interface CombinedEntry {
  id: string;
  date: Date;
  description: string;
  reference: string | null;
  status: string;
  lines: TransactionLine[];
}

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const startDateParam = searchParams.get('startDate');
  const endDateParam = searchParams.get('endDate');
  const glAccountId = searchParams.get('glAccountId');
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '25', 10) || 25));

  // Build where clause
  const where: Record<string, unknown> = {
    companyId,
    status: 'posted',
  };

  if (startDateParam || endDateParam) {
    where.date = {};
    if (startDateParam) {
      (where.date as Record<string, unknown>).gte = new Date(startDateParam + 'T00:00:00.000Z');
    }
    if (endDateParam) {
      (where.date as Record<string, unknown>).lte = new Date(endDateParam + 'T23:59:59.999Z');
    }
  }

  // Line filter for specific GL account
  const lineWhere: Record<string, unknown> = {};
  if (glAccountId) {
    lineWhere.glAccountId = glAccountId;
  }

  // Fetch real journal entries matching filter
  const realEntries = await db.journalEntry.findMany({
    where,
    include: {
      lines: {
        include: {
          glAccount: {
            select: {
              id: true,
              code: true,
              name: true,
              accountType: true,
              normalBalance: true,
            },
          },
        },
      },
    },
    orderBy: { date: 'desc' },
  });

  const realDescSet = new Set(realEntries.map((e) => e.description));

  // Fetch virtual entries from reconciled bank transactions
  const bankTxWhere: Prisma.BankTransactionWhereInput = {
    statement: { bankAccount: { companyId } },
    isReconciled: true,
    glAccountId: { not: null },
  };

  if (startDateParam || endDateParam) {
    bankTxWhere.date = {};
    if (startDateParam) bankTxWhere.date.gte = new Date(startDateParam + 'T00:00:00.000Z');
    if (endDateParam) bankTxWhere.date.lte = new Date(endDateParam + 'T23:59:59.999Z');
  }

  const reconciledTxs = await db.bankTransaction.findMany({
    where: bankTxWhere,
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      reference: true,
      glAccount: {
        select: { id: true, code: true, name: true, accountType: true, normalBalance: true },
      },
      statement: {
        select: {
          bankAccount: {
            select: {
              glAccount: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  accountType: true,
                  normalBalance: true,
                },
              },
            },
          },
        },
      },
    },
  });

  // Convert real entries to standardized format
  const combinedEntries: CombinedEntry[] = realEntries.map((entry) => ({
    id: entry.id,
    date: entry.date,
    description: entry.description,
    reference: entry.reference,
    status: entry.status,
    lines: entry.lines.map((l) => ({
      id: l.id,
      glAccountId: l.glAccountId,
      accountCode: l.glAccount.code,
      accountName: l.glAccount.name,
      accountType: l.glAccount.accountType,
      description: l.description ?? '',
      debit: l.debit || 0,
      credit: l.credit || 0,
    })),
  }));

  // Add virtual entries
  for (const tx of reconciledTxs) {
    if (!tx.glAccount) continue;
    if (realDescSet.has(`Reconciliation: ${tx.description}`)) continue;

    const isDeposit = Number(tx.amount) > 0;
    const absAmount = Math.abs(tx.amount);
    const bankGlAccount = tx.statement.bankAccount.glAccount;

    const lines: TransactionLine[] = [];

    // The assigned GL Account line
    lines.push({
      id: tx.id + '-1',
      glAccountId: tx.glAccount.id,
      accountCode: tx.glAccount.code,
      accountName: tx.glAccount.name,
      accountType: tx.glAccount.accountType,
      description: tx.description,
      debit: isDeposit ? 0 : absAmount,
      credit: isDeposit ? absAmount : 0,
    });

    // The Bank Asset Account line
    if (bankGlAccount) {
      lines.push({
        id: tx.id + '-2',
        glAccountId: bankGlAccount.id,
        accountCode: bankGlAccount.code,
        accountName: bankGlAccount.name,
        accountType: bankGlAccount.accountType,
        description: tx.description,
        debit: isDeposit ? absAmount : 0,
        credit: isDeposit ? 0 : absAmount,
      });
    }

    combinedEntries.push({
      id: tx.id,
      date: tx.date,
      description: tx.description,
      reference: tx.reference,
      status: 'posted',
      lines,
    });
  }

  // Sort by date descending
  combinedEntries.sort((a, b) => b.date.getTime() - a.date.getTime());

  // Apply GL Account filter if provided
  const filteredEntries = glAccountId
    ? combinedEntries.filter((e) => e.lines.some((l: TransactionLine) => l.glAccountId === glAccountId))
    : combinedEntries;

  const totalCount = filteredEntries.length;

  // Paginate
  const paginatedEntries = filteredEntries.slice((page - 1) * limit, page * limit);

  const result = paginatedEntries.map((entry) => {
    const totalDebit = entry.lines.reduce((sum: number, l: TransactionLine) => sum + Number(l.debit), 0);
    const totalCredit = entry.lines.reduce((sum: number, l: TransactionLine) => sum + Number(l.credit), 0);
    return {
      ...entry,
      date: entry.date.toISOString(),
      _totalDebit: Math.round(totalDebit * 100) / 100,
      _totalCredit: Math.round(totalCredit * 100) / 100,
    };
  });

  return NextResponse.json({
    data: result,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
    },
  });
});

