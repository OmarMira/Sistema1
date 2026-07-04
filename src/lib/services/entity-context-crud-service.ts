import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import type { PaginatedResult, UpdateEntityInput, BulkDeleteInput, EntityContextWithGlAccount } from '@/lib/types/entity-context';

export async function listEntityContexts(
  companyId: string,
  page: number = 1,
  limit: number = 20,
  sortBy: string = 'createdAt',
  sortDir: 'asc' | 'desc' = 'desc',
  search?: string,
  role?: string,
): Promise<PaginatedResult<EntityContextWithGlAccount>> {
  const skip = (page - 1) * limit;
  const orderBy = { [sortBy]: sortDir };

  const where: Prisma.EntityContextWhereInput = { companyId };

  if (search && search.trim()) {
    where.pattern = {
      contains: search.trim(),
      mode: 'insensitive',
    };
  }

  if (role) {
    where.role = role;
  }

  const [data, total] = await Promise.all([
    db.entityContext.findMany({
      where,
      include: { glAccount: true },
      orderBy,
      skip,
      take: limit,
    }),
    db.entityContext.count({ where }),
  ]);

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function updateEntityContext(
  companyId: string,
  id: string,
  input: UpdateEntityInput,
): Promise<EntityContextWithGlAccount | null> {
  // Verify entity exists and belongs to company
  const existing = await db.entityContext.findFirst({
    where: { id, companyId },
  });

  if (!existing) {
    return null;
  }

  // If glAccountId is provided, verify it exists and is active in the same company
  if (input.glAccountId !== undefined && input.glAccountId !== null) {
    const glAccount = await db.glAccount.findFirst({
      where: { id: input.glAccountId, companyId, isActive: true },
    });
    if (!glAccount) {
      throw new Error('GL_ACCOUNT_NOT_FOUND');
    }
  }

  // Prepare roles JSON — preserve null/empty distinction from undefined
  const rolesJson = input.roles === undefined ? undefined
    : input.roles === null ? null
    : input.roles.length === 0 ? JSON.stringify([])
    : JSON.stringify(input.roles.map((r) => r.toUpperCase()));

  const updated = await db.entityContext.update({
    where: { id },
    data: {
      role: input.role?.toUpperCase(),
      glAccountId: input.glAccountId,
      roles: rolesJson,
      transactionDirection: input.transactionDirection ?? undefined,
    },
    include: { glAccount: true },
  });

  return updated;
}

export async function removeEntityContext(companyId: string, id: string): Promise<boolean> {
  const existing = await db.entityContext.findFirst({
    where: { id, companyId },
  });

  if (!existing) {
    return false;
  }

  // Nullify FK on linked bank rules before delete
  const linkedRules = await db.bankRule.findMany({
    where: { entityContextId: id },
    select: { id: true, name: true },
  });

  if (linkedRules.length > 0) {
    await db.bankRule.updateMany({
      where: { entityContextId: id },
      data: { entityContextId: null },
    });
  }

  await db.entityContext.delete({ where: { id } });

  // Audit log for affected rules
  if (linkedRules.length > 0) {
    await createAuditLogWithRetry({
      companyId,
      action: 'ENTITY_CONTEXT_DELETED',
      entity: 'EntityContext',
      entityId: id,
      details: JSON.stringify({
        affectedRuleIds: linkedRules.map((r) => r.id),
        affectedRuleNames: linkedRules.map((r) => r.name),
      }),
    });
  }

  return true;
}

export async function bulkRemoveEntityContexts(companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) {
    throw new Error('EMPTY_IDS');
  }

  // Nullify FK on all linked bank rules before bulk delete
  const affectedRules = await db.bankRule.findMany({
    where: { entityContextId: { in: ids }, companyId },
    select: { id: true, name: true },
  });

  if (affectedRules.length > 0) {
    await db.bankRule.updateMany({
      where: { entityContextId: { in: ids } },
      data: { entityContextId: null },
    });
  }

  // Only delete entities belonging to the company
  const result = await db.entityContext.deleteMany({
    where: {
      id: { in: ids },
      companyId,
    },
  });

  // Single audit event for all affected rules
  if (affectedRules.length > 0) {
    await createAuditLogWithRetry({
      companyId,
      action: 'ENTITY_CONTEXTS_BULK_DELETED',
      entity: 'EntityContext',
      details: JSON.stringify({
        deletedCount: result.count,
        affectedRuleIds: affectedRules.map((r) => r.id),
        affectedRuleNames: affectedRules.map((r) => r.name),
      }),
    });
  }

  return result.count;
}

