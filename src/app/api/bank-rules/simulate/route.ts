import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { requireCompanyContext } from '@/lib/context-storage';
import { simulateApply } from '@/lib/services/rule-simulation.service';
import { parseSimulateLimit, type ParseSimulateLimitResult } from './helpers';
import { MAX_PER_BATCH } from '@/lib/services/apply-all-engine';

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
  await requireModuleEntitlement('banking');

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
