import { db } from '@/lib/db';
import { entityContextSchema } from '@/lib/validations/entity-context';
import { normalizePattern } from '@/lib/services/pattern-normalizer';

type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * Strips common bank transaction prefixes from a pattern string.
 * This is caller-specific pre-processing — normalizes raw user-provided
 * patterns before canonical normalizePattern() is applied.
 */
function stripTransactionPrefixes(s: string): string {
  let cleaned = s.trim();
  // English patterns
  cleaned = cleaned.replace(/^(zelle\s+)?(payment|transfer|deposit|check|withdrawal)\s+(to|from)\s+/gi, '');
  cleaned = cleaned.replace(/^zelle\s+(to|from)\s+/gi, '');
  // Spanish patterns
  cleaned = cleaned.replace(/^(pago\s+)?zelle\s+(a|de)\s+/gi, '');
  cleaned = cleaned.replace(/^(transferencia|cheque|retiro|depósito)\s+(a|de)\s+/gi, '');
  // Bank metadata prefixes
  cleaned = cleaned.replace(/des:[\w\s.-]+id:[\w-]+(indn:)?/gi, '');
  cleaned = cleaned.replace(/indn:/gi, '');
  // Common email/phone descriptors
  cleaned = cleaned.replace(/\s+conf#\s*[\w\d]+/gi, '');
  cleaned = cleaned.replace(/\s+for\s+"[^"]+"/g, '');
  return cleaned.trim();
}

export async function findContext(companyId: string, description: string) {
  const normalized = normalizePattern(stripTransactionPrefixes(description));
  const contexts = await db.entityContext.findMany({
    where: { companyId },
    include: { glAccount: true },
  });
  return contexts.find((ctx) => normalized.includes(ctx.pattern.toLowerCase())) || null;
}

export async function saveContext(data: {
  companyId: string;
  pattern: string;
  role: string;
  roles?: string[];
  glAccountId?: string | null;
  source?: 'user' | 'ai';
  userId?: string;
  transactionDirection?: string | null;
  userDescription?: string | null;
  autoAssignedAt?: Date | null;
}, tx?: TxClient) {
  const client = tx || db;
  const normalized = normalizePattern(stripTransactionPrefixes(data.pattern));
  const validated = entityContextSchema.parse({
    companyId: data.companyId,
    pattern: normalized,
    role: data.role.toUpperCase(),
    glAccountId: data.glAccountId,
    transactionDirection: data.transactionDirection,
  });

  const rolesJson = data.roles?.length
    ? JSON.stringify(data.roles.map((r) => r.toUpperCase()))
    : null;
  const trimmedUserDescription = typeof data.userDescription === 'string'
    ? data.userDescription.trim()
    : data.userDescription;

  const context = await client.entityContext.upsert({
    where: {
      companyId_pattern: {
        companyId: validated.companyId,
        pattern: validated.pattern,
      },
    },
    update: {
      role: validated.role,
      roles: rolesJson,
      glAccountId: validated.glAccountId,
      source: data.source ?? 'user',
      transactionDirection: validated.transactionDirection ?? null,
      userDescription: trimmedUserDescription ?? null,
      ...(data.autoAssignedAt !== undefined ? { autoAssignedAt: data.autoAssignedAt } : {}),
    },
    create: {
      companyId: validated.companyId,
      pattern: validated.pattern,
      role: validated.role,
      roles: rolesJson,
      glAccountId: validated.glAccountId,
      source: data.source ?? 'user',
      transactionDirection: validated.transactionDirection ?? null,
      userDescription: trimmedUserDescription ?? null,
      ...(data.autoAssignedAt !== undefined ? { autoAssignedAt: data.autoAssignedAt } : {}),
    },
  });

  // Log in AuditLog if userId is provided
  if (data.userId) {
    await client.auditLog.create({
      data: {
        companyId: data.companyId,
        userId: data.userId,
        action: 'ENTITY_CONTEXT_ASSIGNED',
        entity: 'EntityContext',
        entityId: context.id,
        details: JSON.stringify({
          pattern: validated.pattern,
          role: validated.role,
          roles: data.roles,
          glAccountId: validated.glAccountId,
          source: data.source ?? 'user',
          userDescription: trimmedUserDescription ?? null,
          autoAssignedAt: data.autoAssignedAt ?? null,
        }),
      },
    });
  }

  return context;
}
