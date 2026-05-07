import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get('companyId');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');
    const accountId = searchParams.get('accountId');

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
        { status: 400 }
      );
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

        totalDebits += line.debit;
        totalCredits += line.credit;

        // By account
        const acctKey = line.glAccountId;
        const existing = accountMap.get(acctKey);
        if (existing) {
          existing.debits += line.debit;
          existing.credits += line.credit;
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
          existingType.debits += line.debit;
          existingType.credits += line.credit;
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

    const netMovement = totalDebits - totalCredits;

    // Sort by account code
    const byAccount = Array.from(accountMap.values()).sort((a, b) =>
      a.accountCode.localeCompare(b.accountCode)
    );

    // Add net to byAccount
    const byAccountWithNet = byAccount.map((a) => ({
      ...a,
      net: a.debits - a.credits,
    }));

    // Sort by type in logical GAAP order
    const typeOrder = ['asset', 'liability', 'equity', 'revenue', 'expense'];
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
    const filteredRecent = recentMovements
      .filter((m) => m.debit > 0 || m.credit > 0)
      .slice(0, 50);

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
  } catch (error) {
    console.error('Movement summary error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch movement summary' },
      { status: 500 }
    );
  }
}
