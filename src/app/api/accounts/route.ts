import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/app/api/auth/me/route';

// ─── GET /api/accounts?companyId=xxx&accountType=xxx&search=xxx ─────────
export async function GET(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get('companyId');
  const accountType = searchParams.get('accountType');
  const search = searchParams.get('search');

  if (!companyId) {
    return NextResponse.json(
      { error: 'companyId is required' },
      { status: 400 }
    );
  }

  try {
    const where: Record<string, unknown> = { companyId };

    if (accountType && accountType !== 'all') {
      where.accountType = accountType;
    }

    if (search && search.trim()) {
      where.OR = [
        { code: { contains: search.trim() } },
        { name: { contains: search.trim() } },
      ];
    }

    const accounts = await db.glAccount.findMany({
      where,
      include: {
        parent: {
          select: { id: true, code: true, name: true },
        },
        _count: {
          select: { children: true, journalLines: true },
        },
      },
      orderBy: [{ code: 'asc' }],
    });

    return NextResponse.json({ accounts });
  } catch (error) {
    console.error('[ACCOUNTS LIST ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to fetch accounts' },
      { status: 500 }
    );
  }
}

// ─── POST /api/accounts ────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { companyId, code, name, accountType, normalBalance, parentId } = body;

    // Validate required fields
    if (!companyId || !code || !name || !accountType || !normalBalance) {
      return NextResponse.json(
        { error: 'companyId, code, name, accountType, and normalBalance are required' },
        { status: 400 }
      );
    }

    // Validate accountType
    const validTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'];
    if (!validTypes.includes(accountType)) {
      return NextResponse.json(
        { error: `Invalid accountType. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate normalBalance
    if (!['debit', 'credit'].includes(normalBalance)) {
      return NextResponse.json(
        { error: 'Invalid normalBalance. Must be debit or credit' },
        { status: 400 }
      );
    }

    // Check for duplicate code within company
    const existing = await db.glAccount.findUnique({
      where: {
        companyId_code: {
          companyId,
          code: code.trim(),
        },
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'An account with this code already exists in this company' },
        { status: 409 }
      );
    }

    // Validate parentId if provided
    if (parentId) {
      const parentAccount = await db.glAccount.findFirst({
        where: { id: parentId, companyId },
      });
      if (!parentAccount) {
        return NextResponse.json(
          { error: 'Parent account not found' },
          { status: 404 }
        );
      }
    }

    const account = await db.glAccount.create({
      data: {
        companyId,
        code: code.trim(),
        name: name.trim(),
        accountType,
        normalBalance,
        parentId: parentId || null,
        isActive: true,
        isSystem: false,
      },
      include: {
        parent: {
          select: { id: true, code: true, name: true },
        },
        _count: {
          select: { children: true, journalLines: true },
        },
      },
    });

    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    console.error('[ACCOUNTS CREATE ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to create account' },
      { status: 500 }
    );
  }
}
