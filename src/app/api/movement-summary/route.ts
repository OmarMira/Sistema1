import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { Prisma } from '@prisma/client';
import { readJsonConfig } from '@/lib/config-loader';

export const GET = apiHandler(async (request: NextRequest) => {
  try {
    const { companyId } = requireCompanyContext();
    const { searchParams } = new URL(request.url);
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');
    const accountId = searchParams.get('accountId');

    const rangeOnly = searchParams.get('rangeOnly') === 'true';
    if (rangeOnly) {
      const earliestEntry = await db.journalEntry.findFirst({
        where: { companyId, status: 'posted' },
        orderBy: { date: 'asc' },
        select: { date: true },
      });
      const latestEntry = await db.journalEntry.findFirst({
        where: { companyId, status: 'posted' },
        orderBy: { date: 'desc' },
        select: { date: true },
      });

      const earliestBankTx = await db.bankTransaction.findFirst({
        where: { statement: { bankAccount: { companyId } }, isReconciled: true, glAccountId: { not: null } },
        orderBy: { date: 'asc' },
        select: { date: true },
      });
      const latestBankTx = await db.bankTransaction.findFirst({
        where: { statement: { bankAccount: { companyId } }, isReconciled: true, glAccountId: { not: null } },
        orderBy: { date: 'desc' },
        select: { date: true },
      });

      let minDate: string | null = null;
      let maxDate: string | null = null;

      const dates: Date[] = [];
      if (earliestEntry) dates.push(earliestEntry.date);
      if (latestEntry) dates.push(latestEntry.date);
      if (earliestBankTx) dates.push(earliestBankTx.date);
      if (latestBankTx) dates.push(latestBankTx.date);

      if (dates.length > 0) {
        const sortedDates = dates.sort((a, b) => a.getTime() - b.getTime());
        minDate = sortedDates[0].toISOString().split('T')[0];
        maxDate = sortedDates[sortedDates.length - 1].toISOString().split('T')[0];
      }

      return NextResponse.json({ minDate, maxDate });
    }

    // Build where clause
    const where: Prisma.JournalEntryWhereInput = {
      companyId,
      status: 'posted',
    };

    // Date filter
    if (fromDate || toDate) {
      const dateWhere: Prisma.DateTimeFilter = {};
      if (fromDate) {
        dateWhere.gte = new Date(fromDate + 'T00:00:00.000Z');
      }
      if (toDate) {
        dateWhere.lte = new Date(toDate + 'T23:59:59.999Z');
      }
      where.date = dateWhere;
    }

    // Line-level account filter
    const lineWhere: Prisma.JournalLineWhereInput = {};
    if (accountId) {
      lineWhere.glAccountId = accountId;
    }

    // Fetch journal entries with their lines and GL accounts
    const entries = await db.journalEntry.findMany({
      where,
      include: {
        lines: {
          where: Object.keys(lineWhere).length > 0 ? lineWhere : undefined,
          include: {
            glAccount: true,
          },
        },
      },
      orderBy: { date: 'desc' },
    });

    // Calculate summary totals
    let totalDebits = 0;
    let totalCredits = 0;
    let transactionCount = 0;

    // By-account aggregation
    const accountMap = new Map<
      string,
      {
        accountId: string;
        accountCode: string;
        accountName: string;
        accountType: string;
        debits: number;
        credits: number;
      }
    >();

    // By-type aggregation
    const typeMap = new Map<
      string,
      {
        type: string;
        debits: number;
        credits: number;
      }
    >();

    // Recent movements
    const recentMovements: Array<{
      id: string;
      date: string;
      description: string;
      debit: number;
      credit: number;
      account: string;
      reference: string;
    }> = [];

    for (const entry of entries) {
      if (entry.lines.length > 0) {
        transactionCount++;
      }
      for (const line of entry.lines) {
        if (!line.glAccount) continue;

        totalDebits += Number(line.debit);
        totalCredits += Number(line.credit);

        // By account
        const acctKey = line.glAccountId;
        const existing = accountMap.get(acctKey);
        if (existing) {
          existing.debits += Number(line.debit);
          existing.credits += Number(line.credit);
        } else {
          accountMap.set(acctKey, {
            accountId: line.glAccountId,
            accountCode: line.glAccount.code,
            accountName: line.glAccount.name,
            accountType: line.glAccount.accountType,
            debits: line.debit,
            credits: line.credit,
          });
        }

        // By type
        const typeKey = line.glAccount.accountType;
        const existingType = typeMap.get(typeKey);
        if (existingType) {
          existingType.debits += Number(line.debit);
          existingType.credits += Number(line.credit);
        } else {
          typeMap.set(typeKey, {
            type: typeKey,
            debits: line.debit,
            credits: line.credit,
          });
        }

        // Add to recent movements
        recentMovements.push({
          id: entry.id,
          date: entry.date.toISOString().split('T')[0],
          description: entry.description,
          debit: line.debit,
          credit: line.credit,
          account: `${line.glAccount.code} - ${line.glAccount.name}`,
          reference: entry.reference ?? '',
        });
      }
    }

    // --- INCLUDE VIRTUAL ENTRIES FROM RECONCILED BANK TRANSACTIONS ---
    const bankTxWhere: Prisma.BankTransactionWhereInput = {
      statement: { bankAccount: { companyId } },
      isReconciled: true,
      glAccountId: { not: null },
    };

    if (fromDate || toDate) {
      const dateWhere: Prisma.DateTimeFilter = {};
      if (fromDate) dateWhere.gte = new Date(fromDate + 'T00:00:00.000Z');
      if (toDate) dateWhere.lte = new Date(toDate + 'T23:59:59.999Z');
      bankTxWhere.date = dateWhere;
    }

    if (accountId) {
      bankTxWhere.glAccountId = accountId;
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
          select: {
            id: true,
            code: true,
            name: true,
            accountType: true,
            normalBalance: true,
          },
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

    const journalDescSet = new Set(entries.map((e) => e.description));

    for (const tx of reconciledTxs) {
      if (!tx.glAccount) continue;
      if (journalDescSet.has(`Reconciliation: ${tx.description}`)) {
        continue;
      }

      transactionCount++;

      const isDeposit = Number(tx.amount) > 0;
      const absAmount = Math.abs(tx.amount);

      // Function to process a "virtual" line
      const processVirtualLine = (
        glAcct: {
          id: string;
          code: string;
          name: string;
          accountType: string;
          normalBalance: string;
        },
        debit: number,
        credit: number,
      ) => {
        if (!glAcct) return;
        totalDebits += debit;
        totalCredits += credit;

        // By account
        const acctKey = glAcct.id;
        const existing = accountMap.get(acctKey);
        if (existing) {
          existing.debits += debit;
          existing.credits += credit;
        } else {
          accountMap.set(acctKey, {
            accountId: glAcct.id,
            accountCode: glAcct.code,
            accountName: glAcct.name,
            accountType: glAcct.accountType,
            debits: debit,
            credits: credit,
          });
        }

        // By type
        const typeKey = glAcct.accountType;
        const existingType = typeMap.get(typeKey);
        if (existingType) {
          existingType.debits += debit;
          existingType.credits += credit;
        } else {
          typeMap.set(typeKey, {
            type: typeKey,
            debits: debit,
            credits: credit,
          });
        }

        // Add to recent movements
        recentMovements.push({
          id: tx.id + '-' + glAcct.id,
          date: tx.date.toISOString().split('T')[0],
          description: tx.description,
          debit: debit,
          credit: credit,
          account: `${glAcct.code} - ${glAcct.name}`,
          reference: tx.reference ?? '',
        });
      };

      // The assigned GL Account line
      processVirtualLine(tx.glAccount, isDeposit ? 0 : absAmount, isDeposit ? absAmount : 0);

      // The Bank Asset Account line (if not filtered out by accountId)
      if (!accountId || accountId === tx.statement.bankAccount.glAccount?.id) {
        processVirtualLine(
          tx.statement.bankAccount.glAccount,
          isDeposit ? absAmount : 0,
          isDeposit ? 0 : absAmount,
        );
      }
    }

    const netMovement = totalDebits - totalCredits;

    // Sort by account code
    const byAccount = Array.from(accountMap.values()).sort((a, b) =>
      a.accountCode.localeCompare(b.accountCode),
    );

    // Add net to byAccount
    const byAccountWithNet = byAccount.map((a) => ({
      ...a,
      net: a.debits - a.credits,
    }));

    // Sort by type in logical GAAP order
    const accountTypeMeta =
      await readJsonConfig<Record<string, { order: number }>>('account-types.json');
    const typeOrder = Object.entries(accountTypeMeta)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => key);
    const byType = Array.from(typeMap.values())
      .sort((a, b) => {
        const aIdx = typeOrder.indexOf(a.type);
        const bIdx = typeOrder.indexOf(b.type);
        return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
      })
      .map((item) => ({
        ...item,
        net: item.debits - item.credits,
      }));

    // Limit recent movements to 50 and only those with non-zero amounts
    const filteredRecent = recentMovements.filter((m) => Number(m.debit) > 0 || Number(m.credit) > 0).slice(0, 50);

    return NextResponse.json({
      summary: {
        totalDebits,
        totalCredits,
        netMovement,
        transactionCount,
      },
      byAccount: byAccountWithNet,
      byType,
      recentMovements: filteredRecent,
    });
  } catch (error: unknown) {
    logger.error('Movement summary error:', { error: String(error) });
    return NextResponse.json({ error: 'Failed to fetch movement summary' }, { status: 500 });
  }
});

