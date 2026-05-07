import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

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

    // Build date filter
    const dateFilter: Record<string, Date | { gte: Date; lte: Date }> = {};
    if (fromDate && toDate) {
      dateFilter.date = {
        gte: new Date(fromDate + 'T00:00:00.000Z'),
        lte: new Date(toDate + 'T23:59:59.999Z'),
      };
    } else if (fromDate) {
      dateFilter.date = { gte: new Date(fromDate + 'T00:00:00.000Z') };
    } else if (toDate) {
      dateFilter.date = { lte: new Date(toDate + 'T23:59:59.999Z') };
    }

    // Build line-level account filter
    const lineFilter: Record<string, unknown> = {};
    if (accountId) {
      lineFilter.glAccountId = accountId;
    }

    // Fetch journal entries with their lines and GL accounts
    const entries = await db.journalEntry.findMany({
      where: {
        companyId,
        status: 'posted',
        ...dateFilter,
      },
      include: {
        lines: {
          where: lineFilter,
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

    // Sort by type
    const byType = Array.from(typeMap.values())
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((t) => ({
        ...t,
        net: t.debits - t.credits,
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
