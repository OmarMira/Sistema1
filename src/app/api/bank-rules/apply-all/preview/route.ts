import { NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { matchTransactions } from '@/lib/services/apply-all-engine';

// ─── GET /api/bank-rules/apply-all/preview ─────────────────────────
// Returns estimated totals of pending unmatched transactions.
// READ-ONLY — no mutations performed.
export const GET = apiHandler(async (request, context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  const result = await matchTransactions(companyId, { limit: 200 });

  // Warning only when there ARE pending transactions but none matched (no active rules)
  // When everything is 0, that's just "nothing to process" — normal state, no warning
  const hasPendingButNoRules = result.matchedRules.length === 0 && (result.totalCount > 0 || result.remaining > 0);

  return NextResponse.json({
    totalTransactions: result.totalCount,
    totalAmount: result.totalAmount,
    rulesToApply: result.matchedRules.length,
    remaining: result.remaining,
    warning: hasPendingButNoRules
      ? 'No active rules match pending transactions.'
      : null,
  });
});
