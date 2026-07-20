import { db } from '@/lib/db';
import {
  matchTransactionsWithShadow,
  executeApplyAll,
} from '@/lib/services/apply-all-engine';
import { persistShadowSummaryBestEffort } from '@/lib/services/rule-precedence-shadow';
import type { MatchResult, ApplyResult } from '@/lib/services/apply-all-engine';

export interface ApplyAllUseCaseResult {
  matchResult: MatchResult;
  applyResult: ApplyResult;
}

export async function executeApplyAllUseCase(
  companyId: string,
): Promise<ApplyAllUseCaseResult> {
  const result = await matchTransactionsWithShadow(companyId, { limit: 200 });
  const { matchResult } = result;

  if (matchResult.matchedRules.length === 0 || matchResult.totalCount === 0) {
    return {
      matchResult,
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
    };
  }

  const applyResult = await db.$transaction(async (tx) => {
    return executeApplyAll(companyId, tx, matchResult);
  });

  if (result.kind === 'with-shadow') {
    await persistShadowSummaryBestEffort({
      companyId,
      entity: 'ApplyAllBatch',
      entityId: result.shadow.batchId,
      summary: result.shadow.summary,
    });
  }

  return { matchResult, applyResult };
}
