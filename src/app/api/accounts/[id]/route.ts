import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { journalAccountsCache } from '@/lib/cache';
import { readJsonConfig } from '@/lib/config-loader';
import { logger } from '@/lib/logger';

// ─── GET /api/accounts/[id] ────────────────────────────────────────────
export const GET = apiHandler(
  async (_request: NextRequest, context: RouteContext) => {
    const { userId, companyId } = requireCompanyContext();

    const { id } = await context.params;

    const account = await db.glAccount.findFirst({
      where: { id, companyId },
      include: {
        parent: {
          select: { id: true, code: true, name: true },
        },
        children: {
          include: {
            parent: {
              select: { id: true, code: true, name: true },
            },
            _count: {
              select: { children: true, journalLines: true },
            },
          },
          orderBy: [{ code: 'asc' }],
        },
        _count: {
          select: { children: true, journalLines: true },
        },
      },
    });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({ account });
  },
  { requireMembership: false },
);

// ─── PUT /api/accounts/[id] ────────────────────────────────────────────
export const PUT = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { userId, companyId } = requireCompanyContext();

    const { id } = await context.params;
    const body = await request.json();
    const { name, isActive, code, accountType, normalBalance, parentId } = body;

    // Check account exists and belongs to user's company
    const existing = await db.glAccount.findFirst({ where: { id, companyId } });
    if (!existing) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Build update data with only provided fields
    const updateData: Record<string, unknown> = {};

    if (name !== undefined) {
      if (!name.trim()) {
        return NextResponse.json({ error: 'Account name cannot be empty' }, { status: 400 });
      }
      updateData.name = name.trim();
    }

    if (isActive !== undefined) {
      updateData.isActive = Boolean(isActive);
    }

    if (code !== undefined) {
      const trimmedCode = code.trim();
      if (!trimmedCode) {
        return NextResponse.json({ error: 'Account code cannot be empty' }, { status: 400 });
      }
      // Check uniqueness within company (excluding current account)
      const duplicate = await db.glAccount.findFirst({
        where: {
          companyId: existing.companyId,
          code: trimmedCode,
          id: { not: id },
        },
      });
      if (duplicate) {
        return NextResponse.json(
          { error: 'An account with this code already exists in this company' },
          { status: 409 },
        );
      }
      updateData.code = trimmedCode;
    }

    if (accountType !== undefined) {
      const accountTypeConfig = await readJsonConfig<Record<string, unknown>>('account-types.json');
      if (!(accountType in accountTypeConfig)) {
        const validTypes = Object.keys(accountTypeConfig);
        return NextResponse.json(
          { error: `Invalid accountType. Must be one of: ${validTypes.join(', ')}` },
          { status: 400 },
        );
      }
      updateData.accountType = accountType;
    }

    if (normalBalance !== undefined) {
      if (!['debit', 'credit'].includes(normalBalance)) {
        return NextResponse.json(
          { error: 'Invalid normalBalance. Must be debit or credit' },
          { status: 400 },
        );
      }
      updateData.normalBalance = normalBalance;
    }

    if (parentId !== undefined) {
      if (parentId === null) {
        updateData.parentId = null;
      } else {
        // Validate parent exists and belongs to same company
        const parentAccount = await db.glAccount.findFirst({
          where: { id: parentId, companyId: existing.companyId },
        });
        if (!parentAccount) {
          return NextResponse.json({ error: 'Parent account not found' }, { status: 404 });
        }
        // Prevent circular reference
        if (parentId === id) {
          return NextResponse.json(
            { error: 'An account cannot be its own parent' },
            { status: 400 },
          );
        }
        updateData.parentId = parentId;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const account = await db.glAccount.update({
      where: { id },
      data: updateData,
      include: {
        parent: {
          select: { id: true, code: true, name: true },
        },
        _count: {
          select: { children: true, journalLines: true },
        },
      },
    });

    journalAccountsCache.invalidate(existing.companyId);

    return NextResponse.json({ account });
  },
  { requireMembership: false },
);

// ─── Recursively collect descendant account IDs ──────────────────────
async function collectDescendantIds(parentId: string): Promise<string[]> {
  const children = await db.glAccount.findMany({
    where: { parentId },
    select: { id: true },
  });
  const ids: string[] = [];
  for (const child of children) {
    ids.push(child.id);
    const grandchildIds = await collectDescendantIds(child.id);
    ids.push(...grandchildIds);
  }
  return ids;
}

// ─── DELETE /api/accounts/[id] (hard delete) ───────────────────────────
export const DELETE = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { userId, companyId } = requireCompanyContext();

    const { id } = await context.params;
    const account = await db.glAccount.findFirst({
      where: { id, companyId },
      include: {
        _count: {
          select: {
            children: true,
            journalLines: true,
            bankAccounts: true,
            transactions: true,
          },
        },
      },
    });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Cannot delete system accounts
    if (account.isSystem) {
      const msg = `Las cuentas del sistema no se pueden eliminar.`;
      return NextResponse.json({ error: msg }, { status: 403 });
    }

    // Check journal lines in THIS account OR any descendant
    // (this is the only hard blocker — real financial data)
    const descendantIds = await collectDescendantIds(id);
    const allAffectedIds = [id, ...descendantIds];
    const totalJournalLines = await db.journalLine.count({
      where: { glAccountId: { in: allAffectedIds } },
    });
    if (totalJournalLines > 0) {
      const msg = `No se puede eliminar "${account.name}" porque tiene ${totalJournalLines} asiento(s) contable(s) en esta cuenta o sus sub-cuentas.`;
      logger.warn('[DELETE ACCOUNT 409] journalLines in hierarchy', {
        id,
        name: account.name,
        totalJournalLines,
      });
      return NextResponse.json({ error: msg }, { status: 409 });
    }

    // Cannot delete accounts linked to bank accounts
    // (FK is NOT nullable — would break the bank account)
    if (account._count.bankAccounts > 0) {
      const msg = `No se puede eliminar "${account.name}" porque está vinculada a ${account._count.bankAccounts} cuenta(s) bancaria(s).`;
      logger.warn('[DELETE ACCOUNT 409] bankAccounts > 0', {
        id,
        name: account.name,
        bankAccounts: account._count.bankAccounts,
      });
      return NextResponse.json({ error: msg }, { status: 409 });
    }

    // ── Cleanup related records before delete ──

    // 1. Orphan children (set parentId to null)
    if (account._count.children > 0) {
      await db.glAccount.updateMany({
        where: { parentId: id },
        data: { parentId: null },
      });
    }

    // 2. Null out bank transactions referencing this account
    // (FK is nullable, no cascade — manual cleanup needed)
    if (account._count.transactions > 0) {
      await db.bankTransaction.updateMany({
        where: { glAccountId: id },
        data: { glAccountId: null },
      });
    }

    // 3. BankRules, EntityContexts have onDelete: SetNull — DB handles them

    // Hard delete from database
    const deleted = await db.glAccount.delete({
      where: { id },
    });

    journalAccountsCache.invalidate(account.companyId);

    return NextResponse.json({ account: deleted });
  },
  { requireMembership: false },
);
