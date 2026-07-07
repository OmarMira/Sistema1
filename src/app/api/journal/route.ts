import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { validateRequest } from '@/lib/validate-request';
import { createJournalEntrySchema } from '@/lib/validations/journal';
import { JournalService } from '@/lib/services/journal.service';
import { parsePaginationParams, cursorPaginatedResponse, offsetPaginatedResponse } from '@/lib/pagination';

function mapEntryWithTotals(entry: {
  id: string;
  date: Date;
  createdAt: Date;
  updatedAt: Date;
  lines: { debit: number; credit: number }[];
}) {
  return {
    ...entry,
    date: entry.date.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    _totalDebit: Number(entry.lines.reduce((sum, l) => sum + Number(l.debit), 0)),
    _totalCredit: Number(entry.lines.reduce((sum, l) => sum + Number(l.credit), 0)),
  };
}

const journalInclude = {
  lines: {
    include: {
      glAccount: {
        select: { id: true, code: true, name: true },
      },
    },
  },
} as const;

// ─── GET /api/journal ───────────────────────────────────────────────
// List journal entries for a company.
export const GET = apiHandler(async (request: NextRequest) => {
  const { companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const { page, limit } = parsePaginationParams(searchParams);
  const status = searchParams.get('status');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const search = searchParams.get('search');

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

  const cursor = searchParams.get('cursor');

  if (cursor) {
    // Cursor-based pagination (Infinite Scroll)
    const entries = await db.journalEntry.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      cursor: { id: cursor },
      skip: 1,
      include: journalInclude,
    });

    const paginated = cursorPaginatedResponse(entries, limit);
    return NextResponse.json({
      data: paginated.data.map(mapEntryWithTotals),
      nextCursor: paginated.nextCursor,
      hasMore: paginated.hasMore,
    });
  }

  if (searchParams.has('cursor')) {
    // Initial fetch for cursor-based pagination (no cursor value but parameter exists)
    const entries = await db.journalEntry.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: journalInclude,
    });

    const paginated = cursorPaginatedResponse(entries, limit);
    return NextResponse.json({
      data: paginated.data.map(mapEntryWithTotals),
      nextCursor: paginated.nextCursor,
      hasMore: paginated.hasMore,
    });
  }

  // Fallback: Offset-based pagination
  const [entries, total] = await Promise.all([
    db.journalEntry.findMany({
      where,
      orderBy: { date: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: journalInclude,
    }),
    db.journalEntry.count({ where }),
  ]);

  return offsetPaginatedResponse(entries.map(mapEntryWithTotals), total, page, limit);
});

// ─── POST /api/journal ──────────────────────────────────────────────
// Create a new journal entry with lines.
export const POST = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await validateRequest(request, createJournalEntrySchema);
  if (body instanceof NextResponse) return body;

  const entry = await JournalService.create(body);

  return NextResponse.json(
    {
      ...entry,
      date: entry.date.toISOString(),
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    },
    { status: 201 },
  );
});

