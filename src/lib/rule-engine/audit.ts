import { db } from '@/lib/db';
import type { AuditRecord } from './types';

function mapResult(result: AuditRecord['result']): string {
  switch (result) {
    case 'winner': return 'MATCHED';
    case 'ambiguous': return 'AMBIGUOUS';
    case 'no_match': return 'NO_MATCH';
  }
}

export async function persistRuleExecutionAudit(data: AuditRecord): Promise<void> {
  try {
    await db.ruleExecutionAudit.create({
      data: {
        engineVersion: data.engineVersion,
        transactionId: data.transactionId,
        companyId: data.companyId,
        result: mapResult(data.result),
        winnerRuleId: data.winnerRuleId ?? null,
        candidateCount: data.candidateCount,
        trace: JSON.stringify(data.trace),
      },
    });
  } catch {
    // best-effort, never throw
  }
}
