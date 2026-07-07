import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { entityMetadataByType } from './metadata-schemas';
import type {
  EntityType,
  CompanyKnowledgeRecord,
  PendingApprovalRecord,
} from './types';

// ───────────────────────────────────────────────
// Input Types
// ───────────────────────────────────────────────

export interface ProposeCreateInput {
  companyId: string;
  type: EntityType;
  canonicalName: string;
  aliases?: string[];
  relationship?: string;
  metadata: Record<string, unknown>;
  source?: string;
  requestedBy: string;
}

export interface ConfirmCreateInput {
  pendingApprovalId: string;
  confirmedByUserId: string;
  reason?: string;
}

export interface ProposeUpdateInput {
  knowledgeId: string;
  companyId: string;
  updates: {
    canonicalName?: string;
    aliases?: string[];
    relationship?: string;
    metadata?: Record<string, unknown>;
  };
  requestedBy: string;
}

export interface ConfirmUpdateInput {
  pendingApprovalId: string;
  confirmedByUserId: string;
  reason?: string;
}

export interface ArchiveInput {
  knowledgeId: string;
  companyId: string;
  changedByUserId: string;
  reason?: string;
}

export interface RestoreInput {
  knowledgeId: string;
  companyId: string;
  changedByUserId: string;
  reason?: string;
}

export interface MergeInput {
  sourceKnowledgeId: string;
  targetKnowledgeId: string;
  companyId: string;
  fieldResolutions: Record<string, unknown>;
  changedByUserId: string;
  reason?: string;
}

// ───────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────

async function appendAuditEntry(params: {
  knowledgeId: string;
  action: string;
  version: number;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  changedByUserId: string;
  source: string;
  reason: string;
}): Promise<void> {
  await db.knowledgeAudit.create({
    data: {
      knowledgeId: params.knowledgeId,
      action: params.action,
      version: params.version,
      beforeValue: params.beforeValue ?? Prisma.DbNull,
      afterValue: params.afterValue ?? Prisma.DbNull,
      changedByUserId: params.changedByUserId,
      source: params.source,
      reason: params.reason,
    },
  });
}

function toPrismaEntityType(type: EntityType): 'PERSON' | 'COMPANY' | 'FINANCIAL_PRODUCT' | 'PLATFORM' | 'ASSET' {
  const map: Record<EntityType, 'PERSON' | 'COMPANY' | 'FINANCIAL_PRODUCT' | 'PLATFORM' | 'ASSET'> = {
    person: 'PERSON',
    company: 'COMPANY',
    financial_product: 'FINANCIAL_PRODUCT',
    platform: 'PLATFORM',
    asset: 'ASSET',
  };
  return map[type];
}

async function assertCompanyKnowledgeExists(
  knowledgeId: string,
  companyId: string,
): Promise<CompanyKnowledgeRecord> {
  const record = await db.companyKnowledge.findUnique({
    where: { id: knowledgeId },
  });

  if (!record) {
    throw new Error(`CompanyKnowledge ${knowledgeId} not found`);
  }

  if (record.companyId !== companyId) {
    throw new Error('Company isolation violation');
  }

  return record as unknown as CompanyKnowledgeRecord;
}

// ───────────────────────────────────────────────
// Create flow — propose + confirm
// ───────────────────────────────────────────────

export async function proposeCreate(
  input: ProposeCreateInput,
): Promise<PendingApprovalRecord> {
  // 1. Validate metadata per type
  const schema = entityMetadataByType[input.type];

  if (!schema) {
    throw new Error(`Unknown entity type: ${input.type}`);
  }

  const validatedMetadata = schema.parse(input.metadata);

  // 2. Check 1,000 active cap
  const activeCount = await db.companyKnowledge.count({
    where: { companyId: input.companyId, status: 'active' },
  });

  if (activeCount >= 1000) {
    throw new Error('Active entity limit reached (max 1000)');
  }

  // 3. Create PendingApproval
  const pending = await db.pendingApproval.create({
    data: {
      action: 'create',
      payload: {
        companyId: input.companyId,
        type: input.type,
        canonicalName: input.canonicalName,
        aliases: input.aliases ?? [],
        relationship: input.relationship ?? null,
        metadata: validatedMetadata,
        source: input.source ?? 'company_knowledge',
      },
      requestedBy: input.requestedBy,
      status: 'pending',
    },
  });

  return pending as unknown as PendingApprovalRecord;
}

export async function confirmCreate(
  input: ConfirmCreateInput,
): Promise<CompanyKnowledgeRecord> {
  // 1. Read + validate PendingApproval
  const pending = await db.pendingApproval.findUnique({
    where: { id: input.pendingApprovalId },
  });

  if (!pending) {
    throw new Error(
      `PendingApproval ${input.pendingApprovalId} not found`,
    );
  }

  if (pending.status !== 'pending') {
    throw new Error('PendingApproval is not in pending state');
  }

  if (pending.action !== 'create') {
    throw new Error('PendingApproval action must be "create"');
  }

  const payload = pending.payload as Record<string, unknown>;

  // 2. Create CompanyKnowledge with version=1
  const record = await db.companyKnowledge.create({
    data: {
      companyId: payload.companyId as string,
      type: toPrismaEntityType(payload.type as EntityType),
      canonicalName: payload.canonicalName as string,
      aliases: (payload.aliases as string[]) ?? [],
      relationship: (payload.relationship as string) ?? null,
      metadata: (payload.metadata as Record<string, unknown>) ?? {},
      source: (payload.source as string) ?? 'company_knowledge',
      status: 'active',
      version: 1,
    },
  });

  // 3. Create KnowledgeAudit entry
  await appendAuditEntry({
    knowledgeId: record.id,
    action: 'create',
    version: 1,
    beforeValue: null,
    afterValue: {
      companyId: record.companyId,
      type: record.type,
      canonicalName: record.canonicalName,
    },
    changedByUserId: input.confirmedByUserId,
    source: 'company_knowledge',
    reason: input.reason ?? 'Entity created',
  });

  // 4. Delete PendingApproval
  await db.pendingApproval.delete({
    where: { id: input.pendingApprovalId },
  });

  return record as unknown as CompanyKnowledgeRecord;
}

// ───────────────────────────────────────────────
// Update flow — propose + confirm
// ───────────────────────────────────────────────

export async function proposeUpdate(
  input: ProposeUpdateInput,
): Promise<PendingApprovalRecord> {
  // 1. Read current record (verify existence + company isolation)
  const existing = await assertCompanyKnowledgeExists(
    input.knowledgeId,
    input.companyId,
  );

  // 2. Validate new metadata if provided
  if (input.updates.metadata) {
    const schema = entityMetadataByType[existing.type];

    if (!schema) {
      throw new Error(`Unknown entity type: ${existing.type}`);
    }

    schema.parse(input.updates.metadata);
  }

  // 3. Build before/after snapshots
  const beforeSnapshot: Record<string, unknown> = {
    canonicalName: existing.canonicalName,
    aliases: existing.aliases,
    relationship: existing.relationship,
    metadata: existing.metadata,
  };

  const afterSnapshot: Record<string, unknown> = {
    canonicalName: input.updates.canonicalName ?? existing.canonicalName,
    aliases: input.updates.aliases ?? existing.aliases,
    relationship: input.updates.relationship ?? existing.relationship,
    metadata: input.updates.metadata ?? existing.metadata,
    version: existing.version + 1,
  };

  // 4. Create PendingApproval
  const pending = await db.pendingApproval.create({
    data: {
      action: 'update',
      knowledgeId: input.knowledgeId,
      payload: {
        knowledgeId: input.knowledgeId,
        before: beforeSnapshot,
        after: afterSnapshot,
        updates: input.updates,
      },
      requestedBy: input.requestedBy,
      status: 'pending',
    },
  });

  return pending as unknown as PendingApprovalRecord;
}

export async function confirmUpdate(
  input: ConfirmUpdateInput,
): Promise<CompanyKnowledgeRecord> {
  // 1. Read + validate PendingApproval
  const pending = await db.pendingApproval.findUnique({
    where: { id: input.pendingApprovalId },
  });

  if (!pending) {
    throw new Error(
      `PendingApproval ${input.pendingApprovalId} not found`,
    );
  }

  if (pending.status !== 'pending') {
    throw new Error('PendingApproval is not in pending state');
  }

  if (pending.action !== 'update') {
    throw new Error('PendingApproval action must be "update"');
  }

  const payload = pending.payload as Record<string, unknown>;
  const updates = payload.updates as Record<string, unknown>;

  // 2. Read current record for version increment
  const existing = await db.companyKnowledge.findUnique({
    where: { id: payload.knowledgeId as string },
  });

  if (!existing) {
    throw new Error(
      `CompanyKnowledge ${payload.knowledgeId} not found`,
    );
  }

  const newVersion = existing.version + 1;

  // 3. Update CompanyKnowledge
  const updateData: Record<string, unknown> = {};

  if (updates.canonicalName !== undefined) {
    updateData.canonicalName = updates.canonicalName;
  }

  if (updates.aliases !== undefined) {
    updateData.aliases = updates.aliases;
  }

  if (updates.relationship !== undefined) {
    updateData.relationship = updates.relationship;
  }

  if (updates.metadata !== undefined) {
    updateData.metadata = updates.metadata;
  }

  updateData.version = newVersion;

  const record = await db.companyKnowledge.update({
    where: { id: payload.knowledgeId as string },
    data: updateData,
  });

  // 4. Create KnowledgeAudit entry
  await appendAuditEntry({
    knowledgeId: payload.knowledgeId as string,
    action: 'update',
    version: newVersion,
    beforeValue: (payload.before as Record<string, unknown>) ?? null,
    afterValue: (payload.after as Record<string, unknown>) ?? null,
    changedByUserId: input.confirmedByUserId,
    source: (record as Record<string, unknown>).source as string,
    reason: input.reason ?? 'Entity updated',
  });

  // 5. Delete PendingApproval
  await db.pendingApproval.delete({
    where: { id: input.pendingApprovalId },
  });

  return record as unknown as CompanyKnowledgeRecord;
}

// ───────────────────────────────────────────────
// Archive / Restore — direct operations
// ───────────────────────────────────────────────

export async function archive(
  input: ArchiveInput,
): Promise<CompanyKnowledgeRecord> {
  const existing = await assertCompanyKnowledgeExists(
    input.knowledgeId,
    input.companyId,
  );

  if (existing.status !== 'active') {
    throw new Error(
      `Cannot archive: entity ${input.knowledgeId} is not active (current status: ${existing.status})`,
    );
  }

  const newVersion = existing.version + 1;

  const record = await db.companyKnowledge.update({
    where: { id: input.knowledgeId },
    data: {
      status: 'archived',
      version: newVersion,
    },
  });

  await appendAuditEntry({
    knowledgeId: input.knowledgeId,
    action: 'archive',
    version: newVersion,
    beforeValue: { status: 'active' },
    afterValue: { status: 'archived' },
    changedByUserId: input.changedByUserId,
    source: 'company_knowledge',
    reason: input.reason ?? 'Entity archived',
  });

  return record as unknown as CompanyKnowledgeRecord;
}

export async function restore(
  input: RestoreInput,
): Promise<CompanyKnowledgeRecord> {
  const existing = await assertCompanyKnowledgeExists(
    input.knowledgeId,
    input.companyId,
  );

  if (existing.status !== 'archived') {
    throw new Error(
      `Cannot restore: entity ${input.knowledgeId} is not archived (current status: ${existing.status})`,
    );
  }

  const newVersion = existing.version + 1;

  const record = await db.companyKnowledge.update({
    where: { id: input.knowledgeId },
    data: {
      status: 'active',
      version: newVersion,
    },
  });

  await appendAuditEntry({
    knowledgeId: input.knowledgeId,
    action: 'restore',
    version: newVersion,
    beforeValue: { status: 'archived' },
    afterValue: { status: 'active' },
    changedByUserId: input.changedByUserId,
    source: 'company_knowledge',
    reason: input.reason ?? 'Entity restored',
  });

  return record as unknown as CompanyKnowledgeRecord;
}

// ───────────────────────────────────────────────
// Merge — source gets merged into target
// ───────────────────────────────────────────────

export async function merge(
  input: MergeInput,
): Promise<CompanyKnowledgeRecord> {
  // 1. Verify both entities exist and belong to the company
  const source = await assertCompanyKnowledgeExists(
    input.sourceKnowledgeId,
    input.companyId,
  );

  const target = await assertCompanyKnowledgeExists(
    input.targetKnowledgeId,
    input.companyId,
  );

  // 2. Validate both are active (cannot merge archived or already merged)
  if (source.status !== 'active') {
    throw new Error(
      `Cannot merge: source ${input.sourceKnowledgeId} is not active (status: ${source.status})`,
    );
  }

  if (target.status !== 'active') {
    throw new Error(
      `Cannot merge: target ${input.targetKnowledgeId} is not active (status: ${target.status})`,
    );
  }

  // 3. Apply field resolutions to target
  const targetNewVersion = target.version + 1;
  const sourceNewVersion = source.version + 1;

  // Filter fieldResolutions to known updatable fields
  const resolvableFields: Record<string, unknown> = {};

  if (input.fieldResolutions.canonicalName !== undefined) {
    resolvableFields.canonicalName = input.fieldResolutions.canonicalName;
  }

  if (input.fieldResolutions.aliases !== undefined) {
    resolvableFields.aliases = input.fieldResolutions.aliases;
  }

  if (input.fieldResolutions.relationship !== undefined) {
    resolvableFields.relationship = input.fieldResolutions.relationship;
  }

  if (input.fieldResolutions.metadata !== undefined) {
    resolvableFields.metadata = input.fieldResolutions.metadata;
  }

  resolvableFields.version = targetNewVersion;

  // 4. Update target with resolved fields
  const updatedTarget = await db.companyKnowledge.update({
    where: { id: input.targetKnowledgeId },
    data: resolvableFields,
  });

  // 5. Set source as merged
  await db.companyKnowledge.update({
    where: { id: input.sourceKnowledgeId },
    data: {
      status: 'merged',
      mergedIntoId: input.targetKnowledgeId,
      version: sourceNewVersion,
    },
  });

  // 6. Audit entries for both
  await appendAuditEntry({
    knowledgeId: input.sourceKnowledgeId,
    action: 'merge',
    version: sourceNewVersion,
    beforeValue: { status: source.status, mergedIntoId: null },
    afterValue: {
      status: 'merged',
      mergedIntoId: input.targetKnowledgeId,
    },
    changedByUserId: input.changedByUserId,
    source: 'company_knowledge',
    reason: input.reason ?? `Merged into ${input.targetKnowledgeId}`,
  });

  await appendAuditEntry({
    knowledgeId: input.targetKnowledgeId,
    action: 'merge',
    version: targetNewVersion,
    beforeValue: { canonicalName: target.canonicalName },
    afterValue: {
      canonicalName: updatedTarget.canonicalName,
      ...(Object.keys(resolvableFields).length > 0
        ? { resolvedFields: Object.keys(input.fieldResolutions) }
        : {}),
    },
    changedByUserId: input.changedByUserId,
    source: 'company_knowledge',
    reason: input.reason ?? `Merged from ${input.sourceKnowledgeId}`,
  });

  return updatedTarget as unknown as CompanyKnowledgeRecord;
}
