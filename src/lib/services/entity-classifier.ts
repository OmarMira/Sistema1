import { db } from '@/lib/db';
import { loadConfig, clusterCandidates, extractComponents } from '@/lib/services/entity-detector';
import { saveContext } from '@/lib/services/entity-context-service';
import { normalizePattern } from '@/lib/services/pattern-normalizer';
import { normalize } from '@/lib/services/rule-engine-adapter/conditions-normalizer';
import { logger } from '@/lib/logger';
import type { EntityCandidate } from '@/lib/services/entity-detector';
import type { EntityContext } from '@prisma/client';
import type { TransactionIntent } from '@/lib/constants/transaction-intent';
import type { EntityRole } from '@/lib/constants/entity-roles';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';

export interface ClassifyEntityInput {
  companyId: string;
  pattern: string;
  role?: string | null;
  roles?: string[];
  glAccountCode?: string;
  source?: 'user' | 'ai';
  userId?: string;
  transactionDirection?: string | null;
  userDescription?: string | null;
  intent?: TransactionIntent | null;
  autoAssign?: boolean;
  createRule?: boolean;
}

/**
 * Infer transaction direction from historical transactions matching the pattern.
 * Queries up to 200 BankTransactions using pattern normalization for contains match.
 * Returns 'debit' if >80% are debits, 'credit' if >80% are credits, else 'any'.
 */
export async function computeDirectionProfile(
  companyId: string,
  pattern: string,
): Promise<'debit' | 'credit' | 'any'> {
  const transactions = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccount: { companyId } },
      description: { contains: normalizePattern(pattern), mode: 'insensitive' },
    },
    select: { amount: true },
    take: 200,
  });

  if (transactions.length === 0) return 'any';

  let debitCount = 0;
  let validCount = 0;
  for (const t of transactions) {
    const amount = Number(t.amount);
    if (Math.abs(amount) < 0.00001) continue;
    validCount++;
    if (amount < 0) debitCount++;
  }
  if (validCount === 0) return 'any';
  const debitPct = debitCount / validCount;
  const creditPct = 1 - debitPct;

  if (debitPct >= 0.8) return 'debit';
  if (creditPct >= 0.8) return 'credit';
  return 'any';
}

export function deriveRoleFromIntent(
  intent?: TransactionIntent | null,
  providedRole?: string | null,
): string {
  if (intent != null) {
    switch (intent) {
      case 'CUSTOMER_PAYMENT': return 'CLIENTE';
      case 'RENT_PAYMENT': return 'INQUILINO';
      case 'OWNER_CONTRIBUTION': return 'SOCIO';
      case 'LOAN_PAYMENT': return 'PRESTAMO';
      case 'OPERATING_EXPENSE':
      case 'TAX_PAYMENT': return 'GASTO_OPERATIVO';
      case 'OTHER':
      case 'TRANSFER':
      default: return 'OTRO';
    }
  }

  // No intent → preserve the provided role as-is, or fallback to OTRO
  return providedRole ?? 'OTRO';
}

/**
 * Auto-create or reactivate a BankRule linked to the given EntityContext.
 * Dedup logic compares entityContextId + intent + transactionDirection + conditions.
 */
export async function autoCreateRule(
  companyId: string,
  context: { id: string; pattern: string; glAccountId: string | null; conditions?: any[] },
  direction: 'debit' | 'credit' | 'any',
  intent?: TransactionIntent | null,
  tx?: any,
): Promise<{ warning?: string }> {
  if (!context.glAccountId) {
    return { warning: 'No GL account linked — rule not created' };
  }

  const client = tx || db;
  const normalizedPattern = normalizePattern(context.pattern);
  const newConditions = context.conditions ?? [];

  function conditionsSig(conds: unknown[]): string {
    if (conds.length === 0) return '[]';
    const normalizedConds = normalize(conds);
    const sorted = [...normalizedConds].sort((a, b) => {
      const byType = a.type.localeCompare(b.type);
      if (byType !== 0) return byType;
      const aVal = String(a.value);
      const bVal = String(b.value);
      if (aVal < bVal) return -1;
      if (aVal > bVal) return 1;
      if (a.range && b.range) return a.range[0] - b.range[0] || a.range[1] - b.range[1];
      if (a.range) return 1;
      if (b.range) return -1;
      return 0;
    });
    return JSON.stringify(sorted.map((c) => ({ type: c.type, value: c.value, range: c.range })));
  }

  const newSig = conditionsSig(newConditions);

  const existingRules = await client.bankRule.findMany({
    where: { entityContextId: context.id },
  });

  const existingMatch = existingRules.find((rule: any) => {
    const isSameIntent = rule.intent === (intent || null);
    const isSameDirection = rule.transactionDirection === direction;
    const isSameConditions = rule.conditions
      ? conditionsSig(rule.conditions as unknown[]) === newSig
      : newSig === '[]';
    return isSameIntent && isSameDirection && isSameConditions;
  });

  if (existingMatch) {
    if (existingMatch.isActive) {
      if (existingMatch.glAccountId !== context.glAccountId) {
        throw new Error('CONFLICT: Rule already exists with a different GL Account');
      }
      return {};
    }
    await client.bankRule.update({
      where: { id: existingMatch.id },
      data: {
        isActive: true,
        glAccountId: context.glAccountId,
        ...(direction === 'debit' ? { debitGlAccountId: context.glAccountId } : {}),
        ...(direction === 'credit' ? { creditGlAccountId: context.glAccountId } : {}),
      },
    });
    return {};
  }

  await client.bankRule.create({
    data: {
      companyId,
      name: `Auto: ${context.pattern}${intent ? ` (${intent})` : ''}`,
      conditionType: 'contains',
      conditionValue: normalizedPattern,
      conditions: newConditions.length > 0 ? newConditions : undefined,
      glAccountId: context.glAccountId,
      transactionDirection: direction,
      priority: 5,
      isActive: true,
      entityContextId: context.id,
      intent: intent ?? null,
      ...(direction === 'debit' ? { debitGlAccountId: context.glAccountId } : {}),
      ...(direction === 'credit' ? { creditGlAccountId: context.glAccountId } : {}),
    },
  });

  return {};
}

export async function classifyEntity(
  input: ClassifyEntityInput,
): Promise<{ context: EntityContext; warning?: string }> {
  const { companyId, pattern, role, roles, glAccountCode, source, userId, transactionDirection, userDescription, intent, autoAssign, createRule } = input;
  const decidedToCreate = createRule === true;
  const finalRole = role ?? 'OTRO';
  const finalRoles = roles?.length ? roles : undefined;
  const trimmedUserDescription = typeof userDescription === 'string' ? userDescription.trim() : userDescription;

  if ((intent === 'OTHER' || finalRole === 'OTRO') && !trimmedUserDescription) {
    throw new Error('userDescription is required when intent is OTHER or role is OTRO');
  }

  if (decidedToCreate && (!intent || !glAccountCode)) {
    throw new Error('Intent and GL account are required when createRule is true');
  }

  let glAccountId: string | null = null;
  if (glAccountCode) {
    const acc = await db.glAccount.findFirst({
      where: { companyId, code: glAccountCode, isActive: true },
    });
    if (acc) glAccountId = acc.id;
  }

  return db.$transaction(async (tx) => {
    const context = await saveContext({
      companyId,
      pattern,
      role: finalRole,
      roles: finalRoles,
      glAccountId,
      source: source ?? 'user',
      userId,
      ...(transactionDirection !== undefined ? { transactionDirection } : {}),
      ...(trimmedUserDescription != null ? { userDescription: trimmedUserDescription } : {}),
      ...(autoAssign ? { autoAssignedAt: new Date() } : {}),
    }, tx);

    const direction = await computeDirectionProfile(companyId, pattern);

    let warning: string | undefined;
    if (decidedToCreate || autoAssign) {
      if (intent && glAccountId) {
        const result = await autoCreateRule(companyId, { id: context.id, pattern, glAccountId }, direction, intent, tx);
        warning = result.warning;
      } else {
        warning = 'No rule created: intent or GL account not specified';
      }
    }

    logger.info('[ENTITY CLASSIFIED]', { companyId, pattern, role: finalRole, roles: finalRoles, warning });

    return { context, warning };
  });
}

export async function getEntityCandidates(companyId: string): Promise<EntityCandidate[]> {
  const bankAccounts = await db.bankAccount.findMany({
    where: { companyId, isActive: true },
    select: { id: true },
  });

  if (bankAccounts.length === 0) return [];

  const transactions = await db.bankTransaction.findMany({
    where: eligibleForClassificationWhere({
      statement: { bankAccountId: { in: bankAccounts.map((a) => a.id) } },
    }),
    select: { description: true, amount: true, date: true, id: true },
    take: 2000,
  });

  if (transactions.length === 0) return [];

  const config = loadConfig();
  const raw = transactions.map((t) => ({
    description: t.description,
    amount: t.amount,
    date: t.date instanceof Date ? t.date.toISOString() : String(t.date),
    id: t.id,
  }));

  const candidates = clusterCandidates(raw, config);

  const existingContexts = await db.entityContext.findMany({
    where: { companyId },
    include: { glAccount: { select: { code: true } } },
  });
  const contextByPattern = new Map(existingContexts.map((c) => [c.pattern.toLowerCase(), c]));

  const rules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    select: { conditionValue: true, conditions: true },
  });

  return candidates
    .map((c) => {
      const patternLower = c.canonicalName.toLowerCase();
      const ctx = contextByPattern.get(patternLower);

      if (ctx) return null;

      const hasRule = rules.some((rule) => {
        if (rule.conditionValue && String(rule.conditionValue).toLowerCase().includes(patternLower))
          return true;
        if (Array.isArray(rule.conditions)) {
          return (rule.conditions as Array<{ value: unknown }>).some((cond) =>
            String(cond.value).toLowerCase().includes(patternLower),
          );
        }
        return false;
      });

      if (hasRule) return null;

      c.hasContext = false;
      c.contextRole = '';
      c.suggestedAccountId = undefined;
      c.suggestedAccountCode = undefined;

      return c;
    })
    .filter((c): c is EntityCandidate => c !== null);
}

export async function getKnownSocioPatterns(companyId: string): Promise<string[]> {
  const contexts = await db.entityContext.findMany({
    where: { companyId },
    select: { pattern: true, role: true, roles: true },
  });

  const patterns: string[] = [];
  for (const ctx of contexts) {
    const roles: string[] = ctx.roles ? JSON.parse(ctx.roles) : [ctx.role];
    if (roles.includes('SOCIO')) {
      patterns.push(ctx.pattern.toLowerCase());
    }
  }
  return patterns;
}
