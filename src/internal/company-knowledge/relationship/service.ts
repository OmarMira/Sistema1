import { db } from '@/lib/db';
import { relationshipSchema } from './types';
import type { CompanyKnowledgeRecord } from '../entity/types';

// ───────────────────────────────────────────────
// Input Types
// ───────────────────────────────────────────────

export type ResolvedBy = 'user_confirmed' | 'correction' | 'system_suggested';

export interface UpdateRelationshipInput {
  /** The CompanyKnowledge record to update */
  knowledgeId: string;
  /** Company isolation check */
  companyId: string;
  /** New relationship value — validated against 9-value vocabulary */
  relationship: string;
  /** How this value was determined — maps to the source field */
  resolvedBy: ResolvedBy;
  /** Who performed this update */
  changedByUserId: string;
  /** Optional reason for the audit trail */
  reason?: string;
}

// ───────────────────────────────────────────────
// ResolvedBy → KnowledgeSource mapping
// ───────────────────────────────────────────────

const resolvedBySourceMap: Record<ResolvedBy, string> = {
  user_confirmed: 'company_knowledge',
  correction: 'company_knowledge',
  system_suggested: 'llm',
};

// ───────────────────────────────────────────────
// Internal: update relationship on a CompanyKnowledge record
// Called by Entity Knowledge (Aggregate Root) — never independently.
// ───────────────────────────────────────────────

export async function updateRelationship(
  input: UpdateRelationshipInput,
): Promise<CompanyKnowledgeRecord> {
  // 1. Validate relationship value against 9-value vocabulary
  const parsed = relationshipSchema.parse(input.relationship);

  // 2. Verify entity exists and belongs to the company
  const existing = await db.companyKnowledge.findUnique({
    where: { id: input.knowledgeId },
  });

  if (!existing) {
    throw new Error(`CompanyKnowledge ${input.knowledgeId} not found`);
  }

  if (existing.companyId !== input.companyId) {
    throw new Error('Company isolation violation');
  }

  // 3. Build the update
  const newVersion = existing.version + 1;
  const newSource =
    resolvedBySourceMap[input.resolvedBy] ?? 'company_knowledge';

  const beforeValue: Record<string, unknown> = {
    relationship: existing.relationship,
    source: existing.source,
  };

  const afterValue: Record<string, unknown> = {
    relationship: parsed,
    source: newSource,
  };

  // 4. Update the record: relationship + source + version bump
  const updated = await db.companyKnowledge.update({
    where: { id: input.knowledgeId },
    data: {
      relationship: parsed,
      source: newSource,
      version: newVersion,
    },
  });

  // 5. Append audit entry
  await db.knowledgeAudit.create({
    data: {
      knowledgeId: input.knowledgeId,
      action: 'update',
      version: newVersion,
      beforeValue,
      afterValue,
      changedByUserId: input.changedByUserId,
      source: newSource,
      reason:
        input.reason ??
        `Relationship updated via ${input.resolvedBy}: ${String(existing.relationship)} → ${parsed}`,
    },
  });

  return updated as unknown as CompanyKnowledgeRecord;
}
