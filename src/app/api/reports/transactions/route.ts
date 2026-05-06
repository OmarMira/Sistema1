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
    const startDateParam = searchParams.get('startDate');
    const endDateParam = searchParams.get('endDate');
    const glAccountId = searchParams.get('glAccountId');
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get('limit') ?? '25', 10) || 25)
    );

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

    // Count total entries matching filter
    const totalCount = await db.journalEntry.count({ where });

    // Fetch entries with lines
    const entries = await db.journalEntry.findMany({
      where,
      include: {
        lines: {
          where: glAccountId ? lineWhere : undefined,
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
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { date: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // If filtering by GL account, exclude entries that have no matching lines
    const filteredEntries = glAccountId
      ? entries.filter((e) => e.lines.length > 0)
      : entries;

    const result = filteredEntries.map((entry) => {
      const totalDebit = entry.lines.reduce((sum, l) => sum + (l.debit || 0), 0);
      const totalCredit = entry.lines.reduce((sum, l) => sum + (l.credit || 0), 0);
      return {
        id: entry.id,
        date: entry.date.toISOString(),
        description: entry.description,
        reference: entry.reference,
        status: entry.status,
        lines: entry.lines.map((l) => ({
          id: l.id,
          glAccountId: l.glAccountId,
          accountCode: l.glAccount.code,
          accountName: l.glAccount.name,
          accountType: l.glAccount.accountType,
          description: l.description,
          debit: l.debit,
          credit: l.credit,
        })),
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
  } catch (error) {
    console.error('[TRANSACTION REPORT ERROR]', error);
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
