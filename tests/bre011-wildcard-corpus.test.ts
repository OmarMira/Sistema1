import { describe, it, expect } from 'vitest';
import {
  transactionMatchesRule,
  evaluateWinningRule,
  type MatchingRule,
} from '@/lib/services/rule-matching-engine';
import {
  evaluateTransactionAgainstRules,
  type RulePrecedenceRule,
  type RulePrecedenceTransaction,
} from '@/lib/services/rule-precedence-engine';
import { compareRuleDecisions, type ShadowComparison } from '@/lib/services/rule-precedence-shadow';
import {
  runRuleEngineV2Shadow,
  type ParsedTransaction,
  type PrismaBankRule,
} from '@/lib/services/rule-engine-adapter';
import {
  classifyDivergence,
  type DivergenceType,
  type V2EngineResult,
  type PrecedenceEngineResult,
} from '@/lib/rule-engine/events';
import type { EntityResolution, RuleCondition } from '@/lib/rule-engine/types';
import type { RuleCondition as SharedRuleCondition } from '@/lib/types/shared';
import { STRING_CANARY, NUMERIC_CANARY, FIXED_DATE } from '../scripts/bre010-scrub-policy.mjs';

const SYNTHETIC_GL = 'gl-synthetic-001';
const NOT_RUN_RESOLUTION: EntityResolution = { status: 'not_run' };
const DEAD_LABEL: DivergenceType = 'V2_PENDING_PRECEDENCE_MATCH';

const SHADOW_CODES: readonly ShadowComparison[] = [
  'SAME_WINNER',
  'BOTH_NO_MATCH',
  'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH',
  'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH',
  'DIFFERENT_WINNER',
  'CANONICAL_AMBIGUOUS',
];

const DIVERGENCE_CODES: readonly DivergenceType[] = [
  'SAME',
  'DIFFERENT_WINNER',
  'V2_MATCH_PRECEDENCE_NO_MATCH',
  'V2_NO_MATCH_PRECEDENCE_MATCH',
  'V2_ERROR',
];

type Direction = 'any' | 'debit' | 'credit';
type RepresentationOrigin = 'json' | 'legacy' | 'both';
type RuleKind = 'real' | 'control' | 'trap';

interface FixtureRule {
  id: string;
  name: string;
  companyId: string;
  priority: number;
  transactionDirection: Direction;
  representationOrigin: RepresentationOrigin;
  ruleKind: RuleKind;
  conditions: RuleCondition[];
  legacyView:
    | { kind: 'reverseMap'; items: SharedRuleCondition[] }
    | { kind: 'passthrough'; conditionType: string; conditionValue: string };
  v2View: { kind: 'canonical'; conditions: RuleCondition[] } | { kind: 'stored'; conditions: null };
}

interface CorpusCase {
  caseId: string;
  representation: string;
  rule: FixtureRule;
  probe: { description: string; amount: number };
}

function jsonOriginRule(
  id: string,
  canonical: RuleCondition[],
  legacyView: FixtureRule['legacyView'],
): FixtureRule {
  return {
    id,
    name: `rule-${id}`,
    companyId: 'company-scrubbed-1',
    priority: 10,
    transactionDirection: 'any',
    representationOrigin: 'json',
    ruleKind: 'control',
    conditions: canonical,
    legacyView,
    v2View: { kind: 'canonical', conditions: canonical },
  };
}

function buildCorpus(): CorpusCase[] {
  const contains = [{ type: 'description_contains', value: '*' } as RuleCondition];
  const equals = [{ type: 'description_eq', value: '*' } as RuleCondition];
  const amountStar = [{ type: 'amount_gt', value: '*' } as RuleCondition];
  const matchesStar = [{ type: 'description_matches', value: '*' } as RuleCondition];
  const matchesDotStar = [{ type: 'description_matches', value: '.*' } as RuleCondition];

  return [
    {
      caseId: 'wild-1-contains-no-star',
      representation: 'canonical description_contains("*") — probe WITHOUT literal *',
      rule: jsonOriginRule('wild-1', contains, {
        kind: 'reverseMap',
        items: [{ field: 'description', operator: 'contains', value: '*' }],
      }),
      probe: { description: 'TX synthetique alpha', amount: 100 },
    },
    {
      caseId: 'wild-2-contains-literal-star',
      representation: 'canonical description_contains("*") — probe WITH literal *',
      rule: jsonOriginRule('wild-2', contains, {
        kind: 'reverseMap',
        items: [{ field: 'description', operator: 'contains', value: '*' }],
      }),
      probe: { description: 'TX synthetique * alpha', amount: 100 },
    },
    {
      caseId: 'wild-3-eq-no-star',
      representation: 'canonical description_eq("*") — probe WITHOUT literal *',
      rule: jsonOriginRule('wild-3', equals, {
        kind: 'reverseMap',
        items: [{ field: 'description', operator: 'equals', value: '*' }],
      }),
      probe: { description: 'TX synthetique beta', amount: 100 },
    },
    {
      caseId: 'wild-4-legacy-column-equals',
      representation: 'legacy-column equals / "*" (passthrough; v2 stored null)',
      rule: {
        id: 'wild-4',
        name: 'rule-wild-4',
        companyId: 'company-scrubbed-1',
        priority: 40,
        transactionDirection: 'any',
        representationOrigin: 'legacy',
        ruleKind: 'control',
        conditions: equals,
        legacyView: { kind: 'passthrough', conditionType: 'equals', conditionValue: '*' },
        v2View: { kind: 'stored', conditions: null },
      },
      probe: { description: 'TX synthetique gamma', amount: 100 },
    },
    {
      caseId: 'wild-5-amount-star',
      representation: 'amount_gt("*") — amount probe',
      rule: jsonOriginRule('wild-5', amountStar, {
        kind: 'reverseMap',
        items: [{ field: 'amount', operator: 'greater_than', value: '*' }],
      }),
      probe: { description: 'TX synthetique monto', amount: 100 },
    },
    {
      caseId: 'wild-6-matches-star',
      representation: 'description_matches("*") — regex with bare quantifier',
      rule: jsonOriginRule('wild-6', matchesStar, {
        kind: 'reverseMap',
        items: [{ field: 'description', operator: 'description_matches', value: '*' }],
      }),
      probe: { description: 'TX synthetique delta', amount: 100 },
    },
    {
      caseId: 'wild-7-matches-dot-star',
      representation: 'description_matches(".*") — regex matching everything',
      rule: jsonOriginRule('wild-7', matchesDotStar, {
        kind: 'reverseMap',
        items: [{ field: 'description', operator: 'description_matches', value: '.*' }],
      }),
      probe: { description: 'TX synthetique epsilon', amount: 100 },
    },
    {
      caseId: 'wild-8-contains-empty-description',
      representation: 'canonical description_contains("*") — probe EMPTY description',
      rule: jsonOriginRule('wild-8', contains, {
        kind: 'reverseMap',
        items: [{ field: 'description', operator: 'contains', value: '*' }],
      }),
      probe: { description: '', amount: 100 },
    },
  ];
}

function toLegacyRule(rule: FixtureRule): MatchingRule {
  const base = {
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    transactionDirection: rule.transactionDirection,
  };
  if (rule.legacyView.kind === 'passthrough') {
    return {
      ...base,
      conditions: [],
      conditionType: rule.legacyView.conditionType,
      conditionValue: rule.legacyView.conditionValue,
    };
  }
  return { ...base, conditions: rule.legacyView.items as unknown as SharedRuleCondition[] };
}

function toPrecedenceRule(rule: FixtureRule): RulePrecedenceRule {
  return {
    id: rule.id,
    conditions: rule.conditions,
    transactionDirection: rule.transactionDirection,
    priority: rule.priority,
    glAccountId: SYNTHETIC_GL,
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  };
}

function toV2Rule(rule: FixtureRule, companyId: string): PrismaBankRule {
  return {
    id: rule.id,
    companyId,
    priority: rule.priority,
    conditions: rule.v2View.conditions,
    ...(rule.legacyView.kind === 'passthrough'
      ? {
          conditionType: rule.legacyView.conditionType,
          conditionValue: rule.legacyView.conditionValue,
        }
      : {}),
    transactionDirection: rule.transactionDirection,
    glAccountId: SYNTHETIC_GL,
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  };
}

interface ObservedOutcome {
  caseId: string;
  representation: string;
  legacyState: 'WINNER' | 'NO_MATCH';
  precedenceState: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
  v2State: 'matched' | 'pending';
  v2ErrorCode?: string;
  axisACode: ShadowComparison;
  axisBCode: DivergenceType;
}

function measureCase(c: CorpusCase, companyId: string): ObservedOutcome {
  const rule = c.rule;
  const legacyRules = [toLegacyRule(rule)];
  const precedenceRules = [toPrecedenceRule(rule)];
  const v2Rules = [toV2Rule(rule, companyId)];

  const fixedDate = new Date(FIXED_DATE);
  const legacyTx = { description: c.probe.description, amount: c.probe.amount };
  const precedenceTx: RulePrecedenceTransaction = {
    id: `tx-${c.caseId}`,
    date: fixedDate,
    description: c.probe.description,
    amount: c.probe.amount,
  };
  const v2Tx: ParsedTransaction = {
    id: `tx-${c.caseId}`,
    date: fixedDate,
    description: c.probe.description,
    amount: c.probe.amount,
    bankAccountId: 'acc-synthetic',
  };

  const matching = legacyRules.filter((r) => transactionMatchesRule(legacyTx, r, [], false));
  const legacyState = matching.length === 0 ? 'NO_MATCH' : 'WINNER';
  const legacyWinnerId = matching.length === 0 ? null : (evaluateWinningRule(matching, legacyTx, companyId, {}, [])?.id ?? null);

  const precedenceOutput = evaluateTransactionAgainstRules(precedenceTx, precedenceRules);
  const precedenceState = precedenceOutput.reason;
  const precedenceWinnerId = precedenceOutput.winner?.ruleId ?? null;

  const rawV2 = runRuleEngineV2Shadow(v2Tx, v2Rules, NOT_RUN_RESOLUTION, companyId);
  const v2Result: V2EngineResult =
    rawV2.outcome === 'matched'
      ? { outcome: 'matched', matchedRuleId: rawV2.matchedRuleId }
      : rawV2.outcome === 'pending' && rawV2.errorCode
        ? { outcome: 'pending', errorCode: rawV2.errorCode }
        : { outcome: 'pending' };

  const axisAResult = compareRuleDecisions(precedenceTx, precedenceRules, legacyWinnerId);
  const precedenceResult: PrecedenceEngineResult = {
    reason: precedenceState,
    winnerRuleId: precedenceWinnerId,
    ambiguous: precedenceOutput.ambiguous,
  };
  const axisBCode = classifyDivergence(v2Result, precedenceResult);

  return {
    caseId: c.caseId,
    representation: c.representation,
    legacyState,
    precedenceState,
    v2State: v2Result.outcome,
    ...(rawV2.outcome === 'pending' && rawV2.errorCode ? { v2ErrorCode: rawV2.errorCode } : {}),
    axisACode: axisAResult.comparison,
    axisBCode,
  };
}

describe('BRE-011 Work Unit 0 — synthetic wildcard corpus (acceptance matrix)', () => {
  const companyId = 'company-scrubbed-1';
  const cases = buildCorpus();
  const outcomes: ObservedOutcome[] = [];

  beforeAll(() => {
    for (const c of cases) {
      outcomes.push(measureCase(c, companyId));
    }
  });

  const outcomeFor = (caseId: string): ObservedOutcome => {
    const o = outcomes.find((x) => x.caseId === caseId);
    if (!o) throw new Error(`missing outcome for ${caseId}`);
    return o;
  };

  it('all 8 matrix cases executed, classifiable, and the acceptance matrix printed', () => {
    expect(outcomes).toHaveLength(8);
    expect(outcomes.map((o) => o.caseId)).toEqual(
      cases.map((c) => c.caseId),
    );
    for (const o of outcomes) {
      expect(SHADOW_CODES).toContain(o.axisACode);
      expect(DIVERGENCE_CODES).toContain(o.axisBCode);
      expect(['WINNER', 'NO_MATCH']).toContain(o.legacyState);
      expect(['NO_MATCH', 'WINNER', 'AMBIGUOUS']).toContain(o.precedenceState);
      expect(['matched', 'pending']).toContain(o.v2State);
    }
    const rows = outcomes.map((o) => ({
      case: o.caseId,
      legacy: o.legacyState,
      precedence: o.precedenceState,
      v2: o.v2State,
      error: o.v2ErrorCode ?? '',
      axisA: o.axisACode,
      axisB: o.axisBCode,
    }));
    console.log(`\nBRE-011 acceptance matrix (${outcomes.length} cases):`);
    console.table(rows);
  });

  it('wildcard surface parity (cases 1–3): all three engines match non-empty descriptions', () => {
    for (const caseId of ['wild-1-contains-no-star', 'wild-2-contains-literal-star', 'wild-3-eq-no-star']) {
      const o = outcomeFor(caseId);
      expect(o.legacyState, caseId).toBe('WINNER');
      expect(o.precedenceState, caseId).toBe('WINNER');
      expect(o.v2State, caseId).toBe('matched');
      expect(o.v2ErrorCode, caseId).toBeUndefined();
      expect(o.axisACode, caseId).toBe('SAME_WINNER');
      expect(o.axisBCode, caseId).toBe('SAME');
    }
  });

  it('wildcard never matches an empty description (case 8)', () => {
    const o = outcomeFor('wild-8-contains-empty-description');
    expect(o.legacyState).toBe('NO_MATCH');
    expect(o.precedenceState).toBe('NO_MATCH');
    expect(o.v2State).toBe('pending');
    expect(o.v2ErrorCode).toBeUndefined();
    expect(o.axisACode).toBe('BOTH_NO_MATCH');
    expect(o.axisBCode).toBe('SAME');
  });

  it('legacy-column rule: adapter normalizes to canonical wildcard with full cross-engine parity (case 4)', () => {
    const o = outcomeFor('wild-4-legacy-column-equals');
    expect(o.legacyState).toBe('WINNER');
    expect(o.precedenceState).toBe('WINNER');
    expect(o.v2State).toBe('matched');
    expect(o.axisACode).toBe('SAME_WINNER');
    expect(o.axisBCode).toBe('SAME');
  });

  it('amount "*" routes to explicit no-match, never an engine error (case 5)', () => {
    const o = outcomeFor('wild-5-amount-star');
    expect(o.legacyState).toBe('NO_MATCH');
    expect(o.precedenceState).toBe('NO_MATCH');
    expect(o.v2State).toBe('pending');
    expect(o.v2ErrorCode).toBeUndefined();
    expect(o.axisACode).toBe('BOTH_NO_MATCH');
    expect(o.axisBCode).toBe('SAME');
  });

  it('regex "*" routes to explicit no-match while ".*" stays a real regex (cases 6, 7)', () => {
    const star = outcomeFor('wild-6-matches-star');
    expect(star.legacyState).toBe('NO_MATCH');
    expect(star.precedenceState).toBe('NO_MATCH');
    expect(star.v2State).toBe('pending');
    expect(star.v2ErrorCode).toBeUndefined();
    expect(star.axisACode).toBe('BOTH_NO_MATCH');
    expect(star.axisBCode).toBe('SAME');

    const dotStar = outcomeFor('wild-7-matches-dot-star');
    expect(dotStar.legacyState).toBe('NO_MATCH');
    expect(dotStar.precedenceState).toBe('WINNER');
    expect(dotStar.v2State).toBe('matched');
    expect(dotStar.axisACode).toBe('PRODUCTIVE_NO_MATCH_CANONICAL_MATCH');
    expect(dotStar.axisBCode).toBe('SAME');
  });

  it('no canary leak and the dead label V2_PENDING_PRECEDENCE_MATCH is never produced', () => {
    const values: string[] = [];
    const collect = (node: unknown): void => {
      if (typeof node === 'string') values.push(node);
      else if (Array.isArray(node)) node.forEach(collect);
      else if (node !== null && typeof node === 'object') Object.values(node).forEach(collect);
    };
    collect(cases);
    collect(outcomes);
    const text = values.join('\n');
    expect(text).not.toContain(STRING_CANARY);
    expect(text).not.toContain(String(NUMERIC_CANARY));
    expect(text).not.toContain(SYNTHETIC_GL);

    for (const o of outcomes) {
      expect(o.axisBCode).not.toBe(DEAD_LABEL);
    }
  });
});
