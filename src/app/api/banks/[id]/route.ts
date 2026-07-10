import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';

// ─── GET /api/banks/[id]?companyId=xxx ──────────────────────────────────
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);

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
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  }

  // Extract recent transactions from the latest statement
  const recentTransactions = account.statements[0]?.transactions || [];

  return NextResponse.json({
    account: {
      ...account,
      recentTransactions,
    },
  });
});

// ─── PUT /api/banks/[id] ───────────────────────────────────────────────
export const PUT = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { id } = await context.params;

  const body = await request.json();
  const { accountName, bankName, accountNo, routingNo, glAccountId, balance, currency, isActive } =
    body;

  // Check account exists
  const existing = await db.bankAccount.findFirst({
    where: { id, companyId },
  });
  if (!existing) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  }

  // Validate GL account if provided
  if (glAccountId) {
    const glAccount = await db.glAccount.findFirst({
      where: { id: glAccountId, companyId, isActive: true },
    });
    if (!glAccount) {
      return NextResponse.json({ error: 'GL account not found or inactive' }, { status: 404 });
    }
    if (glAccount.accountType !== 'asset') {
      return NextResponse.json(
        {
          error: 'Bank accounts must be linked to an asset-type GL account',
        },
        { status: 400 },
      );
    }
  }

  const updateData: Record<string, unknown> = {};
  if (accountName !== undefined) updateData.accountName = accountName.trim();
  if (bankName !== undefined) updateData.bankName = bankName.trim();
  if (accountNo !== undefined) updateData.accountNo = accountNo?.trim() || null;
  if (routingNo !== undefined) updateData.routingNo = routingNo?.trim() || null;
  if (glAccountId !== undefined) updateData.glAccountId = glAccountId;
  if (currency !== undefined) updateData.currency = currency;
  if (isActive !== undefined) updateData.isActive = isActive;

  if (balance !== undefined) {
    const hasStatements = await db.bankStatement.count({
      where: { bankAccountId: id },
    });

    if (hasStatements > 0) {
      const statements = await db.bankStatement.findMany({
        where: { bankAccountId: id },
        orderBy: [{ startDate: 'asc' }, { endDate: 'asc' }],
      });
      updateData.initialBalance = statements[0]!.openingBalance;
      updateData.balance = statements[statements.length - 1]!.closingBalance;
    } else {
      const parsedInitial = parseFloat(balance) || 0;
      updateData.initialBalance = parsedInitial;
      updateData.balance = parsedInitial;
    }
  }

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
});

// ─── DELETE /api/banks/[id] ────────────────────────────────────────────
export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { id } = await context.params;

  // Soft delete: set isActive = false
  const account = await db.bankAccount.findFirst({
    where: { id, companyId, isActive: true },
  });

  if (!account) {
    return NextResponse.json(
      { error: 'Bank account not found or already deactivated' },
      { status: 404 },
    );
  }

  await db.bankAccount.update({
    where: { id },
    data: { isActive: false },
  });

  return NextResponse.json({ success: true });
});
