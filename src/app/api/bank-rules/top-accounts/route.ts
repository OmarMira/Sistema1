import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';

// ─── GET /api/bank-rules/top-accounts?companyId=xxx ───────────────────────────
// Returns up to 8 most-used GL accounts across bank rules for this company.
// Response: { data: [{ code, name, accountType, useCount }] }
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  const { searchParams } = new URL(request.url);

  // Query all accounts used in any of the 3 account fields, count manually
  const rules = await db.bankRule.findMany({
    where: { companyId },
    select: { glAccountId: true, debitGlAccountId: true, creditGlAccountId: true },
  });

  const accountCount = new Map<string, number>();
  for (const r of rules) {
    for (const id of [r.glAccountId, r.debitGlAccountId, r.creditGlAccountId]) {
      if (id) accountCount.set(id, (accountCount.get(id) || 0) + 1);
    }
  }

  const topIds = [...accountCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id]) => id);

  if (topIds.length === 0) return NextResponse.json({ data: [] });

  const accounts = await db.glAccount.findMany({
    where: { id: { in: topIds }, companyId },
    select: { id: true, code: true, name: true, accountType: true },
  });

  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  const data = topIds
    .filter((id) => accountMap.has(id))
    .map((id) => ({
      code: accountMap.get(id)!.code,
      name: accountMap.get(id)!.name,
      accountType: accountMap.get(id)!.accountType,
      useCount: accountCount.get(id)!,
    }));

  return NextResponse.json({ data });
});
