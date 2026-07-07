import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { JournalEntryService } from '@/lib/services/journal-entry.service';

// ─── GET /api/banks?companyId=xxx ──────────────────────────────────────
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { searchParams } = new URL(request.url);

  const accounts = await db.bankAccount.findMany({
    where: { companyId },
    include: {
      glAccount: {
        select: { id: true, code: true, name: true, accountType: true },
      },
      _count: {
        select: { statements: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ accounts });
});

// ─── POST /api/banks ──────────────────────────────────────────────────
// If balance > 0, creates an opening journal entry:
//   Dr Bank GL / Cr Opening Balance Equity
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const body = await request.json();
  const { accountName, bankName, accountNo, routingNo, glAccountId, balance, currency } = body;

  // Validate required fields
  if (!accountName || !bankName || !glAccountId) {
    return NextResponse.json(
      { error: 'accountName, bankName, and glAccountId are required' },
      { status: 400 },
    );
  }

  // Validate GL account exists, belongs to company, and is asset type
  const glAccount = await db.glAccount.findFirst({
    where: { id: glAccountId, companyId, isActive: true },
  });
  if (!glAccount) {
    return NextResponse.json({ error: 'GL account not found or inactive' }, { status: 404 });
  }
  if (glAccount.accountType !== 'asset') {
    return NextResponse.json(
      { error: 'Bank accounts must be linked to an asset-type GL account' },
      { status: 400 },
    );
  }

  const initialBalance = new Prisma.Decimal(balance || 0);

  const result = await db.$transaction(async (tx) => {
    const account = await tx.bankAccount.create({
      data: {
        companyId,
        accountName: accountName.trim(),
        bankName: bankName.trim(),
        accountNo: accountNo?.trim() || null,
        routingNo: routingNo?.trim() || null,
        glAccountId,
        balance: initialBalance,
        initialBalance,
        currency: currency || 'USD',
        isActive: true,
      },
      include: {
        glAccount: {
          select: { id: true, code: true, name: true, accountType: true },
        },
      },
    });

    // Create opening journal entry if initial balance > 0
    if (initialBalance.greaterThan(0)) {
       
      const openingEquityId = await JournalEntryService.ensureOpeningBalanceEquity(tx as any, companyId);
       
      await JournalEntryService.createFromBankTransaction(tx as any, {
        bankTxId: '',
        bankTxDate: new Date(),
        bankTxAmount: initialBalance.toNumber(),
        bankTxDescription: 'Opening balance',
        bankGlAccountId: glAccountId,
        counterpartyGlAccountId: openingEquityId,
        companyId,
      });
    }

    return account;
  });

  return NextResponse.json({ account: result }, { status: 201 });
});
