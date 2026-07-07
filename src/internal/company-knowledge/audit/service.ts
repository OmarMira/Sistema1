import { db } from '@/lib/db';
import { resolveDecisionReason } from '../entity/types';
import type { ExplainabilityResponse } from './types';
import type { KnowledgeAuditEntry } from './types';

export async function getAuditTrail(knowledgeId: string): Promise<KnowledgeAuditEntry[]> {
  const entries = await db.knowledgeAudit.findMany({
    where: { knowledgeId },
    orderBy: { timestamp: 'asc' },
  });
  return entries as unknown as KnowledgeAuditEntry[];
}

export async function getExplainabilityPayload(knowledgeId: string): Promise<ExplainabilityResponse | null> {
  const record = await db.companyKnowledge.findUnique({
    where: { id: knowledgeId },
  });
  if (!record) return null;
  return {
    source: record.source as string,
    knowledgeId: record.id,
    canonicalName: record.canonicalName,
    relationship: record.relationship,
    version: record.version,
    decisionReason: resolveDecisionReason(record.source),
  };
}
