import { z } from 'zod';

export const EntityTypeValues = [
  'person',
  'company',
  'financial_product',
  'platform',
  'asset',
] as const;

export const entityTypeSchema = z.enum(EntityTypeValues);

export type EntityType = z.infer<typeof entityTypeSchema>;

export const DecisionReasonValues = [
  'company_knowledge_confirmed',
  'company_knowledge_updated',
  'company_knowledge_merged',
  'entity_context_match',
  'bank_rule_match',
  'llm_suggestion',
  'manual_override',
  'fallback_default',
] as const;

export const decisionReasonSchema = z.enum(DecisionReasonValues);

export type DecisionReason = z.infer<typeof decisionReasonSchema>;

export const KnowledgeSourceValues = [
  'company_knowledge',
  'entity_context',
  'llm',
] as const;

export const knowledgeSourceSchema = z.enum(KnowledgeSourceValues);

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export interface Origin {
  knowledgeId: string;
  version: number;
  source: KnowledgeSource;
  decisionReason: DecisionReason;
  timestamp: Date;
}

export interface CompanyKnowledgeRecord {
  id: string;
  companyId: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  relationship: string | null;
  metadata: Record<string, unknown>;
  source: string;
  status: 'active' | 'archived' | 'merged';
  mergedIntoId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingApprovalRecord {
  id: string;
  knowledgeId: string | null;
  action: 'create' | 'update' | 'archive' | 'restore' | 'merge';
  payload: Record<string, unknown>;
  requestedBy: string;
  requestedAt: Date;
  status: 'pending' | 'approved' | 'rejected';
}

export function resolveDecisionReason(source: string): DecisionReason {
  switch (source) {
    case 'company_knowledge':
    case 'company_knowledge_confirmed':
      return 'company_knowledge_confirmed';
    case 'company_knowledge_updated':
      return 'company_knowledge_updated';
    case 'company_knowledge_merged':
      return 'company_knowledge_merged';
    case 'entity_context':
    case 'entity_context_match':
      return 'entity_context_match';
    case 'bank_rule':
    case 'bank_rule_match':
      return 'bank_rule_match';
    case 'llm':
    case 'llm_suggestion':
      return 'llm_suggestion';
    case 'manual_override':
      return 'manual_override';
    default:
      return 'fallback_default';
  }
}

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
