import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { validateRequest } from '@/lib/validate-request';
import { journalAccountsCache } from '@/lib/cache';
import { readJsonConfig } from '@/lib/config-loader';

// ─── GET /api/accounts?companyId=xxx&accountType=xxx&search=xxx ─────────
export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { userId, companyId } = requireCompanyContext();

    const { searchParams } = new URL(request.url);
    const accountType = searchParams.get('accountType');
    const search = searchParams.get('search');

    const where: Record<string, unknown> = { companyId };

    if (accountType && accountType !== 'all') {
      where.accountType = accountType;
    }

    if (search && search.trim()) {
      where.OR = [{ code: { contains: search.trim() } }, { name: { contains: search.trim() } }];
    }

    const rawAccounts = await db.glAccount.findMany({
      where,
      include: {
        parent: {
          select: { id: true, code: true, name: true },
        },
        _count: {
          select: { children: true, journalLines: true },
        },
        journalLines: {
          select: { debit: true, credit: true },
        },
      },
      orderBy: [{ code: 'asc' }],
    });

    // 1. Calculate direct balances for all accounts and build a map
     
    const accountMap = new Map<string, any>();
    rawAccounts.forEach((acc) => {
      let balance = 0;
      for (const line of acc.journalLines) {
        if (acc.normalBalance === 'debit') {
          balance += Number(line.debit) - Number(line.credit);
        } else {
          balance += Number(line.credit) - Number(line.debit);
        }
      }
      accountMap.set(acc.id, {
        ...acc,
        directBalance: balance,
        balance: balance, // Will hold the accumulated balance
      });
    });

    // 2. Recursive function to aggregate child balances
    function getAccumulatedBalance(accId: string): number {
      const acc = accountMap.get(accId);
      if (!acc) return 0;

      let total = acc.directBalance as number;
      // Get all child accounts of this parent
      const children = rawAccounts.filter((a) => a.parentId === accId);
      for (const child of children) {
        total += getAccumulatedBalance(child.id);
      }

      acc.balance = total;
      return total;
    }

    // 3. Populate accumulated balances for all accounts
    rawAccounts.forEach((acc) => {
      getAccumulatedBalance(acc.id);
    });

    // 4. Map back and clean up
    const accounts = rawAccounts.map((acc) => {
      const enriched = accountMap.get(acc.id);
      const { journalLines, ...rest } = enriched;
      return rest;
    });

    return NextResponse.json({ accounts });
  },
  { requireMembership: false },
);

const createAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  accountType: z.string().min(1),
  normalBalance: z.enum(['debit', 'credit']),
  parentId: z.string().optional().nullable(),
});

// ─── POST /api/accounts ────────────────────────────────────────────────
export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { userId, companyId } = requireCompanyContext();

    const body = await validateRequest(request, createAccountSchema);
    if (body instanceof NextResponse) return body;
    const { code, name, accountType, normalBalance, parentId } = body;

    // Validate required fields
    if (!companyId || !code || !name || !accountType || !normalBalance) {
      return NextResponse.json(
        { error: 'companyId, code, name, accountType, and normalBalance are required' },
        { status: 400 },
      );
    }

    // Validate accountType against config
    const accountTypeConfig = await readJsonConfig<Record<string, unknown>>('account-types.json');
    if (!(accountType in accountTypeConfig)) {
      const validTypes = Object.keys(accountTypeConfig);
      return NextResponse.json(
        { error: `Invalid accountType. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 },
      );
    }

    // Validate normalBalance
    if (!['debit', 'credit'].includes(normalBalance)) {
      return NextResponse.json(
        { error: 'Invalid normalBalance. Must be debit or credit' },
        { status: 400 },
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
        { status: 409 },
      );
    }

    // Validate parentId if provided
    if (parentId) {
      const parentAccount = await db.glAccount.findFirst({
        where: { id: parentId, companyId },
      });
      if (!parentAccount) {
        return NextResponse.json({ error: 'Parent account not found' }, { status: 404 });
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

    journalAccountsCache.invalidate(companyId);

    return NextResponse.json({ account }, { status: 201 });
  },
  { requireMembership: false },
);

