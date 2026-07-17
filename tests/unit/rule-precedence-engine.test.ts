import { describe, it, expect } from 'vitest';
import {
  evaluateTransactionAgainstRules,
  type RulePrecedenceRule,
  type RulePrecedenceTransaction,
} from '@/lib/services/rule-precedence-engine';

// ─── Helpers ─────────────────────────────────────────────────────────────

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

function amountRange(conditions: unknown[], direction?: string) {
  return rule({
    id: 'range-rule',
    conditions,
    transactionDirection: direction ?? null,
    priority: 10,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('rulePrecedenceEngine', () => {
  // 1. Exacta gana a contains
  it('description_eq beats description_contains', () => {
    const tx: RulePrecedenceTransaction = { description: 'APPLE.COM BILLING', amount: 150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'contains',
        conditionType: 'contains',
        conditionValue: 'APPLE',
      }),
      rule({
        id: 'exact',
        conditionType: 'equals',
        conditionValue: 'APPLE.COM BILLING',
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('WINNER');
    expect(result.winner?.ruleId).toBe('exact');
    expect(result.winner?.specificityScore).toBeGreaterThan(
      result.candidates.find((c) => c.ruleId === 'contains')!.specificityScore,
    );
  });

  // 2. starts_with gana a contains
  it('description_starts_with beats description_contains', () => {
    const tx: RulePrecedenceTransaction = { description: 'APPLE.COM BILLING', amount: 150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'contains',
        conditionType: 'contains',
        conditionValue: 'APPLE',
      }),
      rule({
        id: 'starts-with',
        conditionType: 'starts_with',
        conditionValue: 'APPLE',
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('WINNER');
    expect(result.winner?.ruleId).toBe('starts-with');
  });

  // 3. Monto exacto gana a rango
  it('amount_eq beats amount_range', () => {
    const tx: RulePrecedenceTransaction = { description: 'TX', amount: 150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      amountRange([{ type: 'amount_range', value: '', range: [100, 200] }]),
      rule({
        id: 'exact-amount',
        conditions: [{ field: 'amount', operator: 'equals', value: 150 }],
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('WINNER');
    expect(result.winner?.ruleId).toBe('exact-amount');
  });

  // 4. Dirección definida vs any
  it('defined direction adds specificity over any', () => {
    const tx: RulePrecedenceTransaction = { description: 'TX', amount: -150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'any-dir',
        conditionType: 'contains',
        conditionValue: 'TX',
        transactionDirection: 'any',
      }),
      rule({
        id: 'debit-dir',
        conditionType: 'contains',
        conditionValue: 'TX',
        transactionDirection: 'debit',
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('WINNER');
    expect(result.winner?.ruleId).toBe('debit-dir');
  });

  // 5. Multi-condición suma especificidad
  it('multiple conditions accumulate specificity', () => {
    const tx: RulePrecedenceTransaction = { description: 'APPLE.COM BILLING', amount: -150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'single',
        conditionType: 'contains',
        conditionValue: 'APPLE',
        transactionDirection: 'debit',
      }),
      rule({
        id: 'multi',
        conditions: [
          { field: 'description', operator: 'contains', value: 'APPLE' },
          { field: 'amount', operator: 'amount_less', value: 200 },
        ],
        transactionDirection: 'debit',
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('WINNER');
    expect(result.winner?.ruleId).toBe('multi');
  });

  // 6. Misma especificidad → match quality
  it('higher match quality wins when specificity is tied', () => {
    const tx: RulePrecedenceTransaction = { description: 'APPLE.COM BILLING', amount: 150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'short',
        conditionType: 'contains',
        conditionValue: 'APPLE',
      }),
      rule({
        id: 'long',
        conditionType: 'contains',
        conditionValue: 'APPLE.COM BILLING',
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('WINNER');
    expect(result.winner?.ruleId).toBe('long');
  });

  // 7. Misma calidad → prioridad
  it('lower priority wins when specificity and quality are tied', () => {
    const tx: RulePrecedenceTransaction = { description: 'APPLE.COM BILLING', amount: 150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'high-prio',
        conditionType: 'contains',
        conditionValue: 'APPLE',
        priority: 5,
      }),
      rule({
        id: 'low-prio',
        conditionType: 'contains',
        conditionValue: 'APPLE',
        priority: 1,
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('WINNER');
    expect(result.winner?.ruleId).toBe('low-prio');
  });

  // 8. Empate total → ambiguous (ruleId only orders candidates)
  it('total tie results in ambiguous with ruleId ordering', () => {
    const tx: RulePrecedenceTransaction = { description: 'APPLE.COM', amount: 150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'B',
        conditionType: 'contains',
        conditionValue: 'APPLE',
        priority: 10,
      }),
      rule({
        id: 'A',
        conditionType: 'contains',
        conditionValue: 'APPLE',
        priority: 10,
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('AMBIGUOUS');
    expect(result.winner).toBeUndefined();
    expect(result.candidates[0].ruleId).toBe('A');
    expect(result.candidates[1].ruleId).toBe('B');
  });

  // 9. Ambigüedad detectada
  it('marks ambiguous when specificity + quality + priority are the same', () => {
    const tx: RulePrecedenceTransaction = { description: 'APPLE.COM BILLING', amount: 150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'rule-1',
        conditionType: 'contains',
        conditionValue: 'APPLE',
        priority: 10,
      }),
      rule({
        id: 'rule-2',
        conditionType: 'contains',
        conditionValue: 'APPLE',
        priority: 10,
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('AMBIGUOUS');
    expect(result.winner).toBeUndefined();
    expect(result.ambiguous).toBe(true);
  });

  // 10. Legacy y JSON equivalentes
  it('legacy V1 and V2 conditions produce the same result', () => {
    const tx: RulePrecedenceTransaction = { description: 'APPLE.COM BILLING', amount: 150, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'legacy',
        conditionType: 'contains',
        conditionValue: 'APPLE',
      }),
      rule({
        id: 'v2-array',
        conditions: [{ field: 'description', operator: 'contains', value: 'APPLE' }],
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('AMBIGUOUS');
    const legacy = result.candidates.find((c) => c.ruleId === 'legacy')!;
    const v2 = result.candidates.find((c) => c.ruleId === 'v2-array')!;
    expect(legacy.specificityScore).toBe(v2.specificityScore);
    expect(legacy.matchQuality).toBe(v2.matchQuality);
  });

  // 11. Orden de entrada no cambia el resultado
  it('input order does not affect the winner', () => {
    const tx: RulePrecedenceTransaction = { description: 'SAME PATTERN', amount: 100, date: DEFAULT_DATE };
    const inputRules: RulePrecedenceRule[] = [
      rule({ id: 'low', conditionType: 'contains', conditionValue: 'SAME', priority: 5 }),
      rule({ id: 'high', conditionType: 'contains', conditionValue: 'SAME', priority: 1 }),
    ];

    const result1 = evaluateTransactionAgainstRules(tx, inputRules);
    const result2 = evaluateTransactionAgainstRules(tx, [...inputRules].reverse());

    expect(result1.winner?.ruleId).toBe(result2.winner?.ruleId);
    expect(result1.winner?.ruleId).toBe('high');
  });

  // 12. Ninguna regla coincide
  it('returns NO_MATCH when no rule matches', () => {
    const tx: RulePrecedenceTransaction = { description: 'UNKNOWN VENDOR', amount: 50, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'no-match',
        conditionType: 'contains',
        conditionValue: 'NONEXISTENT',
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);

    expect(result.reason).toBe('NO_MATCH');
    expect(result.winner).toBeUndefined();
    expect(result.candidates).toHaveLength(0);
    expect(result.ambiguous).toBe(false);
  });

  // ── Text Normalization Compatibility Tests ─────────────────────

  describe('text normalization compatibility', () => {
    it('is case-insensitive for description_eq', () => {
      const tx: RulePrecedenceTransaction = { description: 'APPLE STORE', amount: 100, date: DEFAULT_DATE };
      const rules = [rule({ id: 'eq-rule', conditionType: 'equals', conditionValue: 'apple store' })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });

    it('ignores leading/trailing whitespaces and collapses spaces', () => {
      const tx: RulePrecedenceTransaction = { description: '  APPLE    STORE  ', amount: 100, date: DEFAULT_DATE };
      const rules = [rule({ id: 'eq-rule', conditionType: 'equals', conditionValue: 'apple store' })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });

    it('matches with normalized text on contains', () => {
      const tx: RulePrecedenceTransaction = { description: '  PAYPAL    TRANSFER  ', amount: 100, date: DEFAULT_DATE };
      const rules = [rule({ id: 'cont-rule', conditionType: 'contains', conditionValue: 'paypal transfer' })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });
  });

  // ── Absolute vs Signed Amount Compatibility Tests ──────────────

  describe('absolute vs signed amount compatibility', () => {
    it('debit negative matches absolute amount equality', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: -150, date: DEFAULT_DATE };
      const rules = [rule({ id: 'eq-rule', conditions: [{ field: 'amount', operator: 'equals', value: '150' }] })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });

    it('debit negative matches absolute amount greater than', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: -150, date: DEFAULT_DATE };
      const rules = [rule({ id: 'gt-rule', conditionType: 'greater_than', conditionValue: '100' })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });

    it('debit negative matches absolute amount less than', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: -50, date: DEFAULT_DATE };
      const rules = [rule({ id: 'lt-rule', conditionType: 'less_than', conditionValue: '100' })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });

    it('debit negative does not match amount_less 0 (absolute magnitude edge case)', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: -50, date: DEFAULT_DATE };
      const rules = [rule({ id: 'lt-zero', conditionType: 'less_than', conditionValue: '0' })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('NO_MATCH');
    });

    it('debit negative matches absolute amount range', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: -150, date: DEFAULT_DATE };
      const rules = [amountRange([{ type: 'amount_range', value: '', range: [100, 200] }])];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });

    it('direction and absolute amount are separate', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: -150, date: DEFAULT_DATE };
      const rules = [
        rule({
          id: 'debit-rule',
          conditionType: 'greater_than',
          conditionValue: '100',
          transactionDirection: 'debit',
        }),
      ];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });
  });

  // ── amount_range formula tests ─────────────────────────────────

  describe('amount_range formula', () => {
    it('center of range gets highest score', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 150, date: DEFAULT_DATE };
      const rules = [amountRange([{ type: 'amount_range', value: '', range: [100, 200] }])];

      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
      expect(result.winner?.matchQuality).toBe(1);
    });

    it('edge of range gets lower score than center', () => {
      const txEdge: RulePrecedenceTransaction = { description: 'TX', amount: 100, date: DEFAULT_DATE };
      const txCenter: RulePrecedenceTransaction = { description: 'TX', amount: 150, date: DEFAULT_DATE };
      const rules = [amountRange([{ type: 'amount_range', value: '', range: [100, 200] }])];

      const edgeResult = evaluateTransactionAgainstRules(txEdge, rules);
      const centerResult = evaluateTransactionAgainstRules(txCenter, rules);

      expect(centerResult.winner?.matchQuality).toBeGreaterThan(edgeResult.winner?.matchQuality ?? 0);
    });

    it('returns 0 for amount outside the range', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 300, date: DEFAULT_DATE };
      const rules = [amountRange([{ type: 'amount_range', value: '', range: [100, 200] }])];

      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('NO_MATCH');
    });

    it('handles inverted range (max < min)', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 150, date: DEFAULT_DATE };
      const rules = [amountRange([{ type: 'amount_range', value: '', range: [200, 100] }])];

      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
      expect(result.winner?.matchQuality).toBeGreaterThan(0);
    });

    it('handles zero-width range (degenerate)', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 150, date: DEFAULT_DATE };
      const rules = [amountRange([{ type: 'amount_range', value: '', range: [150, 150] }])];

      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
      expect(result.winner?.matchQuality).toBe(1);
    });

    it('handles zero-width range that does not match', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 151, date: DEFAULT_DATE };
      const rules = [amountRange([{ type: 'amount_range', value: '', range: [150, 150] }])];

      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('NO_MATCH');
    });
  });

  // ── Date Evaluator Tests ───────────────────────────────────────

  describe('date evaluator compatibility', () => {
    it('matches correctly with date_before', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 100, date: new Date('2026-07-01') };
      const rules = [rule({ id: 'before', conditions: [{ type: 'date_before', value: '2026-07-15' }] })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });

    it('fails when date is not before', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 100, date: new Date('2026-07-20') };
      const rules = [rule({ id: 'before', conditions: [{ type: 'date_before', value: '2026-07-15' }] })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('NO_MATCH');
    });

    it('matches correctly with date_after', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 100, date: new Date('2026-07-20') };
      const rules = [rule({ id: 'after', conditions: [{ type: 'date_after', value: '2026-07-15' }] })];
      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('WINNER');
    });
  });

  // ── Direction filtering ───────────────────────────────────────

  describe('direction pre-filter', () => {
    it('debit rule only matches negative amounts', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: 100, date: DEFAULT_DATE };
      const rules: RulePrecedenceRule[] = [
        rule({
          id: 'debit-rule',
          conditionType: 'contains',
          conditionValue: 'TX',
          transactionDirection: 'debit',
        }),
      ];

      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('NO_MATCH');
    });

    it('credit rule only matches non-negative amounts', () => {
      const tx: RulePrecedenceTransaction = { description: 'TX', amount: -50, date: DEFAULT_DATE };
      const rules: RulePrecedenceRule[] = [
        rule({
          id: 'credit-rule',
          conditionType: 'contains',
          conditionValue: 'TX',
          transactionDirection: 'credit',
        }),
      ];

      const result = evaluateTransactionAgainstRules(tx, rules);
      expect(result.reason).toBe('NO_MATCH');
    });

    it('any direction matches both signs', () => {
      const txNeg: RulePrecedenceTransaction = { description: 'TX', amount: -50, date: DEFAULT_DATE };
      const txPos: RulePrecedenceTransaction = { description: 'TX', amount: 100, date: DEFAULT_DATE };
      const rules: RulePrecedenceRule[] = [
        rule({
          id: 'any-rule',
          conditionType: 'contains',
          conditionValue: 'TX',
          transactionDirection: 'any',
        }),
      ];

      expect(evaluateTransactionAgainstRules(txNeg, rules).reason).toBe('WINNER');
      expect(evaluateTransactionAgainstRules(txPos, rules).reason).toBe('WINNER');
    });
  });

  // ── Inactive rules ────────────────────────────────────────────

  it('inactive rules are ignored', () => {
    const tx: RulePrecedenceTransaction = { description: 'MATCH', amount: 100, date: DEFAULT_DATE };
    const rules: RulePrecedenceRule[] = [
      rule({
        id: 'inactive',
        conditionType: 'contains',
        conditionValue: 'MATCH',
        isActive: false,
      }),
    ];

    const result = evaluateTransactionAgainstRules(tx, rules);
    expect(result.reason).toBe('NO_MATCH');
  });
});
