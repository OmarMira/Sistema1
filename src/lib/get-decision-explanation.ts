// §GAP9 — Backend transport: sanitized explanation from AuditLog provenance
// Uses existing AuditLog (FINAL_DECISION_SOURCE) from Gap #8.
// No new persistence; no schema change; no audit exposure of raw details.

import { db } from '@/lib/db';
import type { DecisionSource, DecisionExplanationDto } from './types/decision-explanation';
import { buildDecisionExplanation } from './decision-explanation-labels';

export async function resolveDecisionExplanation(
  companyId: string,
  transactionId: string,
): Promise<DecisionExplanationDto | null> {
  if (!companyId || !transactionId) return null;

  const row = await db.auditLog.findFirst({
    where: {
      companyId,
      action: 'FINAL_DECISION_SOURCE',
      entity: 'BankTransaction',
      entityId: transactionId,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!row) return null;

  try {
    const details = JSON.parse(row.details ?? '{}') as Record<string, string | null>;
    const source = (details.source as DecisionSource) ?? 'KNOWLEDGE';
    const matchedRuleId = details.matchedRuleId ?? undefined;

    // Sanitize: only pass label + optional rule reference.
    // Never expose approvalId, raw details, or other internal fields.
    const ruleName: string | undefined = matchedRuleId
      ? await resolveRuleNameSafely(matchedRuleId, companyId)
      : undefined;

    return buildDecisionExplanation(source, ruleName);
  } catch {
    return null;
  }
}

async function resolveRuleNameSafely(
  ruleId: string,
  companyId: string,
): Promise<string | undefined> {
  try {
    const rule = await db.bankRule.findFirst({
      where: { id: ruleId, companyId },
      select: { name: true },
    });
    return rule?.name ?? undefined;
  } catch {
    return undefined;
  }
}
