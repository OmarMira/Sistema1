import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '@/lib/logger';
import {
  toRulePrecedenceRule,
  compareRuleDecisions,
  isRulePrecedenceShadowEnabled,
  runShadowComparison,
  createEmptyShadowImportSummary,
  accumulateShadowSummary,
  persistShadowSummaryBestEffort,
  classifyDivergenceReason,
  createEmptyApplyAllShadowSummary,
  accumulateApplyAllShadowSummary,
  toPersistencePayload,
} from '@/lib/services/rule-precedence-shadow';
import type {
  DivergenceClassification,
  ShadowExecutionResult,
  ShadowExecutionSummary,
  ComparisonEvidence,
} from '@/lib/services/rule-precedence-shadow';
import type { RulePrecedenceRule, RulePrecedenceTransaction } from '@/lib/services/rule-precedence-engine';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: vi.fn(),
}));

const { createAuditLogWithRetry } = await import('@/lib/audit');

const DEFAULT_DATE = new Date('2026-07-16T12:00:00Z');

function rule(overrides: Partial<RulePrecedenceRule> & { id: string }): RulePrecedenceRule {
  return {
    conditions: undefined,
    conditionType: undefined,
    conditionValue: undefined,
    transactionDirection: null,
    priority: 10,
    glAccountId: null,
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
    ...overrides,
  };
}

function tx(overrides: Partial<RulePrecedenceTransaction> = {}): RulePrecedenceTransaction {
  return { id: 'tx-1', date: DEFAULT_DATE, description: 'APPLE.COM BILLING', amount: 150, ...overrides };
}

describe('toRulePrecedenceRule', () => {
  it('preserves all fields from source', () => {
    const source = {
      id: 'rule-1',
      conditions: [{ field: 'description', operator: 'contains', value: 'APPLE' }],
      conditionType: 'contains',
      conditionValue: 'APPLE',
      transactionDirection: 'debit',
      priority: 5,
      glAccountId: 'gl-1',
      debitGlAccountId: null,
      creditGlAccountId: 'gl-2',
      isActive: true,
    };

    const result = toRulePrecedenceRule(source);

    expect(result.id).toBe('rule-1');
    expect(result.conditions).toEqual([{ field: 'description', operator: 'contains', value: 'APPLE' }]);
    expect(result.conditionType).toBe('contains');
    expect(result.conditionValue).toBe('APPLE');
    expect(result.transactionDirection).toBe('debit');
    expect(result.priority).toBe(5);
    expect(result.glAccountId).toBe('gl-1');
    expect(result.debitGlAccountId).toBeNull();
    expect(result.creditGlAccountId).toBe('gl-2');
    expect(result.isActive).toBe(true);
  });

  it('does not mutate the source object', () => {
    const source = {
      id: 'rule-1',
      conditions: [{ field: 'description', operator: 'contains', value: 'APPLE' }],
      conditionType: 'contains',
      conditionValue: 'APPLE',
      transactionDirection: null,
      priority: 10,
      glAccountId: null,
      debitGlAccountId: null,
      creditGlAccountId: null,
      isActive: true,
    };

    const original = { ...source };
    toRulePrecedenceRule(source);

    expect(source).toEqual(original);
  });
});

describe('compareRuleDecisions', () => {
  it('SAME_WINNER — motor productivo y canónico coinciden', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = compareRuleDecisions(tx(), rules, 'r1');

    expect(result.comparison).toBe('SAME_WINNER');
    expect(result.productiveWinnerId).toBe('r1');
    expect(result.canonicalWinnerId).toBe('r1');
    expect(result.canonicalAmbiguous).toBe(false);
    expect(result.canonicalReason).toBe('WINNER');
  });

  it('BOTH_NO_MATCH — ningún motor encuentra match', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'GOOGLE' }),
    ];

    const result = compareRuleDecisions(tx(), rules, null);

    expect(result.comparison).toBe('BOTH_NO_MATCH');
    expect(result.productiveWinnerId).toBeNull();
    expect(result.canonicalWinnerId).toBeNull();
    expect(result.canonicalReason).toBe('NO_MATCH');
  });

  it('PRODUCTIVE_MATCH_CANONICAL_NO_MATCH — productivo gana, canónico no', () => {
    const rules: RulePrecedenceRule[] = [];

    const result = compareRuleDecisions(tx(), rules, 'r1');

    expect(result.comparison).toBe('PRODUCTIVE_MATCH_CANONICAL_NO_MATCH');
    expect(result.productiveWinnerId).toBe('r1');
    expect(result.canonicalWinnerId).toBeNull();
    expect(result.canonicalReason).toBe('NO_MATCH');
  });

  it('PRODUCTIVE_NO_MATCH_CANONICAL_MATCH — canónico gana, productivo no', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = compareRuleDecisions(tx(), rules, null);

    expect(result.comparison).toBe('PRODUCTIVE_NO_MATCH_CANONICAL_MATCH');
    expect(result.productiveWinnerId).toBeNull();
    expect(result.canonicalWinnerId).toBe('r1');
    expect(result.canonicalReason).toBe('WINNER');
  });

  it('DIFFERENT_WINNER — ambos ganan, reglas distintas', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = compareRuleDecisions(tx(), rules, 'legacy-rule');

    expect(result.comparison).toBe('DIFFERENT_WINNER');
    expect(result.productiveWinnerId).toBe('legacy-rule');
    expect(result.canonicalWinnerId).toBe('r1');
    expect(result.canonicalReason).toBe('WINNER');
  });

  it('CANONICAL_AMBIGUOUS — canónico empata dos reglas', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'equals', conditionValue: 'APPLE.COM BILLING', priority: 10 }),
      rule({ id: 'r2', conditionType: 'equals', conditionValue: 'APPLE.COM BILLING', priority: 10 }),
    ];

    const result = compareRuleDecisions(tx(), rules, null);

    expect(result.comparison).toBe('CANONICAL_AMBIGUOUS');
    expect(result.canonicalWinnerId).toBeNull();
    expect(result.canonicalAmbiguous).toBe(true);
    expect(result.canonicalReason).toBe('AMBIGUOUS');
  });
});

describe('isRulePrecedenceShadowEnabled', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.RULE_PRECEDENCE_SHADOW_ENABLED;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('returns true when env var is exactly "true"', () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true';
    expect(isRulePrecedenceShadowEnabled()).toBe(true);
  });

  it('returns false when env var is missing', () => {
    expect(isRulePrecedenceShadowEnabled()).toBe(false);
  });

  it('returns false when env var is "false"', () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'false';
    expect(isRulePrecedenceShadowEnabled()).toBe(false);
  });

  it('returns false when env var is any other value', () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = '1';
    expect(isRulePrecedenceShadowEnabled()).toBe(false);
  });
});

describe('runShadowComparison', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ShadowExecutionResult on divergence', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = runShadowComparison(tx(), rules, 'legacy-rule', { companyId: 'c1', transactionId: 'tx-1' });

    expect(result).toEqual({ ok: true, comparison: expect.objectContaining({ comparison: 'DIFFERENT_WINNER' }) });
    expect(logger.warn).toHaveBeenCalledWith(
      '[RULE SHADOW DIVERGENCE]',
      expect.objectContaining({ comparison: 'DIFFERENT_WINNER', companyId: 'c1' }),
    );
  });

  it('catches internal error and returns { ok: false }', () => {
    const badRule = rule({ id: 'r1' });
    Object.defineProperty(badRule, 'isActive', {
      get() { throw new Error('forced shadow failure'); },
    });

    const result = runShadowComparison(
      tx(),
      [badRule],
      null,
      { companyId: 'c1', transactionId: 'tx-1' },
    );

    expect(result).toEqual({ ok: false });
    expect(logger.error).toHaveBeenCalledWith(
      '[RULE SHADOW ERROR]',
      expect.objectContaining({
        companyId: 'c1',
        transactionId: 'tx-1',
      }),
    );
  });

  it('returns SAME_WINNER when both engines agree', () => {
    const rules = [
      rule({ id: 'r1', conditionType: 'contains', conditionValue: 'APPLE' }),
    ];

    const result = runShadowComparison(tx(), rules, 'r1', { companyId: 'c1', transactionId: 'tx-1' });

    expect(result).toEqual({ ok: true, comparison: expect.objectContaining({ comparison: 'SAME_WINNER' }) });
  });
});

// ─── S7-03: Shadow metrics ──────────────────────────────────

describe('createEmptyShadowImportSummary', () => {
  it('returns all counters at zero', () => {
    const s = createEmptyShadowImportSummary();
    expect(s).toEqual({
      totalEvaluated: 0,
      sameWinner: 0,
      bothNoMatch: 0,
      productiveMatchCanonicalNoMatch: 0,
      productiveNoMatchCanonicalMatch: 0,
      differentWinner: 0,
      canonicalAmbiguous: 0,
      shadowErrors: 0,
    });
  });
});

describe('accumulateShadowSummary', () => {
  it('increments sameWinner on SAME_WINNER', () => {
    const s = createEmptyShadowImportSummary();
    const r: ShadowExecutionResult = { ok: true, comparison: { comparison: 'SAME_WINNER', productiveWinnerId: null, canonicalWinnerId: null, canonicalAmbiguous: false, canonicalReason: 'WINNER' } };
    const result = accumulateShadowSummary(s, r);
    expect(result.sameWinner).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('increments bothNoMatch on BOTH_NO_MATCH', () => {
    const s = createEmptyShadowImportSummary();
    const r: ShadowExecutionResult = { ok: true, comparison: { comparison: 'BOTH_NO_MATCH', productiveWinnerId: null, canonicalWinnerId: null, canonicalAmbiguous: false, canonicalReason: 'NO_MATCH' } };
    const result = accumulateShadowSummary(s, r);
    expect(result.bothNoMatch).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('increments productiveMatchCanonicalNoMatch', () => {
    const s = createEmptyShadowImportSummary();
    const r: ShadowExecutionResult = { ok: true, comparison: { comparison: 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH', productiveWinnerId: 'r1', canonicalWinnerId: null, canonicalAmbiguous: false, canonicalReason: 'NO_MATCH' } };
    const result = accumulateShadowSummary(s, r);
    expect(result.productiveMatchCanonicalNoMatch).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('increments productiveNoMatchCanonicalMatch', () => {
    const s = createEmptyShadowImportSummary();
    const r: ShadowExecutionResult = { ok: true, comparison: { comparison: 'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH', productiveWinnerId: null, canonicalWinnerId: 'r1', canonicalAmbiguous: false, canonicalReason: 'WINNER' } };
    const result = accumulateShadowSummary(s, r);
    expect(result.productiveNoMatchCanonicalMatch).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('increments differentWinner on DIFFERENT_WINNER', () => {
    const s = createEmptyShadowImportSummary();
    const r: ShadowExecutionResult = { ok: true, comparison: { comparison: 'DIFFERENT_WINNER', productiveWinnerId: 'r1', canonicalWinnerId: 'r2', canonicalAmbiguous: false, canonicalReason: 'WINNER' } };
    const result = accumulateShadowSummary(s, r);
    expect(result.differentWinner).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('increments canonicalAmbiguous on CANONICAL_AMBIGUOUS', () => {
    const s = createEmptyShadowImportSummary();
    const r: ShadowExecutionResult = { ok: true, comparison: { comparison: 'CANONICAL_AMBIGUOUS', productiveWinnerId: null, canonicalWinnerId: null, canonicalAmbiguous: true, canonicalReason: 'AMBIGUOUS' } };
    const result = accumulateShadowSummary(s, r);
    expect(result.canonicalAmbiguous).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('increments totalEvaluated and shadowErrors on error', () => {
    const s = { ...createEmptyShadowImportSummary(), totalEvaluated: 5, sameWinner: 3, bothNoMatch: 2 };
    const r: ShadowExecutionResult = { ok: false };
    const result = accumulateShadowSummary(s, r);
    expect(result.totalEvaluated).toBe(6);
    expect(result.shadowErrors).toBe(1);
    expect(result.sameWinner).toBe(3);
    expect(result.bothNoMatch).toBe(2);
  });

  it('preserves invariant: totalEvaluated = sum of all functional counters + shadowErrors', () => {
    let s = createEmptyShadowImportSummary();
    const results: ShadowExecutionResult[] = [
      { ok: true, comparison: { comparison: 'SAME_WINNER', productiveWinnerId: 'r1', canonicalWinnerId: 'r1', canonicalAmbiguous: false, canonicalReason: 'WINNER' } },
      { ok: true, comparison: { comparison: 'BOTH_NO_MATCH', productiveWinnerId: null, canonicalWinnerId: null, canonicalAmbiguous: false, canonicalReason: 'NO_MATCH' } },
      { ok: true, comparison: { comparison: 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH', productiveWinnerId: 'r1', canonicalWinnerId: null, canonicalAmbiguous: false, canonicalReason: 'NO_MATCH' } },
      { ok: true, comparison: { comparison: 'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH', productiveWinnerId: null, canonicalWinnerId: 'r1', canonicalAmbiguous: false, canonicalReason: 'WINNER' } },
      { ok: true, comparison: { comparison: 'DIFFERENT_WINNER', productiveWinnerId: 'r1', canonicalWinnerId: 'r2', canonicalAmbiguous: false, canonicalReason: 'WINNER' } },
      { ok: true, comparison: { comparison: 'CANONICAL_AMBIGUOUS', productiveWinnerId: null, canonicalWinnerId: null, canonicalAmbiguous: true, canonicalReason: 'AMBIGUOUS' } },
      { ok: false },
    ];

    for (const r of results) {
      s = accumulateShadowSummary(s, r);
    }

    const functionalSum = s.sameWinner + s.bothNoMatch + s.productiveMatchCanonicalNoMatch
      + s.productiveNoMatchCanonicalMatch + s.differentWinner + s.canonicalAmbiguous;

    expect(s.totalEvaluated).toBe(7);
    expect(s.totalEvaluated).toBe(functionalSum + s.shadowErrors);
    expect(functionalSum).toBe(6);
    expect(s.shadowErrors).toBe(1);
  });
});

describe('persistShadowSummaryBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls createAuditLogWithRetry with correct params', async () => {
    const summary = createEmptyShadowImportSummary();

    await persistShadowSummaryBestEffort({
      companyId: 'c1',
      userId: 'u1',
      statementId: 's1',
      summary,
    });

    expect(createAuditLogWithRetry).toHaveBeenCalledWith({
      companyId: 'c1',
      userId: 'u1',
      action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
      entity: 'BankStatement',
      entityId: 's1',
      details: JSON.stringify(summary),
    });
  });

  it('calls createAuditLogWithRetry with undefined userId', async () => {
    const summary = createEmptyShadowImportSummary();

    await persistShadowSummaryBestEffort({
      companyId: 'c1',
      statementId: 's1',
      summary,
    });

    expect(createAuditLogWithRetry).toHaveBeenCalledWith({
      companyId: 'c1',
      userId: undefined,
      action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
      entity: 'BankStatement',
      entityId: 's1',
      details: JSON.stringify(summary),
    });
  });

  it('does not throw when createAuditLogWithRetry fails', async () => {
    vi.mocked(createAuditLogWithRetry).mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(
      persistShadowSummaryBestEffort({
        companyId: 'c1',
        statementId: 's1',
        summary: createEmptyShadowImportSummary(),
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      '[SHADOW SUMMARY PERSIST FAILED]',
      expect.objectContaining({ companyId: 'c1', entityId: 's1' }),
    );
  });
});

// ─── S7-04C: Apply All Shadow classification ──────────────

describe('classifyDivergenceReason', () => {
  it('SAME — ambos winners nulos', () => {
    const evidence: ComparisonEvidence = {
      productiveWinnerId: null,
      canonicalWinnerId: null,
      canonicalReason: 'NO_MATCH',
    };

    const result = classifyDivergenceReason(evidence);

    expect(result).toEqual<DivergenceClassification>({ comparison: 'SAME', reason: null });
  });

  it('SAME — mismo winner', () => {
    const evidence: ComparisonEvidence = {
      productiveWinnerId: 'r1',
      canonicalWinnerId: 'r1',
      canonicalReason: 'WINNER',
    };

    const result = classifyDivergenceReason(evidence);

    expect(result).toEqual<DivergenceClassification>({ comparison: 'SAME', reason: null });
  });

  it('DIFFERENT / NO_MATCH — productivo ganó, canónico no tiene candidatos', () => {
    const evidence: ComparisonEvidence = {
      productiveWinnerId: 'r1',
      canonicalWinnerId: null,
      canonicalReason: 'NO_MATCH',
    };

    const result = classifyDivergenceReason(evidence);

    expect(result).toEqual<DivergenceClassification>({ comparison: 'DIFFERENT', reason: 'NO_MATCH' });
  });

  it('DIFFERENT / AMBIGUOUS — canónico reporta ambigüedad', () => {
    const evidence: ComparisonEvidence = {
      productiveWinnerId: 'r1',
      canonicalWinnerId: null,
      canonicalReason: 'AMBIGUOUS',
    };

    const result = classifyDivergenceReason(evidence);

    expect(result).toEqual<DivergenceClassification>({ comparison: 'DIFFERENT', reason: 'AMBIGUOUS' });
  });

  it('DIFFERENT / OTHER — productivo nulo, canónico tiene winner', () => {
    const evidence: ComparisonEvidence = {
      productiveWinnerId: null,
      canonicalWinnerId: 'r1',
      canonicalReason: 'WINNER',
    };

    const result = classifyDivergenceReason(evidence);

    expect(result).toEqual<DivergenceClassification>({ comparison: 'DIFFERENT', reason: 'OTHER' });
  });

  it('DIFFERENT / UNDETERMINED — winners distintos sin otra evidencia', () => {
    const evidence: ComparisonEvidence = {
      productiveWinnerId: 'r1',
      canonicalWinnerId: 'r2',
      canonicalReason: 'WINNER',
    };

    const result = classifyDivergenceReason(evidence);

    expect(result).toEqual<DivergenceClassification>({ comparison: 'DIFFERENT', reason: 'UNDETERMINED' });
  });
});

describe('createEmptyApplyAllShadowSummary', () => {
  it('returns all counters at zero', () => {
    const s = createEmptyApplyAllShadowSummary();
    expect(s).toEqual<ShadowExecutionSummary>({
      totalEvaluated: 0,
      sameWinner: 0,
      bothNoMatch: 0,
      productiveMatchCanonicalNoMatch: 0,
      productiveNoMatchCanonicalMatch: 0,
      differentWinner: 0,
      canonicalAmbiguous: 0,
      shadowErrors: 0,
      divergenceReasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
    });
  });
});

describe('accumulateApplyAllShadowSummary', () => {
  it('increments sameWinner on SAME_WINNER', () => {
    const s = createEmptyApplyAllShadowSummary();
    const r: ShadowExecutionResult = {
      ok: true,
      comparison: {
        comparison: 'SAME_WINNER', productiveWinnerId: 'r1', canonicalWinnerId: 'r1',
        canonicalAmbiguous: false, canonicalReason: 'WINNER',
      },
    };
    const result = accumulateApplyAllShadowSummary(s, r, { comparison: 'SAME', reason: null });
    expect(result.sameWinner).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('increments differentWinner and divergenceReasons on DIFFERENT / UNDETERMINED', () => {
    const s = createEmptyApplyAllShadowSummary();
    const r: ShadowExecutionResult = {
      ok: true,
      comparison: {
        comparison: 'DIFFERENT_WINNER', productiveWinnerId: 'r1', canonicalWinnerId: 'r2',
        canonicalAmbiguous: false, canonicalReason: 'WINNER',
      },
    };
    const result = accumulateApplyAllShadowSummary(s, r, { comparison: 'DIFFERENT', reason: 'UNDETERMINED' });
    expect(result.differentWinner).toBe(1);
    expect(result.divergenceReasons.UNDETERMINED).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('increments shadowErrors and totalEvaluated on error', () => {
    const s = createEmptyApplyAllShadowSummary();
    const r: ShadowExecutionResult = { ok: false };
    const result = accumulateApplyAllShadowSummary(s, r);
    expect(result.shadowErrors).toBe(1);
    expect(result.totalEvaluated).toBe(1);
    expect(result.sameWinner).toBe(0);
  });

  it('multiple accumulations produce correct sums', () => {
    let s = createEmptyApplyAllShadowSummary();

    s = accumulateApplyAllShadowSummary(s, {
      ok: true, comparison: { comparison: 'SAME_WINNER', productiveWinnerId: 'r1', canonicalWinnerId: 'r1', canonicalAmbiguous: false, canonicalReason: 'WINNER' },
    }, { comparison: 'SAME', reason: null });

    s = accumulateApplyAllShadowSummary(s, {
      ok: true, comparison: { comparison: 'DIFFERENT_WINNER', productiveWinnerId: 'r1', canonicalWinnerId: 'r2', canonicalAmbiguous: false, canonicalReason: 'WINNER' },
    }, { comparison: 'DIFFERENT', reason: 'UNDETERMINED' });

    s = accumulateApplyAllShadowSummary(s, {
      ok: true, comparison: { comparison: 'CANONICAL_AMBIGUOUS', productiveWinnerId: 'r1', canonicalWinnerId: null, canonicalAmbiguous: true, canonicalReason: 'AMBIGUOUS' },
    }, { comparison: 'DIFFERENT', reason: 'AMBIGUOUS' });

    s = accumulateApplyAllShadowSummary(s, { ok: false });

    expect(s.totalEvaluated).toBe(4);
    expect(s.sameWinner).toBe(1);
    expect(s.differentWinner).toBe(1);
    expect(s.canonicalAmbiguous).toBe(1);
    expect(s.shadowErrors).toBe(1);
    expect(s.divergenceReasons.UNDETERMINED).toBe(1);
    expect(s.divergenceReasons.AMBIGUOUS).toBe(1);
  });

  it('bothNoMatch counter works correctly', () => {
    const s = createEmptyApplyAllShadowSummary();
    const r: ShadowExecutionResult = {
      ok: true,
      comparison: {
        comparison: 'BOTH_NO_MATCH', productiveWinnerId: null, canonicalWinnerId: null,
        canonicalAmbiguous: false, canonicalReason: 'NO_MATCH',
      },
    };
    const result = accumulateApplyAllShadowSummary(s, r, { comparison: 'SAME', reason: null });
    expect(result.bothNoMatch).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('productiveMatchCanonicalNoMatch counter works correctly', () => {
    const s = createEmptyApplyAllShadowSummary();
    const r: ShadowExecutionResult = {
      ok: true,
      comparison: {
        comparison: 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH', productiveWinnerId: 'r1', canonicalWinnerId: null,
        canonicalAmbiguous: false, canonicalReason: 'NO_MATCH',
      },
    };
    const result = accumulateApplyAllShadowSummary(s, r, { comparison: 'DIFFERENT', reason: 'NO_MATCH' });
    expect(result.productiveMatchCanonicalNoMatch).toBe(1);
    expect(result.divergenceReasons.NO_MATCH).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('productiveNoMatchCanonicalMatch counter works correctly', () => {
    const s = createEmptyApplyAllShadowSummary();
    const r: ShadowExecutionResult = {
      ok: true,
      comparison: {
        comparison: 'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH', productiveWinnerId: null, canonicalWinnerId: 'r1',
        canonicalAmbiguous: false, canonicalReason: 'WINNER',
      },
    };
    const result = accumulateApplyAllShadowSummary(s, r, { comparison: 'DIFFERENT', reason: 'OTHER' });
    expect(result.productiveNoMatchCanonicalMatch).toBe(1);
    expect(result.divergenceReasons.OTHER).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });

  it('classification is optional — omits divergenceReasons increment when absent', () => {
    const s = createEmptyApplyAllShadowSummary();
    const r: ShadowExecutionResult = {
      ok: true,
      comparison: {
        comparison: 'SAME_WINNER', productiveWinnerId: 'r1', canonicalWinnerId: 'r1',
        canonicalAmbiguous: false, canonicalReason: 'WINNER',
      },
    };
    const result = accumulateApplyAllShadowSummary(s, r);
    expect(result.sameWinner).toBe(1);
    expect(result.totalEvaluated).toBe(1);
  });
});

describe('toPersistencePayload', () => {
  it('transforms ShadowExecutionSummary to ShadowPersistencePayload', () => {
    const summary: ShadowExecutionSummary = {
      totalEvaluated: 100,
      sameWinner: 50,
      bothNoMatch: 20,
      productiveMatchCanonicalNoMatch: 5,
      productiveNoMatchCanonicalMatch: 3,
      differentWinner: 15,
      canonicalAmbiguous: 5,
      shadowErrors: 2,
      divergenceReasons: { NO_MATCH: 5, AMBIGUOUS: 5, UNDETERMINED: 10, OTHER: 3 },
    };

    const payload = toPersistencePayload(summary);

    expect(payload).toEqual({
      totalEvaluated: 100,
      sameWinner: 50,
      differentWinner: 15,
      shadowErrors: 2,
      divergenceReasons: { NO_MATCH: 5, AMBIGUOUS: 5, UNDETERMINED: 10, OTHER: 3 },
    });
  });

  it('does not mutate the original summary', () => {
    const summary: ShadowExecutionSummary = createEmptyApplyAllShadowSummary();
    const original = { ...summary, divergenceReasons: { ...summary.divergenceReasons } };
    toPersistencePayload(summary);
    expect(summary).toEqual(original);
  });
});
