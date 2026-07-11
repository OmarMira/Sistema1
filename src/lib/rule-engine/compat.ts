import type { BankRule as PrismaBankRule } from '@prisma/client';
import type { BankRule, RuleCondition, RuleConditionType, RuleLifecycleStatus } from './types';

const LEGACY_TO_NEW_TYPE: Record<string, RuleConditionType> = {
  contains: 'description_contains',
  equals: 'amount_eq',
  starts_with: 'description_matches',
  ends_with: 'description_matches',
  amount_greater: 'amount_lt',
  amount_less: 'amount_lt',
};

const ENGINE_VERSION = '2.0.0';

function legacyConditionTypeToNew(legacyType: string): RuleConditionType {
  return LEGACY_TO_NEW_TYPE[legacyType] ?? 'description_contains';
}

function mapLifecycleStatus(isActive: boolean): RuleLifecycleStatus {
  return isActive ? 'active' : 'deprecated';
}

function buildCondition(
  legacyType: string,
  legacyValue: string | number | null,
): RuleCondition | null {
  if (legacyValue === null || legacyValue === undefined) return null;

  const type = legacyConditionTypeToNew(legacyType);

  if (type === 'amount_range') {
    return { type, value: legacyValue };
  }

  if (type === 'description_matches') {
    const escaped = String(legacyValue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern =
      legacyType === 'starts_with'
        ? `^${escaped}`
        : legacyType === 'ends_with'
          ? `${escaped}$`
          : escaped;
    return { type, value: pattern };
  }

  return { type, value: legacyValue };
}

export function adaptLegacyRule(prismaRule: PrismaBankRule): BankRule {
  const conditions: RuleCondition[] = [];

  if (Array.isArray(prismaRule.conditions) && prismaRule.conditions.length > 0) {
    for (const c of prismaRule.conditions as Record<string, unknown>[]) {
      const cond = buildCondition(
        String(c.operator ?? c.type ?? 'contains'),
        (c.value as string | number) ?? null,
      );
      if (cond) conditions.push(cond);
    }
  } else if (prismaRule.conditionType && prismaRule.conditionValue !== null) {
    const cond = buildCondition(prismaRule.conditionType, prismaRule.conditionValue);
    if (cond) conditions.push(cond);
  }

  return {
    id: prismaRule.id,
    companyId: prismaRule.companyId,
    priority: prismaRule.priority,
    conditions,
    action: {
      glAccountId: prismaRule.glAccountId ?? prismaRule.debitGlAccountId ?? undefined,
      entityId: prismaRule.entityContextId ?? undefined,
    },
    isActive: prismaRule.isActive,
    lifecycleStatus: mapLifecycleStatus(prismaRule.isActive),
  };
}

export function getEngineVersion(): string {
  return ENGINE_VERSION;
}

export const COMPAT_NOTES = {
  UNMAPPED_CONDITIONS: ['amount_greater', 'amount_less'] as const,
  UNMAPPED_NOTE:
    'amount_greater/amount_less map to amount_lt (less than) in the new model. Direction semantics differ: legacy uses absolute values, new engine uses raw amount. Validate with real data.',
  LIFECYCLE_NOTE:
    'Legacy has only isActive boolean. All isActive=true map to "active", isActive=false map to "deprecated". No draft/testing/archived states exist in legacy data.',
  PRIORITY_NOTE:
    'Legacy priority defaults to 10. New engine uses priority only as tie-break after specificity and match quality. Legacy rules with all equal priority will behave as priority=10.',
} as const;
