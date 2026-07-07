import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { journalAccountsCache } from '@/lib/cache';

// ─── GET /api/journal/accounts ──────────────────────────────────────
// List active GL accounts for a company (used in account selector dropdown).
// Query params: companyId
// Returns: id, code, name, accountType, normalBalance
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { searchParams } = new URL(request.url);

  // Try cache first
  const cached = journalAccountsCache.get(companyId);
  if (cached) {
    return NextResponse.json({ data: cached });
  }

  // Fetch active accounts ordered by code
  const accounts = await db.glAccount.findMany({
    where: {
      companyId,
      isActive: true,
    },
    select: {
      id: true,
      code: true,
      name: true,
      accountType: true,
      normalBalance: true,
    },
    orderBy: { code: 'asc' },
  });

  // Save to cache
  journalAccountsCache.set(companyId, accounts);

  return NextResponse.json({ data: accounts });
});
