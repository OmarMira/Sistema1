import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { requireCurrentUserId } from '@/lib/context-storage';
import { ConflictError, ForbiddenError } from '@/lib/api-error';
import { normalizeForResolution } from '@/memory/entity-resolution';
import {
  createAdapter,
  snapshotEntityMergeKnowledge,
  validateEntityMergeChoices,
  applyEntityMergeKnowledge,
} from '@/memory/classification-knowledge';
import type { MemoryPrismaClient, TransactionRunner } from '@/memory/prisma-types';
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
  companyId: string;
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
  companyId: string;
  reason?: string;
}

export interface ArchiveInput {
  knowledgeId: string;
  companyId: string;
  reason?: string;
}

export interface RestoreInput {
  knowledgeId: string;
  companyId: string;
  reason?: string;
}

export interface MergeInput {
  sourceKnowledgeId: string;
  targetKnowledgeId: string;
  companyId: string;
  fieldResolutions: Record<string, unknown>;
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
  source: string;
  reason: string;
  /** Optional transaction client so audits commit atomically with their writes (G8-1 §13). */
  client?: Prisma.TransactionClient | { knowledgeAudit: typeof db.knowledgeAudit };
}): Promise<void> {
  const changedByUserId = requireCurrentUserId();
  const auditClient = (params.client ?? db) as typeof db;
  await auditClient.knowledgeAudit.create({
    data: {
      knowledgeId: params.knowledgeId,
      action: params.action,
      version: params.version,
      beforeValue: params.beforeValue ?? Prisma.DbNull,
      afterValue: params.afterValue ?? Prisma.DbNull,
      changedByUserId,
      source: params.source,
      reason: params.reason,
    },
  });
}

/**
 * Deterministic alias union (G8-1 §5): first occurrence wins, exact-string
 * dedupe, order preserved — target aliases, then source aliases, then the
 * source canonicalName (so descriptions that previously resolved via SOURCE
 * still resolve to TARGET), then any explicit alias resolution.
 */
function unionAliases(...aliasLists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of aliasLists) {
    for (const alias of list ?? []) {
      if (typeof alias !== 'string' || alias.trim() === '') continue;
      if (seen.has(alias)) continue;
      seen.add(alias);
      result.push(alias);
    }
  }
  return result;
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

function fromPrismaEntityType(type: 'PERSON' | 'COMPANY' | 'FINANCIAL_PRODUCT' | 'PLATFORM' | 'ASSET'): EntityType {
  const map: Record<string, EntityType> = {
    PERSON: 'person',
    COMPANY: 'company',
    FINANCIAL_PRODUCT: 'financial_product',
    PLATFORM: 'platform',
    ASSET: 'asset',
  };
  return map[type] ?? 'person';
}

function toCompanyKnowledgeRecord(row: {
  id: string;
  companyId: string;
  type: 'PERSON' | 'COMPANY' | 'FINANCIAL_PRODUCT' | 'PLATFORM' | 'ASSET';
  canonicalName: string;
  aliases: string[];
  relationship: string | null;
  metadata: unknown;
  source: string;
  status: string;
  mergedIntoId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): CompanyKnowledgeRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    type: fromPrismaEntityType(row.type),
    canonicalName: row.canonicalName,
    aliases: row.aliases,
    relationship: row.relationship,
    metadata: row.metadata as Record<string, unknown>,
    source: row.source,
    status: row.status as 'active' | 'archived' | 'merged',
    mergedIntoId: row.mergedIntoId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

/**
 * G8-2 company lock — serialize identity mutations per company.
 *
 * Call FIRST inside an interactive transaction, before any write:
 * SELECT ... FOR UPDATE is itself read-only and blocks concurrent
 * confirmers on the same company. Zero rows = company missing, so it
 * fails before any write. One PrismaClient, no nested transaction.
 */
async function acquireCompanyLock(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`,
  );

  if (rows.length === 0) {
    throw new Error(`Company ${companyId} not found`);
  }
}

/**
 * G8-2 identity disjointness precheck — reject identity collisions with
 * 409 BEFORE any write. Candidate canonicalName + aliases are compared
 * against canonicalName + aliases of other ACTIVE entities of the same
 * company, normalized with EXACTLY normalizeForResolution on both sides.
 * Only status='active' reserves identity (archived/merged never do).
 * excludeKnowledgeId keeps a record out of its own comparison (update flows).
 */
async function assertIdentityDisjoint(
  tx: Prisma.TransactionClient,
  params: {
    companyId: string;
    canonicalName: string;
    aliases?: string[];
    excludeKnowledgeId?: string;
  },
): Promise<void> {
  const others = await tx.companyKnowledge.findMany({
    where: {
      companyId: params.companyId,
      status: 'active',
      ...(params.excludeKnowledgeId
        ? { id: { not: params.excludeKnowledgeId } }
        : {}),
    },
    select: { canonicalName: true, aliases: true },
  });

  const candidateKeys = new Set<string>();
  for (const key of [params.canonicalName, ...(params.aliases ?? [])]) {
    if (typeof key !== 'string' || key.trim() === '') continue;
    candidateKeys.add(normalizeForResolution(key));
  }

  for (const other of others) {
    for (const key of [other.canonicalName, ...other.aliases]) {
      if (typeof key !== 'string' || key.trim() === '') continue;
      const normalizedExisting = normalizeForResolution(key);
      if (candidateKeys.has(normalizedExisting)) {
        throw new ConflictError(
          `Identity "${normalizedExisting}" already belongs to an active entity of this company`,
        );
      }
    }
  }
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
  // G8-2 §5: single interactive transaction. Causal order — Company lock →
  // validate PendingApproval → identity precheck → once-only CAS → writes →
  // COMMIT. Any exception rolls back everything, including the CAS claim.
  return db.$transaction(async (tx) => {
    // 1. Company FOR UPDATE first — zero rows fails before any write.
    await acquireCompanyLock(
      tx as unknown as Prisma.TransactionClient,
      input.companyId,
    );

    // 2. Read + validate PendingApproval.
    const pending = await tx.pendingApproval.findUnique({
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

    // Tenant isolation: the confirming user must belong to the company that
    // owns the proposal. pendingApprovalId is not a trust anchor — the
    // payload's companyId is fixed when the proposal is created, so compare
    // against the authenticated context BEFORE creating anything.
    if (payload.companyId !== input.companyId) {
      throw new ForbiddenError(
        'Forbidden: cannot confirm a proposal from another company',
      );
    }

    // 3. Identity disjointness precheck before any write — 409 on collision.
    await assertIdentityDisjoint(tx as unknown as Prisma.TransactionClient, {
      companyId: payload.companyId as string,
      canonicalName: payload.canonicalName as string,
      aliases: (payload.aliases as string[]) ?? [],
    });

    // 4-5. CAS once-only (G8-2 §6): id + status=pending. Count !== 1 means
    // the approval was consumed elsewhere — stop before any functional write.
    const cas = await tx.pendingApproval.updateMany({
      where: { id: input.pendingApprovalId, status: 'pending' },
      data: { status: 'accepted' },
    });
    if (cas.count !== 1) {
      throw new Error('NOT_PENDING');
    }

    // 6. Create CompanyKnowledge with version=1.
    const record = await tx.companyKnowledge.create({
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

    // 7. KnowledgeAudit entry on the SAME transaction client.
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
      source: 'company_knowledge',
      reason: input.reason ?? 'Entity created',
      client: tx,
    });

    // 8. Finalize PendingApproval — existing semantics: delete (in-tx).
    await tx.pendingApproval.delete({
      where: { id: input.pendingApprovalId },
    });

    return record as unknown as CompanyKnowledgeRecord;
  });
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
  // G8-2 §6: single interactive transaction. Causal order — Company lock →
  // validate PendingApproval → revalidate record → identity precheck
  // (exclude self) → update → audit → COMMIT. Any exception rolls back
  // everything, including the PendingApproval delete.
  return db.$transaction(async (tx) => {
    // 1. Company FOR UPDATE first — zero rows fails before any write.
    await acquireCompanyLock(
      tx as unknown as Prisma.TransactionClient,
      input.companyId,
    );

    // 2. Read + validate PendingApproval.
    const pending = await tx.pendingApproval.findUnique({
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

    // 3. Re-read current record inside the same transaction — version
    // increment and precheck operate on the freshest state.
    const existing = await tx.companyKnowledge.findUnique({
      where: { id: payload.knowledgeId as string },
    });

    if (!existing) {
      throw new Error(
        `CompanyKnowledge ${payload.knowledgeId} not found`,
      );
    }

    // Tenant isolation: the authority to confirm is the company that owns the
    // CompanyKnowledge being modified, NOT the declared companyId of the
    // request nor the proposal id. Reject before consuming the approval.
    if (existing.companyId !== input.companyId) {
      throw new ForbiddenError(
        'Forbidden: cannot confirm an update to knowledge of another company',
      );
    }

    const newVersion = existing.version + 1;

    // 4. Build update payload (preexisting field semantics preserved).
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

    // 5-6. Identity disjointness precheck inside the transaction, excluding
    // this record from its own comparison — ConflictError/409 on collision,
    // BEFORE any write.
    await assertIdentityDisjoint(tx as unknown as Prisma.TransactionClient, {
      companyId: existing.companyId,
      canonicalName:
        (updateData.canonicalName as string | undefined) ??
        existing.canonicalName,
      aliases: (updateData.aliases as string[] | undefined) ?? existing.aliases,
      excludeKnowledgeId: existing.id,
    });

    // 7. Update CompanyKnowledge only after the precheck passed.
    const record = await tx.companyKnowledge.update({
      where: { id: payload.knowledgeId as string },
      data: updateData,
    });

    // 8. KnowledgeAudit entry on the SAME transaction client.
    await appendAuditEntry({
      knowledgeId: payload.knowledgeId as string,
      action: 'update',
      version: newVersion,
      beforeValue: (payload.before as Record<string, unknown>) ?? null,
      afterValue: (payload.after as Record<string, unknown>) ?? null,
      source: (record as Record<string, unknown>).source as string,
      reason: input.reason ?? 'Entity updated',
      client: tx,
    });

    // 9. Delete PendingApproval — existing semantics: delete (in-tx).
    await tx.pendingApproval.delete({
      where: { id: input.pendingApprovalId },
    });

    return record as unknown as CompanyKnowledgeRecord;
  });
}

// ───────────────────────────────────────────────
// Archive / Restore — direct operations
// ───────────────────────────────────────────────

export async function archive(
  input: ArchiveInput,
): Promise<CompanyKnowledgeRecord> {
  // G8-2 §6: single interactive transaction. Company lock → re-read →
  // status revalidation inside the tx → only active → archived → audit →
  // COMMIT. The internal revalidation guarantees a stale archive never
  // overwrites a record that meanwhile became merged.
  return db.$transaction(async (tx) => {
    // 1. Company FOR UPDATE first — zero rows fails before any write.
    await acquireCompanyLock(
      tx as unknown as Prisma.TransactionClient,
      input.companyId,
    );

    // 2. Re-read + revalidate inside the same transaction.
    const existing = await tx.companyKnowledge.findUnique({
      where: { id: input.knowledgeId },
    });

    if (!existing) {
      throw new Error(`CompanyKnowledge ${input.knowledgeId} not found`);
    }

    if (existing.companyId !== input.companyId) {
      throw new Error('Company isolation violation');
    }

    if (existing.status !== 'active') {
      throw new Error(
        `Cannot archive: entity ${input.knowledgeId} is not active (current status: ${existing.status})`,
      );
    }

    const newVersion = existing.version + 1;

    // 3. Only active → archived; no other transitions.
    const record = await tx.companyKnowledge.update({
      where: { id: input.knowledgeId },
      data: {
        status: 'archived',
        version: newVersion,
      },
    });

    // 4. KnowledgeAudit entry on the SAME transaction client.
    await appendAuditEntry({
      knowledgeId: input.knowledgeId,
      action: 'archive',
      version: newVersion,
      beforeValue: { status: 'active' },
      afterValue: { status: 'archived' },
      source: 'company_knowledge',
      reason: input.reason ?? 'Entity archived',
      client: tx,
    });

    return record as unknown as CompanyKnowledgeRecord;
  });
}

export async function restore(
  input: RestoreInput,
): Promise<CompanyKnowledgeRecord> {
  // G8-2 §6: single interactive transaction. Company lock → re-read →
  // status revalidation inside the tx → identity precheck before
  // reactivation (exclude self) → only archived → active → audit → COMMIT.
  return db.$transaction(async (tx) => {
    // 1. Company FOR UPDATE first — zero rows fails before any write.
    await acquireCompanyLock(
      tx as unknown as Prisma.TransactionClient,
      input.companyId,
    );

    // 2. Re-read + revalidate inside the same transaction.
    const existing = await tx.companyKnowledge.findUnique({
      where: { id: input.knowledgeId },
    });

    if (!existing) {
      throw new Error(`CompanyKnowledge ${input.knowledgeId} not found`);
    }

    if (existing.companyId !== input.companyId) {
      throw new Error('Company isolation violation');
    }

    if (existing.status !== 'archived') {
      throw new Error(
        `Cannot restore: entity ${input.knowledgeId} is not archived (current status: ${existing.status})`,
      );
    }

    const newVersion = existing.version + 1;

    // 3-4. Identity disjointness precheck BEFORE reactivating — the record's
    // own identity must not collide with another active entity (self
    // excluded) — ConflictError/409 on collision, BEFORE any write.
    await assertIdentityDisjoint(tx as unknown as Prisma.TransactionClient, {
      companyId: existing.companyId,
      canonicalName: existing.canonicalName,
      aliases: existing.aliases,
      excludeKnowledgeId: existing.id,
    });

    // 5. Only archived → active; no other transitions.
    const record = await tx.companyKnowledge.update({
      where: { id: input.knowledgeId },
      data: {
        status: 'active',
        version: newVersion,
      },
    });

    // 6. KnowledgeAudit entry on the SAME transaction client.
    await appendAuditEntry({
      knowledgeId: input.knowledgeId,
      action: 'restore',
      version: newVersion,
      beforeValue: { status: 'archived' },
      afterValue: { status: 'active' },
      source: 'company_knowledge',
      reason: input.reason ?? 'Entity restored',
      client: tx,
    });

    return record as unknown as CompanyKnowledgeRecord;
  });
}

// ───────────────────────────────────────────────
// Merge — source gets merged into target
// ───────────────────────────────────────────────

export async function merge(
  input: MergeInput,
): Promise<CompanyKnowledgeRecord> {
  // G8-1: fieldResolutions may be absent when no conflicts were resolved.
  const fieldResolutions: Record<string, unknown> =
    input.fieldResolutions && typeof input.fieldResolutions === 'object'
      ? input.fieldResolutions
      : {};

  // G8-1 §13 — one interactive transaction: TARGET CK update + SOURCE CK
  // update + KE transfers/deactivations + audits commit together or roll
  // back together. Never CK-merged-with-active-source-KE, never
  // KE-transferred-without-CK-merge.
  return db.$transaction(
    async (tx) => {
      // G8-2 §7 — Company FOR UPDATE FIRST inside the same G8-1 transaction
      // (zero rows fails before any read/write).
      await acquireCompanyLock(
        tx as unknown as Prisma.TransactionClient,
        input.companyId,
      );

      // G8-2 §7 — re-read/revalidate source and target INSIDE the tx: same
      // existence + company isolation checks and messages as the pre-tx
      // reads, now authoritative within the transaction.
      const source = await tx.companyKnowledge.findUnique({
        where: { id: input.sourceKnowledgeId },
      });

      if (!source) {
        throw new Error(`CompanyKnowledge ${input.sourceKnowledgeId} not found`);
      }

      if (source.companyId !== input.companyId) {
        throw new Error('Company isolation violation');
      }

      const target = await tx.companyKnowledge.findUnique({
        where: { id: input.targetKnowledgeId },
      });

      if (!target) {
        throw new Error(`CompanyKnowledge ${input.targetKnowledgeId} not found`);
      }

      if (target.companyId !== input.companyId) {
        throw new Error('Company isolation violation');
      }

      // Validate both are active (cannot merge archived or already merged)
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

      if (fieldResolutions.canonicalName !== undefined) {
        resolvableFields.canonicalName = fieldResolutions.canonicalName;
      }

      if (fieldResolutions.aliases !== undefined) {
        resolvableFields.aliases = fieldResolutions.aliases;
      }

      if (fieldResolutions.relationship !== undefined) {
        resolvableFields.relationship = fieldResolutions.relationship;
      }

      if (fieldResolutions.metadata !== undefined) {
        resolvableFields.metadata = fieldResolutions.metadata;
      }

      // G8-1 §5 — server-side deterministic alias union: the union must NOT
      // depend exclusively on MergeDialog, and no alias needed for a prior
      // SOURCE resolution may be lost.
      const unionedAliases = unionAliases(
        target.aliases,
        source.aliases,
        [source.canonicalName],
        Array.isArray(fieldResolutions.aliases)
          ? (fieldResolutions.aliases as string[])
          : undefined,
      );
      if (unionedAliases.length > 0 || fieldResolutions.aliases !== undefined) {
        resolvableFields.aliases = unionedAliases;
      }

      resolvableFields.version = targetNewVersion;

      const runTx: TransactionRunner = (fn) => fn(tx);
      const adapter = createAdapter(tx as unknown as MemoryPrismaClient, runTx);

      // 4. G8-1 §6 — prevalidation BEFORE any mutation: active/company
      // checks above; KE snapshot + ambiguity/collision validation here.
      // Ambiguous state or an unresolved treatment/AP2 collision throws
      // before a single row is written (zero partial mutation).
      const snapshot = await snapshotEntityMergeKnowledge(
        adapter,
        input.companyId,
        source.id,
        target.id,
      );
      const mergeChoices = {
        treatment: fieldResolutions.treatment,
        authorizedPatterns: fieldResolutions.authorizedPatterns,
      };
      validateEntityMergeChoices(snapshot, mergeChoices);

      // 5. Update target with resolved fields
      const updatedTarget = await tx.companyKnowledge.update({
        where: { id: input.targetKnowledgeId },
        data: resolvableFields,
      });

      // 6. Set source as merged
      await tx.companyKnowledge.update({
        where: { id: input.sourceKnowledgeId },
        data: {
          status: 'merged',
          mergedIntoId: input.targetKnowledgeId,
          version: sourceNewVersion,
        },
      });

      // 7. G8-1 §7–§12 — KE consolidation inside the same transaction:
      // treatments, observations, candidates, authorized patterns.
      const consolidation = await applyEntityMergeKnowledge(
        adapter,
        input.companyId,
        snapshot,
        mergeChoices,
      );

      // 8. Audit entries for both (existing shape) — extended only with
      // the KE consolidation traceability required by G8-1 §14.
      await appendAuditEntry({
        client: tx,
        knowledgeId: input.sourceKnowledgeId,
        action: 'merge',
        version: sourceNewVersion,
        beforeValue: { status: source.status, mergedIntoId: null },
        afterValue: {
          status: 'merged',
          mergedIntoId: input.targetKnowledgeId,
        },
        source: 'company_knowledge',
        reason: input.reason ?? `Merged into ${input.targetKnowledgeId}`,
      });

      await appendAuditEntry({
        client: tx,
        knowledgeId: input.targetKnowledgeId,
        action: 'merge',
        version: targetNewVersion,
        beforeValue: { canonicalName: target.canonicalName },
        afterValue: {
          canonicalName: updatedTarget.canonicalName,
          ...(Object.keys(resolvableFields).length > 0
            ? { resolvedFields: Object.keys(fieldResolutions) }
            : {}),
          knowledgeConsolidation: {
            source: source.id,
            target: target.id,
            transferred: consolidation.transferred,
            deactivated: consolidation.deactivated,
            skipped: consolidation.skipped,
            humanResolutions: {
              ...(fieldResolutions.treatment !== undefined
                ? { treatment: fieldResolutions.treatment }
                : {}),
              ...(fieldResolutions.authorizedPatterns !== undefined
                ? { authorizedPatterns: fieldResolutions.authorizedPatterns }
                : {}),
            },
          },
        },
        source: 'company_knowledge',
        reason: input.reason ?? `Merged from ${input.sourceKnowledgeId}`,
      });

      return updatedTarget as unknown as CompanyKnowledgeRecord;
    },
    { maxWait: 5000, timeout: 15000 },
  );
}

// ───────────────────────────────────────────────
// Confirm Entity Identity (BLOQUE3-101)
// UNKNOWN → confirmed identity → CompanyKnowledge
// ───────────────────────────────────────────────

export interface ConfirmEntityIdentityInput {
  companyId: string;
  canonicalName: string;
  observedAlias: string;
  entityType: EntityType;
  reason?: string;
}

/**
 * Confirm an entity identity and persist it to CompanyKnowledge.
 *
 * This is the bridge between UNKNOWN and KNOWN: when a user explicitly
 * confirms "this description belongs to entity X", this function creates
 * (or reuses) the CompanyKnowledge record so that resolveEntity() will
 * return KNOWN for the observed alias on subsequent calls.
 *
 * Contract:
 *   - UNKNOWN before confirmation → KNOWN after
 *   - Idempotent: same company + same canonicalName → reuses existing entity
 *   - Tenant-isolated: Company A's confirmation invisible to Company B
 *   - Conflict-safe: same alias on different entity → explicit error
 *   - AI proposal alone persists NOTHING — only explicit confirmation
 *
 * @returns The CompanyKnowledge record (newly created or existing)
 */
export async function confirmEntityIdentity(
  input: ConfirmEntityIdentityInput,
): Promise<CompanyKnowledgeRecord> {
  // 1. Validate inputs
  if (!input.companyId || typeof input.companyId !== 'string') {
    throw new Error('companyId is required');
  }
  if (!input.canonicalName || typeof input.canonicalName !== 'string') {
    throw new Error('canonicalName is required');
  }
  if (!input.observedAlias || typeof input.observedAlias !== 'string') {
    throw new Error('observedAlias is required');
  }

  // 2. Normalize for comparison
  const normalizedCanonical = normalizeForResolution(input.canonicalName);
  const normalizedAlias = normalizeForResolution(input.observedAlias);

  // G8-2 §8 (ORIGINAL §9): single interactive transaction, Company FOR
  // UPDATE first, every read/write/audit operates on the SAME tx.
  return db.$transaction(async (tx) => {
    // Company FOR UPDATE first — zero rows fails before any read/write.
    await acquireCompanyLock(
      tx as unknown as Prisma.TransactionClient,
      input.companyId,
    );

    // 3. Load all active entities for this company (inside the tx)
    const records = await tx.companyKnowledge.findMany({
      where: { companyId: input.companyId, status: 'active' },
    });

    // 4. Check for alias conflict: same alias already on a DIFFERENT entity
    for (const record of records) {
      const recordHasAlias = record.aliases.some(
        (a) => normalizeForResolution(a) === normalizedAlias,
      );
      if (recordHasAlias) {
        const recordCanonicalNorm = normalizeForResolution(record.canonicalName);
        if (recordCanonicalNorm !== normalizedCanonical) {
          throw new Error(
            `Alias conflict: "${input.observedAlias}" is already assigned to entity "${record.canonicalName}" (${record.id}). ` +
            `Cannot reassign to "${input.canonicalName}" without removing it first.`,
          );
        }
      }
    }

    // 5. Check if entity with same canonicalName already exists
    const existing = records.find(
      (r) => normalizeForResolution(r.canonicalName) === normalizedCanonical,
    );

    if (existing) {
      // Idempotent: alias already present → return existing
      const alreadyHasAlias = existing.aliases.some(
        (a) => normalizeForResolution(a) === normalizedAlias,
      );
      if (alreadyHasAlias) {
        return toCompanyKnowledgeRecord(existing);
      }

      // G8-2 §8 identity precheck BEFORE adding the alias — the resulting
      // identity set (self excluded) must stay disjoint from every other
      // active entity — canonical↔alias, alias↔canonical, alias↔alias.
      await assertIdentityDisjoint(tx as unknown as Prisma.TransactionClient, {
        companyId: input.companyId,
        canonicalName: existing.canonicalName,
        aliases: [...existing.aliases, input.observedAlias],
        excludeKnowledgeId: existing.id,
      });

      // Add alias to existing entity
      const updated = await tx.companyKnowledge.update({
        where: { id: existing.id },
        data: {
          aliases: [...existing.aliases, input.observedAlias],
        },
      });

      await appendAuditEntry({
        client: tx,
        knowledgeId: existing.id,
        action: 'add_alias',
        version: existing.version ?? 1,
        beforeValue: { aliases: existing.aliases },
        afterValue: { aliases: [...existing.aliases, input.observedAlias] },
        source: 'company_knowledge',
        reason: input.reason ?? `Alias "${input.observedAlias}" confirmed`,
      });

      return toCompanyKnowledgeRecord(updated);
    }

    // G8-2 §8 identity precheck for the NEW entity — before the create makes
    // that identity authoritative — canonical↔alias, alias↔canonical,
    // alias↔alias against every other active entity.
    await assertIdentityDisjoint(tx as unknown as Prisma.TransactionClient, {
      companyId: input.companyId,
      canonicalName: input.canonicalName,
      aliases: [input.observedAlias],
    });

    // 6. Create new entity
    const created = await tx.companyKnowledge.create({
      data: {
        companyId: input.companyId,
        type: toPrismaEntityType(input.entityType),
        canonicalName: input.canonicalName,
        aliases: [input.observedAlias],
        metadata: {},
        source: 'company_knowledge',
        status: 'active',
        version: 1,
      },
    });

    await appendAuditEntry({
      client: tx,
      knowledgeId: created.id,
      action: 'create',
      version: 1,
      beforeValue: null,
      afterValue: {
        companyId: created.companyId,
        type: created.type,
        canonicalName: created.canonicalName,
        aliases: [input.observedAlias],
      },
      source: 'company_knowledge',
      reason: input.reason ?? `Entity "${input.canonicalName}" confirmed from observation "${input.observedAlias}"`,
    });

    return toCompanyKnowledgeRecord(created);
  });
}
