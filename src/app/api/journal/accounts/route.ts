import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── GET /api/journal/accounts ──────────────────────────────────────
// List active GL accounts for a company (used in account selector dropdown).
// Query params: companyId
// Returns: id, code, name, accountType, normalBalance
export async function GET(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get('companyId');

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

  return NextResponse.json({ data: accounts });
}
