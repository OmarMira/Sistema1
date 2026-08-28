import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEngineRule, runRuleEngineV2 } from '../index';
import type { PrismaBankRule } from '../types';

// Enable V2 engine for adapter tests
vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');

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

describe('runRuleEngineV2 — deterministic result transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseRule: PrismaBankRule = {
    id: 'rule-1',
    companyId: 'company-1',
    priority: 10,
    conditions: [{ field: 'description', operator: 'contains', value: 'NETFLIX' }],
    conditionType: null,
    conditionValue: null,
    transactionDirection: null,
    glAccountId: 'gl-1',
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  };

  const baseTxn = {
    id: 'tx-1',
    date: new Date('2026-01-15'),
    description: 'NETFLIX SUBSCRIPTION',
    amount: -15.99,
    bankAccountId: 'bank-1',
  };

  it('T8: NO_MATCH transports deterministicResult=no_match', async () => {
    const result = await runRuleEngineV2(
      { ...baseTxn, description: 'UNKNOWN TRANSACTION' },
      [baseRule],
      { status: 'not_run' },
      'company-1',
    );

    expect(result.outcome).toBe('pending');
    expect(result.deterministicResult).toBe('no_match');
  });

  it('T9: AMBIGUOUS transports deterministicResult=ambiguous', async () => {
    const rule2: PrismaBankRule = {
      ...baseRule,
      id: 'rule-2',
      glAccountId: 'gl-2',
    };

    const result = await runRuleEngineV2(
      baseTxn,
      [baseRule, rule2],
      { status: 'not_run' },
      'company-1',
    );

    expect(result.outcome).toBe('pending');
    expect(result.deterministicResult).toBe('ambiguous');
  });

  it('T10: NormalizationError does NOT produce deterministicResult or aiProposal', async () => {
    const invalidRule: PrismaBankRule = {
      ...baseRule,
      conditions: null,
      conditionType: null,
      conditionValue: null,
    };

    const result = await runRuleEngineV2(
      baseTxn,
      [invalidRule],
      { status: 'not_run' },
      'company-1',
    );

    expect(result.outcome).toBe('pending');
    expect(result.deterministicResult).toBeUndefined();
    expect(result.aiProposal).toBeUndefined();
    expect('errorCode' in result ? result.errorCode : undefined).toBe('conditions_normalization_failed');
  });
});
