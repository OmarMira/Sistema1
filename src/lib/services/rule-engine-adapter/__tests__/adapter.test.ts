import { describe, it, expect } from 'vitest';
import { buildEngineRule } from '../index';
import type { PrismaBankRule } from '../types';

describe('rule-engine-adapter: buildEngineRule', () => {
  const baseRule = {
    id: 'rule-1',
    companyId: 'company-1',
    priority: 10,
    conditionType: 'amount_greater',
    conditionValue: '100',
    conditions: null,
    transactionDirection: 'any',
    glAccountId: 'gl-1',
    debitGlAccountId: null,
    creditGlAccountId: null,
    entityContextId: null,
    isManuallyEdited: false,
    intent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;

  it('maps isActive=true to lifecycleStatus=active', () => {
    const rule = { ...baseRule, isActive: true, conditionType: 'amount_greater', conditionValue: '100' };
    const result = buildEngineRule(rule);
    expect(result.lifecycleStatus).toBe('active');
    expect(result.isActive).toBe(true);
  });

  it('maps isActive=false to lifecycleStatus=archived', () => {
    const rule = { ...baseRule, isActive: false, conditionType: 'amount_greater', conditionValue: '100' };
    const result = buildEngineRule(rule);
    expect(result.lifecycleStatus).toBe('archived');
    expect(result.isActive).toBe(false);
  });

  it('maps conditions from Prisma Json to RuleCondition array', () => {
    const rule = {
      ...baseRule,
      isActive: true,
      conditions: [
        { field: 'amount', operator: 'amount_greater', value: 100 },
        { field: 'description', operator: 'contains', value: 'test' },
      ],
    } as any;
    const result = buildEngineRule(rule);
    expect(result.conditions).toHaveLength(2);
    expect(result.conditions[0].type).toBe('amount_gt');
    expect(result.conditions[1].type).toBe('description_contains');
  });

  it('falls back to legacy conditionType/conditionValue when conditions is null', () => {
    const rule = { ...baseRule, isActive: true, conditionType: 'amount_greater', conditionValue: '100', conditions: null };
    const result = buildEngineRule(rule);
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0].type).toBe('amount_gt');
    expect(result.conditions[0].value).toBe('100');
  });

  it('throws on normalization failure with no usable conditions', () => {
    const rule = { ...baseRule, isActive: true, conditions: null, conditionType: null, conditionValue: null };
    expect(() => buildEngineRule(rule)).toThrow();
  });
});
