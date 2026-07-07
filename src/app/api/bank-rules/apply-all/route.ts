import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { serverT } from '@/lib/server-i18n';
import {
  matchTransactions,
  executeApplyAll,
} from '@/lib/services/apply-all-engine';

// ─── POST /api/bank-rules/apply-all ────────────────────────────────
// Apply ALL active rules to all unmatched transactions.
// Rules are processed in priority order (lower number = higher priority).
// First match wins per transaction.
// Body: { companyId }
//
// NOTE — LLM low-confidence skip (REQ-LLM-02):
// The deterministic rule matching engine (matchTransactions) does NOT
// produce a confidence score. There is no separate apply-all endpoint
// for the LLM suggestion flow — LLM suggestions go through:
//   suggest-role (capped at 0.69) → user confirms → classify-entity (source: 'user')
// They never reach this endpoint without explicit user confirmation.
// The server-side confidence cap in suggest-role (Math.min 0.69) is
// the enforcement mechanism. No additional filter is needed here.
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  // Get locale for i18n
  const locale = request.headers.get('x-locale') || 'es';

  // Step 1: Use the shared engine to find matched transactions (READ-ONLY)
  // Task 2.1: Replaces inline matching logic
  const matchResult = await matchTransactions(companyId, { limit: 200 });

  // Early return if nothing to match
  if (matchResult.matchedRules.length === 0 || matchResult.totalCount === 0) {
    const totalPending = matchResult.totalCount + matchResult.remaining;
    const response: Record<string, unknown> = {
      success: true,
      matched: 0,
      total: totalPending,
      remaining: matchResult.remaining,
      rulesApplied: [],
    };
    // Add warning if batch was truncated (e.g. maxApplyTransactions=0)
    if (matchResult.remaining > 0) {
      response.warning = serverT(locale, 'bankRules.applyAllCapWarning')
        .replace('{applied}', '0')
        .replace('{total}', String(totalPending))
        .replace('{remaining}', String(matchResult.remaining));
    }
    return NextResponse.json(response);
  }

  // Step 2: Wrap ALL mutations in a single Prisma $transaction
  // Task 2.2: This is the atomicity fix — updateMany + journal creation
  //           inside one transaction so failure rolls back everything
  const applyResult = await db.$transaction(async (tx) => {
    return executeApplyAll(companyId, tx, matchResult);
  });

  // Build warning message if batch was truncated
  let warning: string | undefined;
  if (matchResult.remaining > 0) {
    warning = serverT(locale, 'bankRules.applyAllCapWarning')
      .replace('{applied}', String(applyResult.appliedCount))
      .replace('{total}', String(matchResult.totalCount + matchResult.remaining))
      .replace('{remaining}', String(matchResult.remaining));
  }

  // Build rulesApplied response
  const rulesApplied = matchResult.matchedRules.map((entry) => ({
    ruleId: entry.rule.id,
    ruleName: entry.rule.name,
    count: entry.txIds.length,
  }));

  // Task 2.3: Updated response with remaining and warning
  const response: Record<string, unknown> = {
    success: true,
    matched: applyResult.appliedCount,
    total: matchResult.totalCount + matchResult.remaining,
    remaining: matchResult.remaining,
    rulesApplied,
  };
  if (warning) response.warning = warning;

  return NextResponse.json(response);
});
