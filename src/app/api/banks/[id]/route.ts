import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── GET /api/banks/[id]?companyId=xxx ──────────────────────────────────
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get('companyId');

  if (!companyId) {
    return NextResponse.json(
      { error: 'companyId is required' },
      { status: 400 }
    );
  }

  try {
    const account = await db.bankAccount.findFirst({
      where: { id, companyId },
      include: {
        glAccount: {
          select: { id: true, code: true, name: true, accountType: true },
        },
        statements: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: {
            transactions: {
              take: 20,
              orderBy: { date: 'desc' },
              include: {
                glAccount: {
                  select: { id: true, code: true, name: true, accountType: true },
                },
              },
            },
          },
        },
      },
    });

    if (!account) {
      return NextResponse.json(
        { error: 'Bank account not found' },
        { status: 404 }
      );
    }

    // Extract recent transactions from the latest statement
    const recentTransactions = account.statements[0]?.transactions || [];

    return NextResponse.json({
      account: {
        ...account,
        recentTransactions,
      },
    });
  } catch (error) {
    console.error('[BANK GET ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to fetch bank account' },
      { status: 500 }
    );
  }
}

// ─── PUT /api/banks/[id] ───────────────────────────────────────────────
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const {
      companyId,
      accountName,
      bankName,
      accountNo,
      routingNo,
      glAccountId,
      balance,
      currency,
      isActive,
    } = body;

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
        { status: 400 }
      );
    }

    // Verify membership
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check account exists
    const existing = await db.bankAccount.findFirst({
      where: { id, companyId },
    });
    if (!existing) {
      return NextResponse.json(
        { error: 'Bank account not found' },
        { status: 404 }
      );
    }

    // Validate GL account if provided
    if (glAccountId) {
      const glAccount = await db.glAccount.findFirst({
        where: { id: glAccountId, companyId, isActive: true },
      });
      if (!glAccount) {
        return NextResponse.json(
          { error: 'GL account not found or inactive' },
          { status: 404 }
        );
      }
      if (glAccount.accountType !== 'asset') {
        return NextResponse.json(
          {
            error:
              'Bank accounts must be linked to an asset-type GL account',
          },
          { status: 400 }
        );
      }
    }

    const updateData: Record<string, unknown> = {};
    if (accountName !== undefined) updateData.accountName = accountName.trim();
    if (bankName !== undefined) updateData.bankName = bankName.trim();
    if (accountNo !== undefined) updateData.accountNo = accountNo?.trim() || null;
    if (routingNo !== undefined) updateData.routingNo = routingNo?.trim() || null;
    if (glAccountId !== undefined) updateData.glAccountId = glAccountId;
    if (balance !== undefined) updateData.balance = parseFloat(balance) || 0;
    if (currency !== undefined) updateData.currency = currency;
    if (isActive !== undefined) updateData.isActive = isActive;

    const account = await db.bankAccount.update({
      where: { id },
      data: updateData,
      include: {
        glAccount: {
          select: { id: true, code: true, name: true, accountType: true },
        },
      },
    });

    return NextResponse.json({ account });
  } catch (error) {
    console.error('[BANK UPDATE ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to update bank account' },
      { status: 500 }
    );
  }
}

// ─── DELETE /api/banks/[id] ────────────────────────────────────────────
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const { companyId } = body;

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
        { status: 400 }
      );
    }

    // Verify membership
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Soft delete: set isActive = false
    const account = await db.bankAccount.findFirst({
      where: { id, companyId, isActive: true },
    });

    if (!account) {
      return NextResponse.json(
        { error: 'Bank account not found or already deactivated' },
        { status: 404 }
      );
    }

    await db.bankAccount.update({
      where: { id },
      data: { isActive: false },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[BANK DELETE ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to deactivate bank account' },
      { status: 500 }
    );
  }
}
