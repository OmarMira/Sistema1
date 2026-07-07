import type { DecisionReason } from '../entity/types';

export interface KnowledgeAuditEntry {
  id: string;
  knowledgeId: string;
  action: string;
  version: number;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  changedByUserId: string;
  timestamp: Date;
  source: string;
  reason: string;
}

export interface ExplainabilityResponse {
  source: string;
  knowledgeId: string;
  canonicalName: string;
  relationship: string | null;
  version: number;
  decisionReason: DecisionReason;
}
