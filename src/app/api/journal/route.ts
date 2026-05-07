import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── GET /api/journal ───────────────────────────────────────────────
// List journal entries for a company.
// Query params: companyId, status, startDate, endDate, page, limit, search
export async function GET(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get('companyId');
  const status = searchParams.get('status');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const search = searchParams.get('search');
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20)
  );

  if (!companyId) {
    return NextResponse.json(
      { error: 'companyId is required' },
      { status: 400 }
    );
  }

  // Verify user has access to this company
  const membership = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Build where clause
  const where: Record<string, unknown> = { companyId };

  if (status && status !== 'all') {
    where.status = status;
  }
  if (startDate || endDate) {
    where.date = {};
    if (startDate) (where.date as Record<string, unknown>).gte = new Date(startDate);
    if (endDate) (where.date as Record<string, unknown>).lte = new Date(endDate);
  }
  if (search) {
    where.description = { contains: search };
  }

  const [entries, total] = await Promise.all([
    db.journalEntry.findMany({
      where,
      orderBy: { date: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        lines: {
          include: {
            glAccount: {
              select: { id: true, code: true, name: true },
            },
          },
        },
      },
    }),
    db.journalEntry.count({ where }),
  ]);

  // Calculate totals per entry
  const entriesWithTotals = entries.map((entry) => ({
    ...entry,
    date: entry.date.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    _totalDebit: entry.lines.reduce((sum, l) => sum + l.debit, 0),
    _totalCredit: entry.lines.reduce((sum, l) => sum + l.credit, 0),
  }));

  return NextResponse.json({
    data: entriesWithTotals,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

// ─── POST /api/journal ──────────────────────────────────────────────
// Create a new journal entry with lines.
// Body: { companyId, date, description, reference?, status?, lines: [{ glAccountId, description?, debit, credit }] }
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { companyId, date, description, reference, status = 'draft', lines } = body;

    // Validate required fields
    if (!companyId || !date || !description) {
      return NextResponse.json(
        { error: 'companyId, date, and description are required' },
        { status: 400 }
      );
    }

    // Verify user has access
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Validate lines
    if (!Array.isArray(lines) || lines.length < 2) {
      return NextResponse.json(
        { error: 'At least 2 journal lines are required' },
        { status: 400 }
      );
    }

    // Validate each line
    for (const line of lines) {
      if (!line.glAccountId) {
        return NextResponse.json(
          { error: 'Each line must have a glAccountId' },
          { status: 400 }
        );
      }
      if (typeof line.debit !== 'number' || typeof line.credit !== 'number') {
        return NextResponse.json(
          { error: 'Each line must have debit and credit amounts' },
          { status: 400 }
        );
      }
      if (line.debit < 0 || line.credit < 0) {
        return NextResponse.json(
          { error: 'Debit and credit amounts must be non-negative' },
          { status: 400 }
        );
      }
    }

    // Validate balanced entry
    const totalDebits = lines.reduce((sum: number, l: { debit: number }) => sum + l.debit, 0);
    const totalCredits = lines.reduce((sum: number, l: { credit: number }) => sum + l.credit, 0);

    if (Math.abs(totalDebits - totalCredits) > 0.005) {
      return NextResponse.json(
        { error: `Entry must balance. Total debits (${totalDebits.toFixed(2)}) must equal total credits (${totalCredits.toFixed(2)})` },
        { status: 400 }
      );
    }

    // Verify all GL accounts belong to the company and are active
    const accountIds = lines.map((l: { glAccountId: string }) => l.glAccountId);
    const accounts = await db.glAccount.findMany({
      where: { id: { in: accountIds }, companyId },
    });

    if (accounts.length !== new Set(accountIds).size) {
      return NextResponse.json(
        { error: 'One or more GL accounts not found or do not belong to this company' },
        { status: 400 }
      );
    }

    const inactiveAccounts = accounts.filter((a) => !a.isActive);
    if (inactiveAccounts.length > 0) {
      return NextResponse.json(
        { error: 'One or more GL accounts are inactive' },
        { status: 400 }
      );
    }

    // Validate status
    if (!['draft', 'posted'].includes(status)) {
      return NextResponse.json(
        { error: 'Status must be draft or posted' },
        { status: 400 }
      );
    }

    // Create entry with lines in a transaction
    const entry = await db.$transaction(async (tx) => {
      const newEntry = await tx.journalEntry.create({
        data: {
          companyId,
          date: new Date(date),
          description,
          reference: reference || null,
          status,
          lines: {
            create: lines.map((l: { glAccountId: string; description?: string; debit: number; credit: number }) => ({
              glAccountId: l.glAccountId,
              description: l.description || null,
              debit: l.debit,
              credit: l.credit,
            })),
          },
        },
        include: {
          lines: {
            include: {
              glAccount: {
                select: { id: true, code: true, name: true, accountType: true, normalBalance: true },
              },
            },
          },
        },
      });

      return newEntry;
    });

    return NextResponse.json(
      {
        ...entry,
        date: entry.date.toISOString(),
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[JOURNAL CREATE ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
