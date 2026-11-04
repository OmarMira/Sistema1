import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { requireCompanyRole } from '@/lib/rbac';
import { validateRequest } from '@/lib/validate-request';
import { journalAccountsCache } from '@/lib/cache';
import { createAuditLogWithRetry } from '@/lib/audit';
import { fromCents, sumCents, toCents } from '@/lib/money';
import { GlAccountAccountType } from '@prisma/client';

// S3 (Wave 6): `GlAccount.accountType` is a Prisma enum, so the enum — not
// rules/account-types.json — is the authority for what can be stored. The JSON
// config keeps the presentation metadata (normal balance, P&L flag, order) and
// its keys are asserted against this list by tests/wave6/enum-migration.test.ts.
const ACCOUNT_TYPES = Object.values(GlAccountAccountType);

function isAccountType(value: string): value is GlAccountAccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

// ─── GET /api/accounts?companyId=xxx&accountType=xxx&search=xxx ─────────
export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { userId, companyId } = requireCompanyContext();
    await requireModuleEntitlement('accounting');

    const { searchParams } = new URL(request.url);
    const accountType = searchParams.get('accountType');
    const search = searchParams.get('search');

    const where: Record<string, unknown> = { companyId };

    if (accountType && accountType !== 'all') {
      // An unknown filter value must keep answering 200 with an empty list (the
      // behaviour of the former String column); a non-member handed straight to
      // Prisma would raise an enum validation error instead.
      where.accountType = isAccountType(accountType) ? accountType : { in: [] };
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
          // S8: posted-only, matching JournalEntryService.recalculateBalance.
          // Draft/void lines must never move a reported balance.
          where: { entry: { status: 'posted' } },
          select: { debit: true, credit: true },
        },
      },
      orderBy: [{ code: 'asc' }],
    });

    // 1. Calculate direct balances for all accounts and build a map
    //    S3: the lines are accumulated in integer cents (src/lib/money.ts) and
    //    converted to a number only for the response, so a 0.10 + 0.20 account
    //    reports 0.3 instead of 0.30000000000000004.
    const accountMap = new Map<string, any>();
    rawAccounts.forEach((acc) => {
      let balanceCents = 0;
      for (const line of acc.journalLines) {
        const debitCents = toCents(line.debit);
        const creditCents = toCents(line.credit);
        balanceCents = sumCents(
          balanceCents,
          acc.normalBalance === 'debit'
            ? sumCents(debitCents, -creditCents)
            : sumCents(creditCents, -debitCents),
        );
      }
      accountMap.set(acc.id, {
        ...acc,
        directBalanceCents: balanceCents,
        balanceCents,
      });
    });

    // 2. Recursive function to aggregate child balances (in cents)
    //    S19a: `visited` keeps the aggregation cycle-safe — a pre-existing cycle
    //    in the hierarchy stops the walk instead of recursing forever. The list
    //    is already company-scoped, so the walk never leaves the company.
    function getAccumulatedBalance(accId: string, visited: Set<string> = new Set<string>()): number {
      const acc = accountMap.get(accId);
      if (!acc) return 0;
      if (visited.has(accId)) return 0; // pre-existing cycle: stop, no loop
      visited.add(accId);

      let totalCents = acc.directBalanceCents as number;
      // Get all child accounts of this parent
      const children = rawAccounts.filter((a) => a.parentId === accId && a.companyId === companyId);
      for (const child of children) {
        totalCents = sumCents(totalCents, getAccumulatedBalance(child.id, visited));
      }

      acc.balanceCents = totalCents;
      return totalCents;
    }

    // 3. Populate accumulated balances for all accounts
    rawAccounts.forEach((acc) => {
      getAccumulatedBalance(acc.id);
    });

    // 4. Map back and clean up — the internal cent fields never leave the API:
    //    each account exposes the same `directBalance`/`balance` numbers, now
    //    derived from the exact cent totals.
    const accounts = rawAccounts.map((acc) => {
      const enriched = accountMap.get(acc.id);
      const { journalLines, directBalanceCents, balanceCents, ...rest } = enriched;
      return {
        ...rest,
        directBalance: fromCents(directBalanceCents as number),
        balance: fromCents(balanceCents as number),
      };
    });

    return NextResponse.json({ accounts });
  },
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

    await requireCompanyRole(companyId, ['company_admin']);
    await requireModuleEntitlement('accounting');

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

    // Validate accountType against the Prisma enum — the column is a
    // GlAccountAccountType now, so a value outside the enum cannot be stored and
    // must be refused here instead of failing at the database. The accepted set
    // and the message are unchanged (same values, same order as the former
    // rules/account-types.json keys).
    if (!isAccountType(accountType)) {
      return NextResponse.json(
        { error: `Invalid accountType. Must be one of: ${ACCOUNT_TYPES.join(', ')}` },
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

    const account = await db.$transaction(async (tx) => {
      const created = await tx.glAccount.create({
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

      await createAuditLogWithRetry({
        companyId,
        userId,
        action: 'ACCOUNT_CREATED',
        entity: 'GlAccount',
        entityId: created.id,
        details: JSON.stringify({
          code: created.code,
          name: created.name,
          accountType: created.accountType,
          normalBalance: created.normalBalance,
        }),
      }, tx as any);

      return created;
    });

    journalAccountsCache.invalidate(companyId);

    return NextResponse.json({ account }, { status: 201 });
  },
);

