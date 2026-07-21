import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { evaluateOperationalPolicy } from '@/lib/operational-policy/policy-service';
import { OBSERVATIONAL_POLICY_PROFILE } from '@/lib/operational-policy/observational-policy-profile';
import type { OperationalPolicyInput, OperationalPolicyProfile, OperationalPolicyAction } from '@/lib/operational-policy/types';
import type { ReadinessCriteria, ShadowMetricsProvider, CanonicalReadiness } from '@/lib/services/canonical-readiness-service';
import type { ShadowMetricsQuery } from '@/lib/services/shadow-metrics-reader';

const mockEvaluateCanonicalReadiness = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/canonical-readiness-service', () => ({
  evaluateCanonicalReadiness: mockEvaluateCanonicalReadiness,
}));

function fakeQuery(): ShadowMetricsQuery {
  return {
    companyId: 'c1',
    source: 'ALL',
    from: new Date('2025-01-01'),
    to: new Date('2025-02-01'),
    trustPolicy: 'INCLUDE_LEGACY_IMPORT',
  };
}

function fakeCriteria(): ReadinessCriteria {
  return {
    sample: { minimumEvaluatedTransactions: 100, minimumBatches: 3 },
    quality: { minimumAgreementRate: 0.95, maximumDivergenceRate: 0.05, maximumAmbiguityRate: 0.02 },
    integrity: { maximumErrorRate: 0.01, maximumInvalidRecordRate: 0.05 },
  };
}

function fakeInput(context: 'APPLY_ALL' | 'IMPORT' | 'RECONCILIATION' = 'APPLY_ALL'): OperationalPolicyInput {
  return { context, metricsQuery: fakeQuery() };
}

function makeReadiness(status: CanonicalReadiness['status']): CanonicalReadiness {
  const base = {
    metrics: { batches: 10, totalEvaluated: 200, validComparisons: 195, sameDecision: 190, divergentDecision: 3, ambiguous: 2, errors: 0, agreementRate: 0.974, divergenceRate: 0.015, ambiguityRate: 0.01, errorRate: 0, trustedBatches: 10, legacyBatches: 0, legacyUntrustedBatches: 0, invalidRecords: 0, reasons: { NO_MATCH: 1, AMBIGUOUS: 2, UNDETERMINED: 0, OTHER: 0 } },
    checks: [
      { code: 'MINIMUM_EVALUATED_TRANSACTIONS' as const, operator: '>=' as const, passed: true, actual: 200, expected: 100 },
      { code: 'MINIMUM_BATCHES' as const, operator: '>=' as const, passed: true, actual: 10, expected: 3 },
    ],
  };
  if (status === 'READY') {
    return { ...base, status: 'READY' as const };
  }
  if (status === 'NOT_READY') {
    return { ...base, status: 'NOT_READY' as const, failedChecks: [] };
  }
  return { ...base, status: 'INSUFFICIENT_DATA' as const, reasons: ['MINIMUM_BATCHES: expected >= 3, got 1'] };
}

function nullProvider(): ShadowMetricsProvider {
  return { read: vi.fn() };
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

describe('validation errors — frozen error codes', () => {
  const input = fakeInput();
  const criteria = fakeCriteria();
  const profile = OBSERVATIONAL_POLICY_PROFILE;
  const provider = nullProvider();

  beforeEach(() => {
    mockEvaluateCanonicalReadiness.mockReset();
  });

  it('POLICY_INPUT_REQUIRED when input is null', async () => {
    await expect(evaluateOperationalPolicy(null as unknown as OperationalPolicyInput, criteria, provider, profile))
      .rejects.toThrowError();
    try {
      await evaluateOperationalPolicy(null as unknown as OperationalPolicyInput, criteria, provider, profile);
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_INPUT_REQUIRED');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_INPUT_REQUIRED when input is undefined', async () => {
    try {
      await evaluateOperationalPolicy(undefined as unknown as OperationalPolicyInput, criteria, provider, profile);
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_INPUT_REQUIRED');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_CRITERIA_REQUIRED when criteria is null', async () => {
    try {
      await evaluateOperationalPolicy(input, null as unknown as ReadinessCriteria, provider, profile);
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_CRITERIA_REQUIRED');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_PROFILE_REQUIRED when profile is null', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, null as unknown as OperationalPolicyProfile);
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_PROFILE_REQUIRED');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_PROFILE_ID_REQUIRED when profile.id is empty', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, { ...profile, id: '' });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_PROFILE_ID_REQUIRED');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_VERSION_REQUIRED when profile.version is empty', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, { ...profile, version: '' });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_VERSION_REQUIRED');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_UNKNOWN_DEFAULT_ACTION when defaultAction is invalid', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, { ...profile, defaultAction: 'INVALID' as OperationalPolicyAction });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_UNKNOWN_DEFAULT_ACTION');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_UNKNOWN_CONTEXT when input.context is invalid', async () => {
    try {
      await evaluateOperationalPolicy({ ...input, context: 'INVALID' as 'APPLY_ALL' }, criteria, provider, profile);
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_UNKNOWN_CONTEXT');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_RULES_NOT_ARRAY when rules is not an array', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, { ...profile, rules: null as unknown as [] });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_RULES_NOT_ARRAY');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_RULE_INVALID_FIELD when rule has unknown context', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, {
        ...profile,
        rules: [{ ...profile.rules[0], context: 'INVALID' as 'APPLY_ALL' }],
      });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_RULE_INVALID_FIELD');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_RULE_INVALID_FIELD when rule has unknown readinessStatus', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, {
        ...profile,
        rules: [{ ...profile.rules[0], readinessStatus: 'INVALID' as 'READY' }],
      });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_RULE_INVALID_FIELD');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_RULE_INVALID_FIELD when rule has unknown action', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, {
        ...profile,
        rules: [{ ...profile.rules[0], action: 'INVALID' as 'ALLOW' }],
      });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_RULE_INVALID_FIELD');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_RULE_INVALID_FIELD when rule has empty reasonCode', async () => {
    try {
      await evaluateOperationalPolicy(input, criteria, provider, {
        ...profile,
        rules: [{ ...profile.rules[0], reasonCode: '' }],
      });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_RULE_INVALID_FIELD');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('POLICY_CONTEXT_RULES_REQUIRED when no rules match context', async () => {
    const inputApplyAll = fakeInput('APPLY_ALL');
    const profileWithImportOnly = {
      ...profile,
      rules: profile.rules.filter(r => r.context === 'IMPORT'),
    };
    try {
      await evaluateOperationalPolicy(inputApplyAll, criteria, provider, profileWithImportOnly);
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('POLICY_CONTEXT_RULES_REQUIRED');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('DUPLICATE_RULE_ID when two rules share the same id', async () => {
    const rules = [
      profile.rules[0],
      { ...profile.rules[1], id: profile.rules[0].id },
    ];
    try {
      await evaluateOperationalPolicy(input, criteria, provider, { ...profile, rules });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('DUPLICATE_RULE_ID');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('DUPLICATE_RULE_CONTENT when two rules are semantically identical', async () => {
    const rules = [
      profile.rules[0],
      { ...profile.rules[0], id: 'different-id' },
    ];
    try {
      await evaluateOperationalPolicy(input, criteria, provider, { ...profile, rules });
    } catch (e: unknown) {
      expect((e as { code: string }).code).toBe('DUPLICATE_RULE_CONTENT');
    }
    expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
  });

  it('same context + readinessStatus but different actions is VALID', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('NOT_READY'));
    const rules = [
      profile.rules[0],
      { ...profile.rules[0], id: 'apply-all-not-ready-block', action: 'BLOCK' as const, reasonCode: 'BLOCK_REASON' },
    ];
    const decision = await evaluateOperationalPolicy(input, criteria, provider, { ...profile, rules });
    expect(decision.action).toBe('BLOCK');
    expect(mockEvaluateCanonicalReadiness).toHaveBeenCalledTimes(1);
  });
});

describe('provider short-circuit', () => {
  it('provider called 0 times on any validation error', async () => {
    const provider = { read: vi.fn() };
    const input = fakeInput();
    const criteria = fakeCriteria();

    const testCases: Array<{ name: string; call: () => Promise<unknown> }> = [
      { name: 'null input', call: () => evaluateOperationalPolicy(null as unknown as OperationalPolicyInput, criteria, provider, OBSERVATIONAL_POLICY_PROFILE) },
      { name: 'null profile', call: () => evaluateOperationalPolicy(input, criteria, provider, null as unknown as OperationalPolicyProfile) },
      { name: 'empty id', call: () => evaluateOperationalPolicy(input, criteria, provider, { ...OBSERVATIONAL_POLICY_PROFILE, id: '' }) },
    ];

    for (const tc of testCases) {
      mockEvaluateCanonicalReadiness.mockClear();
      provider.read.mockClear();
      try {
        await tc.call();
      } catch {
        // expected
      }
      expect(mockEvaluateCanonicalReadiness).not.toHaveBeenCalled();
      expect(provider.read).not.toHaveBeenCalled();
    }
  });
});

describe('precedence', () => {
  beforeEach(() => {
    mockEvaluateCanonicalReadiness.mockReset();
  });

  it('WARN + BLOCK → BLOCK wins', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('NOT_READY'));
    const rules = [
      OBSERVATIONAL_POLICY_PROFILE.rules[0],
      { ...OBSERVATIONAL_POLICY_PROFILE.rules[0], id: 'apply-all-not-ready-block', action: 'BLOCK' as const, reasonCode: 'BLOCK_REASON' },
    ];
    const decision = await evaluateOperationalPolicy(fakeInput(), fakeCriteria(), nullProvider(), { ...OBSERVATIONAL_POLICY_PROFILE, rules });
    expect(decision.action).toBe('BLOCK');
    expect(decision.reasons.reasonCode).toBe('BLOCK_REASON');
  });

  it('ALLOW + CONFIRM → CONFIRM wins', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('NOT_READY'));
    const rules = [
      { ...OBSERVATIONAL_POLICY_PROFILE.rules[0], action: 'ALLOW' as const, reasonCode: 'ALLOW_REASON' },
      { ...OBSERVATIONAL_POLICY_PROFILE.rules[0], id: 'apply-all-not-ready-confirm', action: 'CONFIRM' as const, reasonCode: 'CONFIRM_REASON' },
    ];
    const decision = await evaluateOperationalPolicy(fakeInput(), fakeCriteria(), nullProvider(), { ...OBSERVATIONAL_POLICY_PROFILE, rules });
    expect(decision.action).toBe('CONFIRM');
    expect(decision.reasons.reasonCode).toBe('CONFIRM_REASON');
  });

  it('same rules in different orders produce same result', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('NOT_READY'));
    const ruleA = { ...OBSERVATIONAL_POLICY_PROFILE.rules[0], action: 'ALLOW' as const, reasonCode: 'ALLOW_REASON' };
    const ruleB = { ...OBSERVATIONAL_POLICY_PROFILE.rules[0], id: 'apply-all-not-ready-block', action: 'BLOCK' as const, reasonCode: 'BLOCK_REASON' };

    const d1 = await evaluateOperationalPolicy(fakeInput(), fakeCriteria(), nullProvider(), { ...OBSERVATIONAL_POLICY_PROFILE, rules: [ruleA, ruleB] });
    const d2 = await evaluateOperationalPolicy(fakeInput(), fakeCriteria(), nullProvider(), { ...OBSERVATIONAL_POLICY_PROFILE, rules: [ruleB, ruleA] });

    expect(d1.action).toBe(d2.action);
    expect(d1.reasons.reasonCode).toBe(d2.reasons.reasonCode);

    const getMatchedActions = (d: typeof d1) => d.rules.filter(r => r.matched).map(r => r.action).sort();
    expect(getMatchedActions(d1)).toEqual(getMatchedActions(d2));
  });

  it('all matched rules appear in ruleResults (not just winner)', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('NOT_READY'));
    const rules = [
      OBSERVATIONAL_POLICY_PROFILE.rules[0],
      { ...OBSERVATIONAL_POLICY_PROFILE.rules[0], id: 'apply-all-not-ready-warn2', action: 'WARN' as const, reasonCode: 'ANOTHER_WARN' },
    ];
    const decision = await evaluateOperationalPolicy(fakeInput(), fakeCriteria(), nullProvider(), { ...OBSERVATIONAL_POLICY_PROFILE, rules });
    const matched = decision.rules.filter(r => r.matched);
    expect(matched).toHaveLength(2);
  });
});

describe('default action', () => {
  beforeEach(() => {
    mockEvaluateCanonicalReadiness.mockReset();
  });

  it('uses defaultAction when no rules match readiness.status', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('READY'));
    const decision = await evaluateOperationalPolicy(fakeInput('RECONCILIATION'), fakeCriteria(), nullProvider(), OBSERVATIONAL_POLICY_PROFILE);
    expect(decision.action).toBe('ALLOW');
    expect(decision.reasons.reasonCode).toBe('DEFAULT_ACTION');
  });
});

describe('single invocation of evaluateCanonicalReadiness', () => {
  beforeEach(() => {
    mockEvaluateCanonicalReadiness.mockReset();
  });

  it('calls evaluateCanonicalReadiness exactly once with correct args', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('READY'));
    const input = fakeInput();
    const criteria = fakeCriteria();
    const provider = nullProvider();

    await evaluateOperationalPolicy(input, criteria, provider, OBSERVATIONAL_POLICY_PROFILE);

    expect(mockEvaluateCanonicalReadiness).toHaveBeenCalledTimes(1);
    expect(mockEvaluateCanonicalReadiness).toHaveBeenCalledWith(input.metricsQuery, criteria, provider);
  });
});

describe('input immutability', () => {
  beforeEach(() => {
    mockEvaluateCanonicalReadiness.mockReset();
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('READY'));
  });

  it('input.metricsQuery is never mutated', async () => {
    const input = fakeInput();
    const criteria = fakeCriteria();
    const snapshot = {
      companyId: input.metricsQuery.companyId,
      source: input.metricsQuery.source,
      trustPolicy: input.metricsQuery.trustPolicy,
      from: input.metricsQuery.from.getTime(),
      to: input.metricsQuery.to.getTime(),
    };

    await evaluateOperationalPolicy(input, criteria, nullProvider(), OBSERVATIONAL_POLICY_PROFILE);
    expect(input.metricsQuery.companyId).toBe(snapshot.companyId);
    expect(input.metricsQuery.source).toBe(snapshot.source);
    expect(input.metricsQuery.trustPolicy).toBe(snapshot.trustPolicy);
    expect(input.metricsQuery.from.getTime()).toBe(snapshot.from);
    expect(input.metricsQuery.to.getTime()).toBe(snapshot.to);
  });

  it('criteria is never mutated', async () => {
    const input = fakeInput();
    const criteria = fakeCriteria();
    const snapshot = deepClone(criteria);

    await evaluateOperationalPolicy(input, criteria, nullProvider(), OBSERVATIONAL_POLICY_PROFILE);
    expect(criteria).toEqual(snapshot);
  });

  it('profile is never mutated', async () => {
    const input = fakeInput();
    const criteria = fakeCriteria();
    const profile = deepClone(OBSERVATIONAL_POLICY_PROFILE);

    await evaluateOperationalPolicy(input, criteria, nullProvider(), profile);
    expect(profile).toEqual(OBSERVATIONAL_POLICY_PROFILE);
  });
});

describe('OBSERVATIONAL_POLICY_PROFILE freeze', () => {
  it('has exactly 6 rules', () => {
    expect(OBSERVATIONAL_POLICY_PROFILE.rules).toHaveLength(6);
  });

  it('each rule has exact expected properties', () => {
    const expectedRules = [
      { id: 'apply-all-not-ready', context: 'APPLY_ALL' as const, readinessStatus: 'NOT_READY' as const, action: 'WARN' as const, reasonCode: 'READINESS_NOT_MET' },
      { id: 'apply-all-insufficient', context: 'APPLY_ALL' as const, readinessStatus: 'INSUFFICIENT_DATA' as const, action: 'WARN' as const, reasonCode: 'INSUFFICIENT_SAMPLE' },
      { id: 'import-not-ready', context: 'IMPORT' as const, readinessStatus: 'NOT_READY' as const, action: 'WARN' as const, reasonCode: 'DIVERGENCE_HIGH' },
      { id: 'import-insufficient', context: 'IMPORT' as const, readinessStatus: 'INSUFFICIENT_DATA' as const, action: 'ALLOW' as const, reasonCode: 'INSUFFICIENT_SAMPLE' },
      { id: 'reconciliation-not-ready', context: 'RECONCILIATION' as const, readinessStatus: 'NOT_READY' as const, action: 'WARN' as const, reasonCode: 'DIVERGENCE_HIGH' },
      { id: 'reconciliation-insufficient', context: 'RECONCILIATION' as const, readinessStatus: 'INSUFFICIENT_DATA' as const, action: 'ALLOW' as const, reasonCode: 'INSUFFICIENT_SAMPLE' },
    ];

    for (let i = 0; i < 6; i++) {
      expect(OBSERVATIONAL_POLICY_PROFILE.rules[i].id).toBe(expectedRules[i].id);
      expect(OBSERVATIONAL_POLICY_PROFILE.rules[i].context).toBe(expectedRules[i].context);
      expect(OBSERVATIONAL_POLICY_PROFILE.rules[i].readinessStatus).toBe(expectedRules[i].readinessStatus);
      expect(OBSERVATIONAL_POLICY_PROFILE.rules[i].action).toBe(expectedRules[i].action);
      expect(OBSERVATIONAL_POLICY_PROFILE.rules[i].reasonCode).toBe(expectedRules[i].reasonCode);
    }
  });

  it('defaultAction is ALLOW', () => {
    expect(OBSERVATIONAL_POLICY_PROFILE.defaultAction).toBe('ALLOW');
  });

  it('id and version are frozen', () => {
    expect(OBSERVATIONAL_POLICY_PROFILE.id).toBe('observational-policy-v1');
    expect(OBSERVATIONAL_POLICY_PROFILE.version).toBe('1.0.0');
  });
});

describe('reasonCode provenance', () => {
  beforeEach(() => {
    mockEvaluateCanonicalReadiness.mockReset();
  });

  it('reasonCode comes from matched rule when one matches', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('NOT_READY'));
    const decision = await evaluateOperationalPolicy(fakeInput('APPLY_ALL'), fakeCriteria(), nullProvider(), OBSERVATIONAL_POLICY_PROFILE);
    expect(decision.reasons.reasonCode).toBe('READINESS_NOT_MET');
  });

  it('reasonCode is DEFAULT_ACTION when no rule matches', async () => {
    mockEvaluateCanonicalReadiness.mockResolvedValue(makeReadiness('READY'));
    const decision = await evaluateOperationalPolicy(fakeInput('RECONCILIATION'), fakeCriteria(), nullProvider(), OBSERVATIONAL_POLICY_PROFILE);
    expect(decision.reasons.reasonCode).toBe('DEFAULT_ACTION');
  });
});
