/**
 * S11 — Legacy winner selection must be deterministic.
 *
 * Legacy mode (`RULE_ENGINE_V2_ENABLED` off, the default) ordered candidates by
 * `rolePriority → dbPriority → input order`. Two rules tying on both keys were
 * resolved by whichever happened to arrive first, so the same transaction could
 * classify differently depending on rule input order. The final tiebreak is now
 * `ruleId` ascending (ordinal), matching canonical-ranking.ts.
 *
 * DB-free: `@/lib/db` is mocked; only the pure winner selector runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    company: { findUnique: vi.fn().mockResolvedValue(null) },
    bankRule: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { evaluateWinningRule } from '@/lib/services/rule-matching-engine';
import type { MatchingRule, Transaction } from '@/lib/services/rule-matching-engine';

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

const TX: Transaction = { description: 'interes bancario', amount: -500 };

function legacyWinner(rules: MatchingRule[]): string | undefined {
  return evaluateWinningRule(rules, TX, 'company-1', {}, [])?.id;
}

describe('legacy winner selection — ruleId tiebreak (S11)', () => {
  beforeEach(() => {
    // Default engine mode: legacy (RULE_ENGINE_V2_ENABLED unset/false).
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'false');
    vi.stubEnv('RULE_ENGINE_ADAPTER_ENABLED', 'false');
  });

  it('equal-priority rules resolve to the lowest ruleId when listed in ascending order', () => {
    const rules = [
      matchingRule({ id: 'rule-a', priority: 5 }),
      matchingRule({ id: 'rule-b', priority: 5 }),
    ];
    expect(legacyWinner(rules)).toBe('rule-a');
  });

  it('equal-priority rules resolve to the lowest ruleId regardless of input order', () => {
    const rules = [
      matchingRule({ id: 'rule-b', priority: 5 }),
      matchingRule({ id: 'rule-a', priority: 5 }),
    ];
    expect(legacyWinner(rules)).toBe('rule-a');
  });

  it('is stable across repeated runs with shuffled input order', () => {
    const ruleA = matchingRule({ id: 'aaa-virtual', priority: 7 });
    const ruleB = matchingRule({ id: 'bbb-fisico', priority: 7 });
    const ruleC = matchingRule({ id: 'ccc-tarjeta', priority: 7 });

    const orders: MatchingRule[][] = [
      [ruleA, ruleB, ruleC],
      [ruleC, ruleB, ruleA],
      [ruleB, ruleC, ruleA],
      [ruleC, ruleA, ruleB],
    ];

    const winners = orders.map((order) => legacyWinner(order));
    expect(winners).toEqual([
      'aaa-virtual',
      'aaa-virtual',
      'aaa-virtual',
      'aaa-virtual',
    ]);
  });

  it('ordinal comparison is used, not numeric id ordering', () => {
    // 'rule-10' < 'rule-9' in ordinal (string) order — the documented ruleId tiebreak.
    const rules = [matchingRule({ id: 'rule-9', priority: 3 }), matchingRule({ id: 'rule-10', priority: 3 })];
    expect(legacyWinner(rules)).toBe('rule-10');
  });

  // ── PRESERVE: existing ordering keys still take precedence over ruleId ──
  it('lower dbPriority still wins over a lower ruleId', () => {
    const rules = [
      matchingRule({ id: 'aaa-first', priority: 5 }),
      matchingRule({ id: 'zzz-second', priority: 1 }),
    ];
    expect(legacyWinner(rules)).toBe('zzz-second');
  });
});
