import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { serverT } from '@/lib/server-i18n';
import { executeApplyAllUseCase } from '@/lib/services/apply-all-use-case';

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

  const locale = request.headers.get('x-locale') || 'es';

  const { matchResult, applyResult, policyObservation } = await executeApplyAllUseCase(companyId);

  let warning: string | undefined;
  if (matchResult.remaining > 0) {
    warning = serverT(locale, 'bankRules.applyAllCapWarning')
      .replace('{applied}', String(applyResult.appliedCount))
      .replace('{total}', String(matchResult.totalCount + matchResult.remaining))
      .replace('{remaining}', String(matchResult.remaining));
  }

  const rulesApplied = matchResult.matchedRules.map((entry) => ({
    ruleId: entry.rule.id,
    ruleName: entry.rule.name,
    count: entry.txIds.length,
  }));

  const response: Record<string, unknown> = {
    success: true,
    matched: applyResult.appliedCount,
    total: matchResult.totalCount + matchResult.remaining,
    remaining: matchResult.remaining,
    rulesApplied,
  };
  if (warning) response.warning = warning;
  if (policyObservation) response.policyObservation = policyObservation;

  return NextResponse.json(response);
});
