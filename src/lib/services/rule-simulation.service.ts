import { matchTransactions, type MatchResult } from '@/lib/services/apply-all-engine';

export interface SimulationOptions {
  limit?: number;
}

export interface SimulationResult {
  /** Classification forecast — same shape as a real apply's MatchResult. */
  matchResult: MatchResult;
  /** Read-only flag: no transactions, journals, balances, or audit events were written. */
  readOnly: true;
  /** No durable apply record was created. */
  recordCreated: false;
  /**
   * Scope warning: this is a classification forecast only. Postings, journal
   * lines, and GL balances are NOT predicted, so ledger accounting accuracy is
   * not guaranteed by this simulation.
   */
  ledgerAccuracyNotGuaranteed: true;
}

/**
 * Read-only rule classification forecast.
 *
 * Reuses the REAL matching engine (`matchTransactions` with shadow disabled),
 * so the forecast matches the classification a real apply would produce using
 * the same eligibility filter. Deterministic canonical ordering is preserved:
 * rules come back ordered by `priority asc`, and each rule's `txIds` are
 * sorted ascending — matching the ordering a real `executeApplyAll` applies.
 *
 * This method NEVER writes: no transactions, journals, balances, audit events,
 * and no durable RuleApplyRecord. It makes no ledger-accuracy claim.
 */
export async function simulateApply(
  companyId: string,
  options?: SimulationOptions,
): Promise<SimulationResult> {
  const matchResult = await matchTransactions(companyId, options);

  const canonicalMatchResult: MatchResult = {
    ...matchResult,
    matchedRules: matchResult.matchedRules
      .map((rule) => ({
        ...rule,
        txIds: [...rule.txIds].sort(),
      }))
      .sort((a, b) => (a.rule.priority ?? 0) - (b.rule.priority ?? 0)),
  };

  return {
    matchResult: canonicalMatchResult,
    readOnly: true,
    recordCreated: false,
    ledgerAccuracyNotGuaranteed: true,
  };
}
