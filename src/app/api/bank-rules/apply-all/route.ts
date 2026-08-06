import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
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

  await requireCompanyRole(companyId, ['company_admin']);

  const locale = request.headers.get('x-locale') || 'es';

  // Read params from body
  let confirmed: boolean | undefined;
  let mode: 'batch' | 'single' | undefined;
  let transactionId: string | undefined;
  let forcedRuleId: string | undefined;
  try {
    const data = await request.json();
    if (typeof data?.confirmed === 'boolean') confirmed = data.confirmed;
    if (data?.mode === 'single') mode = 'single';
    if (typeof data?.transactionId === 'string') transactionId = data.transactionId;
    if (typeof data?.forcedRuleId === 'string') forcedRuleId = data.forcedRuleId;
  } catch {
    // Body already validated by apiHandler — this path is a safeguard
  }

  const result = await executeApplyAllUseCase(companyId, { confirmed, mode, transactionId, forcedRuleId, userId });
  const { matchResult, applyResult, policyObservation, enforcement } = result;

  const rulesApplied = matchResult.matchedRules.map((entry) => ({
    ruleId: entry.rule.id,
    ruleName: entry.rule.name,
    count: entry.txIds.length,
    confidenceDistribution: entry.confidenceDistribution,
  }));

  const ambiguousTransactions = matchResult.ambiguousTransactions?.map((entry) => ({
    transactionId: entry.transactionId,
    candidates: entry.candidates.map((c) => ({
      ruleId: c.ruleId,
      ruleName: c.ruleName,
      confidenceLabel: c.confidenceLabel,
      matchQuality: c.matchQuality,
      specificityScore: c.specificityScore,
      evaluatedConditions: c.evaluatedConditions,
    })),
  }));

  // Legacy cap warning (computed when transactions exceed server-side limit)
  let capWarning: string | undefined;
  if (matchResult.remaining > 0) {
    capWarning = serverT(locale, 'bankRules.applyAllCapWarning')
      .replace('{applied}', String(applyResult.appliedCount))
      .replace('{total}', String(matchResult.totalCount + matchResult.remaining))
      .replace('{remaining}', String(matchResult.remaining));
  }

  // ── S7-11: Map enforcement result to HTTP response ──────────
  if (enforcement) {
    switch (enforcement.status) {
      case 'EXECUTED': {
        const body: Record<string, unknown> = {
          status: 'EXECUTED',
          success: true,
          matched: applyResult.appliedCount,
          total: matchResult.totalCount + matchResult.remaining,
          remaining: matchResult.remaining,
          rulesApplied,
        };
        if (enforcement.policyWarning) body.policyWarning = enforcement.policyWarning;
        if (enforcement.policyUnavailable) body.policyUnavailable = enforcement.policyUnavailable;
        if (capWarning) body.warning = capWarning;
        if (policyObservation) body.policyObservation = policyObservation;
        if (ambiguousTransactions && ambiguousTransactions.length > 0) {
          body.ambiguousTransactions = ambiguousTransactions;
        }
        return NextResponse.json(body);
      }

      case 'CONFIRMATION_REQUIRED':
        return NextResponse.json({
          status: 'CONFIRMATION_REQUIRED',
          decision: enforcement.decision,
          context: enforcement.context,
        });

      case 'BLOCKED':
        return NextResponse.json({
          status: 'BLOCKED',
          ...enforcement.block,
        });
    }
  }
  // ─────────────────────────────────────────────────────────────

  // Fallback: no enforcement (backward compat for edge cases)
  const body: Record<string, unknown> = {
    success: true,
    matched: applyResult.appliedCount,
    total: matchResult.totalCount + matchResult.remaining,
    remaining: matchResult.remaining,
    rulesApplied,
  };
  if (capWarning) body.warning = capWarning;
  if (policyObservation) body.policyObservation = policyObservation;
  if (ambiguousTransactions && ambiguousTransactions.length > 0) {
    body.ambiguousTransactions = ambiguousTransactions;
  }
  return NextResponse.json(body);
});
