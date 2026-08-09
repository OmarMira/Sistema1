import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { ConflictError } from '@/lib/api-error';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { JournalEntryService } from '@/lib/services/journal-entry.service';

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
      const bankGlAccountId = existing.glAccountId;

      const account = await db.$transaction(async (tx) => {
        // Opening accounting = posted journal lines on the bank GL not linked to
        // a bank transaction. There is no structural link between BankAccount and
        // JournalEntry, so the opening JE cannot be safely isolated. When it exists
        // and would diverge from the requested balance, block instead of guessing.
        const unlinkedLines = await tx.journalLine.findMany({
          where: {
            glAccountId: bankGlAccountId,
            entry: { companyId, status: 'posted', transactions: { none: {} } },
          },
          select: { debit: true, credit: true },
        });
        const openingEffect = unlinkedLines.reduce(
          (sum, l) => sum + Number(l.debit) - Number(l.credit),
          0,
        );
        const hasOpeningAccounting = unlinkedLines.length > 0;

        if (hasOpeningAccounting && Math.abs(openingEffect - parsedInitial) > 0.009) {
          throw new ConflictError(
            'Cannot change the opening balance: it would diverge from the posted opening journal entry. Delete and recreate the bank account to change its opening balance.',
          );
        }

        if (parsedInitial > 0 && !hasOpeningAccounting) {
          const openingDate = new Date();
          await assertActiveFiscalPeriod(companyId, openingDate, tx as any);
          const openingEquityId = await JournalEntryService.ensureOpeningBalanceEquity(
            tx as any,
            companyId,
          );
          await JournalEntryService.createFromBankTransaction(tx as any, {
            bankTxId: '',
            bankTxDate: openingDate,
            bankTxAmount: parsedInitial,
            bankTxDescription: 'Opening balance',
            bankGlAccountId,
            counterpartyGlAccountId: openingEquityId,
            companyId,
          });
        }

        return tx.bankAccount.update({
          where: { id },
          data: {
            ...updateData,
            initialBalance: parsedInitial,
            balance: parsedInitial,
          },
          include: {
            glAccount: {
              select: { id: true, code: true, name: true, accountType: true },
            },
          },
        });
      });

      return NextResponse.json({ account });
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
