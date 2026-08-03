import { describe, it, expect, vi } from 'vitest';

// Mock db so findMatchingRule tests don't need a real database connection
vi.mock('@/lib/db', () => ({
  db: {
    company: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { transactionMatchesRule, findMatchingRule, evaluateWinningRule } from '@/lib/services/rule-matching-engine';
import type { Transaction, Rule, MatchingRule } from '@/lib/services/rule-matching-engine';

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return { description: 'Zelle payment to John', amount: -150.0, ...overrides };
}

function v2Rule(conditions: any[], overrides: Partial<Rule> = {}): Rule {
  return { conditions, ...overrides };
}

function v1Rule(overrides: Partial<Rule> = {}): Rule {
  return {
    conditionType: 'contains',
    conditionValue: 'zelle',
    ...overrides,
  };
}

describe('transactionMatchesRule', () => {
  // ── Direction ──────────────────────────────────────────
  describe('direction filter', () => {
    it('returns false if direction=debit and amount >= 0', () => {
      expect(transactionMatchesRule(tx({ amount: 100 }), v1Rule({ transactionDirection: 'debit' }))).toBe(false);
    });

    it('returns false if direction=credit and amount < 0', () => {
      expect(transactionMatchesRule(tx({ amount: -50 }), v1Rule({ transactionDirection: 'credit' }))).toBe(false);
    });

    it('passes direction filter when direction matches', () => {
      expect(transactionMatchesRule(tx({ amount: -50 }), v1Rule({ transactionDirection: 'debit' }))).toBe(true);
      expect(transactionMatchesRule(tx({ amount: 100 }), v1Rule({ transactionDirection: 'credit' }))).toBe(true);
    });
  });

  // ── V2 conditions ──────────────────────────────────────
  describe('v2 conditions array (AND logic)', () => {
    it('matches all conditions with AND logic', () => {
      const r = v2Rule([
        { field: 'description', operator: 'contains', value: 'Zelle' },
        { field: 'amount', operator: 'greater_than', value: '100' },
      ]);
      expect(transactionMatchesRule(tx({ amount: -200 }), r)).toBe(true);
    });

    it('fails if ANY condition fails (AND)', () => {
      const r = v2Rule([
        { field: 'description', operator: 'contains', value: 'Zelle' },
        { field: 'amount', operator: 'greater_than', value: '200' },
      ]);
      expect(transactionMatchesRule(tx({ amount: -150 }), r)).toBe(false);
    });

    it('supports equals operator on description', () => {
      const r = v2Rule([{ field: 'description', operator: 'equals', value: 'zelle payment to john' }]);
      expect(transactionMatchesRule(tx(), r)).toBe(true);
      expect(transactionMatchesRule(tx({ description: 'Other' }), r)).toBe(false);
    });

    it('supports starts_with operator', () => {
      const r = v2Rule([{ field: 'description', operator: 'starts_with', value: 'Zelle' }]);
      expect(transactionMatchesRule(tx(), r)).toBe(true);
      expect(transactionMatchesRule(tx({ description: 'Payment via Zelle' }), r)).toBe(false);
    });

    it('supports ends_with operator', () => {
      const r = v2Rule([{ field: 'description', operator: 'ends_with', value: 'John' }]);
      expect(transactionMatchesRule(tx(), r)).toBe(true);
      expect(transactionMatchesRule(tx({ description: 'John payment' }), r)).toBe(false);
    });

    it('supports amount_greater and amount_less operators', () => {
      const tx150 = tx({ amount: -150 });
      expect(transactionMatchesRule(tx150, v2Rule([{ field: 'amount', operator: 'amount_greater', value: '100' }]))).toBe(true);
      expect(transactionMatchesRule(tx150, v2Rule([{ field: 'amount', operator: 'amount_greater', value: '200' }]))).toBe(false);
      expect(transactionMatchesRule(tx150, v2Rule([{ field: 'amount', operator: 'amount_less', value: '200' }]))).toBe(true);
      expect(transactionMatchesRule(tx150, v2Rule([{ field: 'amount', operator: 'amount_less', value: '100' }]))).toBe(false);
    });

    it('uses absolute value for amount comparisons', () => {
      expect(transactionMatchesRule(tx({ amount: -150 }), v2Rule([{ field: 'amount', operator: 'equals', value: '150' }]))).toBe(true);
      expect(transactionMatchesRule(tx({ amount: 150 }), v2Rule([{ field: 'amount', operator: 'equals', value: '150' }]))).toBe(true);
    });

    it('normalizes whitespace consistently', () => {
      const r = v2Rule([{ field: 'description', operator: 'contains', value: '  zelle   payment  ' }]);
      expect(transactionMatchesRule(tx({ description: 'Zelle   Payment   to   John' }), r)).toBe(true);
    });

    it('returns false for empty conditions array (falls through)', () => {
      expect(transactionMatchesRule(tx(), v2Rule([]))).toBe(false);
    });

    it('returns false for null/undefined conditions', () => {
      expect(transactionMatchesRule(tx(), v2Rule(null as any))).toBe(false);
    });
  });

  // ── V1 legacy ──────────────────────────────────────────
  describe('v1 legacy fields', () => {
    it('matches by description contains', () => {
      expect(transactionMatchesRule(tx(), v1Rule({ conditionType: 'contains', conditionValue: 'zelle' }))).toBe(true);
      expect(transactionMatchesRule(tx(), v1Rule({ conditionType: 'contains', conditionValue: 'paypal' }))).toBe(false);
    });

    it('matches by amount_greater', () => {
      const r = v1Rule({ conditionType: 'amount_greater', conditionValue: 100 });
      expect(transactionMatchesRule(tx({ amount: -200 }), r)).toBe(true);
      expect(transactionMatchesRule(tx({ amount: -50 }), r)).toBe(false);
    });

    it('matches by amount_less', () => {
      const r = v1Rule({ conditionType: 'amount_less', conditionValue: 200 });
      expect(transactionMatchesRule(tx({ amount: -150 }), r)).toBe(true);
      expect(transactionMatchesRule(tx({ amount: -300 }), r)).toBe(false);
    });

    it('matches by starts_with', () => {
      const r = v1Rule({ conditionType: 'starts_with', conditionValue: 'zelle' });
      expect(transactionMatchesRule(tx({ description: 'Zelle payment' }), r)).toBe(true);
    });

    it('matches by ends_with', () => {
      const r = v1Rule({ conditionType: 'ends_with', conditionValue: 'john' });
      expect(transactionMatchesRule(tx({ description: 'Payment to John' }), r)).toBe(true);
    });
  });

  // ── Edge cases ─────────────────────────────────────────
  describe('edge cases', () => {
    it('returns false when conditionValue is null/undefined', () => {
      const r = v1Rule({ conditionType: 'contains', conditionValue: null });
      expect(transactionMatchesRule(tx(), r)).toBe(false);
    });

    it('v2 takes precedence over v1 when both present', () => {
      const r = {
        conditionType: 'contains',
        conditionValue: 'paypal',
        conditions: [{ field: 'description', operator: 'contains', value: 'zelle' }],
      } as Rule;
      expect(transactionMatchesRule(tx(), r)).toBe(true);
    });

    it('skips rule with empty condition value after normalization', () => {
      const r = v2Rule([{ field: 'description', operator: 'contains', value: '' }]);
      expect(transactionMatchesRule(tx(), r)).toBe(false);
    });

    it('wildcard * matches any non-empty value', () => {
      const r = v2Rule([{ field: 'description', operator: 'contains', value: '*' }]);
      expect(transactionMatchesRule(tx({ description: 'anything' }), r)).toBe(true);
      // Should NOT match empty description (but our Transaction type requires a string, so skip that case)
    });
  });
});

// BRE-012 (D2): the Legacy winner cutover is gated behind the EXISTING
// RULE_ENGINE_V2_ENABLED flag. The canonical comparator tests below run with the
// flag ON; a dedicated describe exercises the flag OFF (Legacy preserved) path.
beforeEach(() => {
  vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── findMatchingRule ─────────────────────────────────────
function matchingRule(overrides: Partial<MatchingRule> = {}): MatchingRule {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    priority: 5,
    conditions: [{ field: 'description', operator: 'contains', value: 'interes' }],
    glAccountId: 'gl-001',
    ...overrides,
  };
}

describe('findMatchingRule', () => {
  it('matches with normalized whitespace and casing', async () => {
    const rules = [
      matchingRule({
        id: 'rule-1',
        conditions: [{ field: 'description', operator: 'contains', value: '  INTERES  ' }],
      }),
    ];
    const result = await findMatchingRule(
      { description: 'interes bancario', amount: -500 },
      rules,
      'company-1',
    );
    expect(result.matchedRuleId).toBe('rule-1');
    expect(result.glAccountId).toBe('gl-001');
  });

  it('higher priority rule wins over lower', async () => {
    const rules = [
      matchingRule({
        id: 'rule-low',
        priority: 99,
        glAccountId: 'gl-low',
        conditions: [{ field: 'description', operator: 'contains', value: 'interes' }],
      }),
      matchingRule({
        id: 'rule-high',
        priority: 1,
        glAccountId: 'gl-high',
        conditions: [{ field: 'description', operator: 'contains', value: 'interes' }],
      }),
    ];
    const result = await findMatchingRule(
      { description: 'interes bancario', amount: -500 },
      rules,
      'company-1',
    );
    expect(result.matchedRuleId).toBe('rule-high');
    expect(result.glAccountId).toBe('gl-high');
  });

  it('same priority — full semantic tie is AMBIGUOUS (BRE-012), not first-rule-wins', async () => {
    // BRE-012: two rules identical on every canonical key (tier, weight, quality,
    // priority) are semantically indistinguishable → AMBIGUOUS. The old
    // input-order stable-sort tiebreak is removed; ruleId never fabricates a winner.
    const rules = [
      matchingRule({
        id: 'rule-first',
        priority: 5,
        glAccountId: 'gl-first',
        conditions: [{ field: 'description', operator: 'contains', value: 'interes' }],
      }),
      matchingRule({
        id: 'rule-second',
        priority: 5,
        glAccountId: 'gl-second',
        conditions: [{ field: 'description', operator: 'contains', value: 'interes' }],
      }),
    ];
    const result = await findMatchingRule(
      { description: 'interes bancario', amount: -500 },
      rules,
      'company-1',
    );
    expect(result.matchedRuleId).toBeNull();
    expect(result.glAccountId).toBeNull();
  });

  it('wildcard * condition matches any non-empty value', async () => {
    const rules = [
      matchingRule({
        id: 'rule-wild',
        conditions: [{ field: 'description', operator: 'contains', value: '*' }],
      }),
    ];
    const result = await findMatchingRule(
      { description: 'anything here', amount: -100 },
      rules,
      'company-1',
    );
    expect(result.matchedRuleId).toBe('rule-wild');
  });

  it('returns null when no rule matches', async () => {
    const rules = [
      matchingRule({
        conditions: [{ field: 'description', operator: 'contains', value: 'nonexistent' }],
      }),
    ];
    const result = await findMatchingRule(
      { description: 'interes bancario', amount: -500 },
      rules,
      'company-1',
    );
    expect(result.matchedRuleId).toBeNull();
    expect(result.glAccountId).toBeNull();
  });

  it('skips rule with empty condition and falls through to no match', async () => {
    const rules = [
      matchingRule({
        id: 'rule-empty',
        conditions: [{ field: 'description', operator: 'contains', value: '' }],
      }),
    ];
    const result = await findMatchingRule(
      { description: 'interes bancario', amount: -500 },
      rules,
      'company-1',
    );
    expect(result.matchedRuleId).toBeNull();
  });
});

// ── evaluateWinningRule (BRE-012 canonical winner selection) ─────────────
describe('evaluateWinningRule', () => {
  it('single candidate wins directly', () => {
    const winner = evaluateWinningRule(
      [matchingRule({ id: 'only', priority: 5 })],
      { description: 'interes bancario', amount: -500 },
      'company-1',
      {},
      [],
    );
    expect(winner.id).toBe('only');
  });

  it('higher manual priority wins over lower (key 4, priority ASC)', () => {
    const winner = evaluateWinningRule(
      [
        matchingRule({ id: 'low', priority: 99, conditions: [{ field: 'description', operator: 'contains', value: 'interes' }] }),
        matchingRule({ id: 'high', priority: 1, conditions: [{ field: 'description', operator: 'contains', value: 'interes' }] }),
      ],
      { description: 'interes bancario', amount: -500 },
      'company-1',
      {},
      [],
    );
    expect(winner.id).toBe('high');
  });

  it('R-1 closure: tier-2 starts_with beats two tier-1 contains (BRE-012)', () => {
    // R-1 parity vector: R-B (description_starts_with, tier 2) vs R-A
    // (two description_contains, tier 1). Legacy must adopt the shared
    // tier-first canonical comparator and pick R-B, matching V2/Precedence.
    const winner = evaluateWinningRule(
      [
        matchingRule({
          id: 'R-A',
          priority: 10,
          conditions: [
            { field: 'description', operator: 'contains', value: 'mercado' },
            { field: 'description', operator: 'contains', value: 'pago' },
          ],
        }),
        matchingRule({
          id: 'R-B',
          priority: 10,
          conditions: [{ field: 'description', operator: 'starts_with', value: 'mercado' }],
        }),
      ],
      { description: 'mercado pago sa', amount: -100 },
      'company-1',
      {},
      [],
    );
    expect(winner.id).toBe('R-B');
  });

  it('full semantic tie (identical canonical keys) resolves to no winner (BRE-012)', () => {
    // Two rules differing only by ruleId tie on tier/weight/quality/priority:
    // classifyCanonical emits AMBIGUOUS, ruleId never fabricates a business winner.
    const winner = evaluateWinningRule(
      [
        matchingRule({ id: 'A', priority: 5, conditions: [{ field: 'description', operator: 'contains', value: 'interes' }] }),
        matchingRule({ id: 'B', priority: 5, conditions: [{ field: 'description', operator: 'contains', value: 'interes' }] }),
      ],
      { description: 'interes bancario', amount: -500 },
      'company-1',
      {},
      [],
    );
    expect(winner).toBeUndefined();
  });

  it('input order does not decide the winner (order-insensitive, BRE-012)', () => {
    const ruleA = matchingRule({ id: 'A', priority: 10, conditions: [{ field: 'description', operator: 'contains', value: 'mercado' }, { field: 'description', operator: 'contains', value: 'pago' }] });
    const ruleB = matchingRule({ id: 'B', priority: 10, conditions: [{ field: 'description', operator: 'starts_with', value: 'mercado' }] });
    const winner = evaluateWinningRule(
      [ruleB, ruleA],
      { description: 'mercado pago sa', amount: -100 },
      'company-1',
      {},
      [],
    );
    expect(winner.id).toBe('B');
  });
});

// ── BRE-012 D2: flag-gated Legacy cutover ─────────────────
// The Legacy winner-selection switch to the canonical comparator must be gated
// behind the existing RULE_ENGINE_V2_ENABLED flag (no new flag). These tests
// pin BOTH states: OFF (Legacy rolePriority → dbPriority → input order retained)
// and ON (canonical comparator decides).
describe('evaluateWinningRule — BRE-012 D2 flag gate (RULE_ENGINE_V2_ENABLED)', () => {
  // R-1 parity vector: R-A (two tier-1 contains) vs R-B (tier-2 starts_with).
  // Canonical tier-first picks R-B; Legacy input-order picks R-A.
  const r1Rules = (): MatchingRule[] => [
    matchingRule({
      id: 'R-A',
      priority: 10,
      conditions: [
        { field: 'description', operator: 'contains', value: 'mercado' },
        { field: 'description', operator: 'contains', value: 'pago' },
      ],
    }),
    matchingRule({
      id: 'R-B',
      priority: 10,
      conditions: [{ field: 'description', operator: 'starts_with', value: 'mercado' }],
    }),
  ];

  it('flag OFF keeps the previous Legacy winner (R-1 → R-A by input order)', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'false');
    const winner = evaluateWinningRule(
      r1Rules(),
      { description: 'mercado pago sa', amount: -100 },
      'company-1',
      {},
      [],
    );
    expect(winner?.id).toBe('R-A');
  });

  it('flag ON produces R-1 → R-B via the canonical comparator', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    const winner = evaluateWinningRule(
      r1Rules(),
      { description: 'mercado pago sa', amount: -100 },
      'company-1',
      {},
      [],
    );
    expect(winner?.id).toBe('R-B');
  });

  it('no new flag exists: Legacy preserves input order when RULE_ENGINE_V2_ENABLED is unset', () => {
    // The gate reads the pre-existing RULE_ENGINE_V2_ENABLED env key only; no
    // new flag is introduced. Unset behaves like OFF (Legacy path).
    delete process.env.RULE_ENGINE_V2_ENABLED;
    const winner = evaluateWinningRule(
      r1Rules(),
      { description: 'mercado pago sa', amount: -100 },
      'company-1',
      {},
      [],
    );
    expect(winner?.id).toBe('R-A');
  });

  it('AMBIGUOUS fail-safe applies only in the canonical (enabled) path', () => {
    const identical = () => [
      matchingRule({ id: 'A', priority: 5, conditions: [{ field: 'description', operator: 'contains', value: 'interes' }] }),
      matchingRule({ id: 'B', priority: 5, conditions: [{ field: 'description', operator: 'contains', value: 'interes' }] }),
    ];

    // ON: full semantic tie → AMBIGUOUS → no winner.
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    expect(
      evaluateWinningRule(identical(), { description: 'interes bancario', amount: -500 }, 'company-1', {}, []),
    ).toBeUndefined();

    // OFF: Legacy retains the input-order tiebreak → a winner always exists.
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'false');
    expect(
      evaluateWinningRule(identical(), { description: 'interes bancario', amount: -500 }, 'company-1', {}, [])?.id,
    ).toBe('A');
  });

  it('canonical path still emits AMBIGUOUS → undefined (flag ON) for full semantic tie', () => {
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
    const winner = evaluateWinningRule(
      [
        matchingRule({ id: 'A', priority: 5, conditions: [{ field: 'description', operator: 'contains', value: 'interes' }] }),
        matchingRule({ id: 'B', priority: 5, conditions: [{ field: 'description', operator: 'contains', value: 'interes' }] }),
      ],
      { description: 'interes bancario', amount: -500 },
      'company-1',
      {},
      [],
    );
    expect(winner).toBeUndefined();
  });
});
