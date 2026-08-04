import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { simulateApply } from '@/lib/services/rule-simulation.service';
import { MAX_PER_BATCH } from '@/lib/services/apply-all-engine';

export type ParseSimulateLimitResult = { ok: true; value?: number } | { ok: false };

/**
 * Validates the `limit` field against the engine's real batch cap.
 * `undefined`/`null` → valid, limit omitted (engine default).
 * Rejects NaN, decimals, negatives, zero, over-cap, and non-numbers.
 */
export function parseSimulateLimit(raw: unknown): ParseSimulateLimitResult {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_PER_BATCH) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

// ─── POST /api/bank-rules/simulate ────────────────────────────────
// Read-only rule classification forecast. Reuses the REAL matching engine
// so the forecast matches what a real apply would produce.
//
// Does NOT write: no transactions, journals, balances, audit events,
// and no durable RuleApplyRecord.
//
// Coexists with /api/learning/rules/simulate (legacy condition-only tester).
// This endpoint is the faithful simulation contract per BRE-013 spec.
//
// Body: { limit?: number (1..MAX_PER_BATCH, default engine cap) }

export const POST = apiHandler(async (request: NextRequest) => {
  const { companyId } = await requireCompanyContext();

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine
  }

  const parsed = parseSimulateLimit(body.limit);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: `limit must be an integer between 1 and ${MAX_PER_BATCH}` },
      { status: 400 },
    );
  }

  const result = await simulateApply(companyId, { limit: parsed.value });

  return NextResponse.json(result);
});
