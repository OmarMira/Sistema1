import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import {
  runRuleEngineV2Shadow,
  type ParsedTransaction,
  type PrismaBankRule,
} from '@/lib/services/rule-engine-adapter';
import type { EntityResolution } from '@/lib/rule-engine/types';
import type { RuleCondition as SharedRuleCondition } from '@/lib/types/shared';

const COMPANY_ID = 'company-bre-012';
const SYNTHETIC_GL = 'gl-synthetic-001';
const NOT_RUN_RESOLUTION: EntityResolution = { status: 'not_run' };
const FIXED_DATE = new Date('2026-07-31T12:00:00.000Z');

type Direction = 'debit' | 'credit' | null;

interface EngineCondition {
  type: string;
  value: string | number;
}

interface LegacyCondition {
  field: string;
  operator: string;
  value: string | number;
}

interface RuleDef {
  id: string;
  direction: Direction;
  priority: number;
  legacyConditions: LegacyCondition[];
  engineConditions: EngineCondition[];
}

interface VectorDef {
  caseId: string;
  ruleIds: string[];
  description: string;
  amount: number;
}

const R_A: RuleDef = {
  id: 'R-A',
  direction: null,
  priority: 10,
  legacyConditions: [
    { field: 'description', operator: 'contains', value: 'mercado' },
    { field: 'description', operator: 'contains', value: 'pago' },
  ],
  engineConditions: [
    { type: 'description_contains', value: 'mercado' },
    { type: 'description_contains', value: 'pago' },
  ],
};

const R_B: RuleDef = {
  id: 'R-B',
  direction: null,
  priority: 10,
  legacyConditions: [{ field: 'description', operator: 'starts_with', value: 'mercado' }],
  engineConditions: [{ type: 'description_starts_with', value: 'mercado' }],
};

function toLegacyRule(def: RuleDef): MatchingRule {
  return {
    id: def.id,
    name: def.id,
    priority: def.priority,
    conditions: def.legacyConditions as unknown as SharedRuleCondition[],
    transactionDirection: def.direction,
  };
}

function toPrecedenceRule(def: RuleDef): RulePrecedenceRule {
  return {
    id: def.id,
    conditions: def.engineConditions,
    transactionDirection: def.direction,
    priority: def.priority,
    glAccountId: SYNTHETIC_GL,
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  };
}

function toV2Rule(def: RuleDef): PrismaBankRule {
  return {
    id: def.id,
    companyId: COMPANY_ID,
    priority: def.priority,
    conditions: def.engineConditions,
    transactionDirection: def.direction,
    glAccountId: SYNTHETIC_GL,
    debitGlAccountId: null,
    creditGlAccountId: null,
    isActive: true,
  };
}

interface EngineOutcome {
  winnerId: string | null;
  ambiguous: boolean;
}

function runLegacy(
  tx: { description: string; amount: number },
  defs: RuleDef[],
): EngineOutcome {
  const rules = defs.map((def) => toLegacyRule(def));
  const matching = rules.filter((rule) => transactionMatchesRule(tx, rule, [], false));
  if (matching.length === 0) {
    return { winnerId: null, ambiguous: false };
  }
  const winner = evaluateWinningRule(matching, tx, COMPANY_ID, {}, []);
  if (winner) {
    return { winnerId: winner.id, ambiguous: false };
  }
  return { winnerId: null, ambiguous: true };
}

function runPrecedence(
  tx: RulePrecedenceTransaction,
  defs: RuleDef[],
): EngineOutcome {
  const rules = defs.map((def) => toPrecedenceRule(def));
  const output = evaluateTransactionAgainstRules(tx, rules);
  return {
    winnerId: output.winner?.ruleId ?? null,
    ambiguous: output.reason === 'AMBIGUOUS',
  };
}

function runV2(tx: ParsedTransaction, defs: RuleDef[]): EngineOutcome {
  const rules = defs.map((def) => toV2Rule(def));
  const match = runRuleEngineV2Shadow(tx, rules, NOT_RUN_RESOLUTION, COMPANY_ID);
  if (match.outcome === 'matched') {
    return { winnerId: match.matchedRuleId, ambiguous: false };
  }
  const isAmbiguous = match.outcome === 'pending' && !match.errorCode;
  return { winnerId: null, ambiguous: isAmbiguous && rules.length > 0 };
}

function runAll(v: VectorDef) {
  const legacyTx = { description: v.description, amount: v.amount };
  const precedenceTx: RulePrecedenceTransaction = {
    id: `tx-${v.caseId}`,
    date: FIXED_DATE,
    description: v.description,
    amount: v.amount,
  };
  const v2Tx: ParsedTransaction = {
    id: `tx-${v.caseId}`,
    date: FIXED_DATE,
    description: v.description,
    amount: v.amount,
    bankAccountId: 'acc-synthetic',
  };
  return {
    legacy: runLegacy(legacyTx, v.ruleIds.map((id) => DEFS[id]!)),
    precedence: runPrecedence(precedenceTx, v.ruleIds.map((id) => DEFS[id]!)),
    v2: runV2(v2Tx, v.ruleIds.map((id) => DEFS[id]!)),
  };
}

const DEFS: Record<string, RuleDef> = { 'R-A': R_A, 'R-B': R_B };

const VECTORS: VectorDef[] = [
  {
    caseId: 'R-1',
    // BRE-009 R-1 parity vector: two tier-1 `contains` (R-A) vs tier-2
    // `starts_with` (R-B). All three engines must resolve to R-B.
    ruleIds: ['R-A', 'R-B'],
    description: 'mercado pago sa',
    amount: -100,
  },
];

describe('adversarial ranking parity — winner equality across the three engines', () => {
  beforeAll(() => {
    // Hermetic: never read the real environment. The adversarial suite pins
    // Legacy to the canonical path regardless of process.env, and it must not
    // depend on BRE010_FIXTURE_PATH or any database.
    vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('R-1: all three engines agree on the same winner (R-B), never R-A', () => {
    for (const v of VECTORS) {
      const { legacy, precedence, v2 } = runAll(v);
      expect(legacy.winnerId).toBe('R-B');
      expect(precedence.winnerId).toBe('R-B');
      expect(v2.winnerId).toBe('R-B');
      expect(new Set([legacy.winnerId, precedence.winnerId, v2.winnerId]).size).toBe(1);
    }
  });

  it('no DIFFERENT_WINNER across engines on the parity vector', () => {
    const { legacy, precedence, v2 } = runAll(VECTORS[0]!);
    const winnerIds = [legacy.winnerId, precedence.winnerId, v2.winnerId].filter(
      (id): id is string => id !== null,
    );
    expect(winnerIds.length).toBeGreaterThan(0);
    expect(new Set(winnerIds).size).toBe(1);
  });

  it('R-1: input order invariance — reordering the rule array does not change the winner', () => {
    const tx = { description: 'mercado pago sa', amount: -100 };
    const forward = runLegacy(tx, [R_A, R_B]);
    const reversed = runLegacy(tx, [R_B, R_A]);
    expect(forward.winnerId).toBe(reversed.winnerId);
    expect(forward.winnerId).toBe('R-B');

    const precedenceTx: RulePrecedenceTransaction = {
      id: 'tx-order',
      date: FIXED_DATE,
      description: 'mercado pago sa',
      amount: -100,
    };
    const fwd = runPrecedence(precedenceTx, [R_A, R_B]);
    const rev = runPrecedence(precedenceTx, [R_B, R_A]);
    expect(fwd.winnerId).toBe(rev.winnerId);
    expect(fwd.winnerId).toBe('R-B');

    const v2Tx: ParsedTransaction = {
      id: 'tx-order',
      date: FIXED_DATE,
      description: 'mercado pago sa',
      amount: -100,
      bankAccountId: 'acc-synthetic',
    };
    const v2fwd = runV2(v2Tx, [R_A, R_B]);
    const v2rev = runV2(v2Tx, [R_B, R_A]);
    expect(v2fwd.winnerId).toBe(v2rev.winnerId);
    expect(v2fwd.winnerId).toBe('R-B');
  });

  it('ambiguous outcome propagates identically (no phantom winner) on a full tie', () => {
    const tieA: RuleDef = {
      id: 'R-T1',
      direction: null,
      priority: 10,
      legacyConditions: [{ field: 'description', operator: 'contains', value: 'pago' }],
      engineConditions: [{ type: 'description_contains', value: 'pago' }],
    };
    const tieB: RuleDef = {
      id: 'R-T2',
      direction: null,
      priority: 10,
      legacyConditions: [{ field: 'description', operator: 'contains', value: 'pago' }],
      engineConditions: [{ type: 'description_contains', value: 'pago' }],
    };
    const tx = { description: 'pago de servicio', amount: 200 };
    const precedenceTx: RulePrecedenceTransaction = {
      id: 'tx-tie',
      date: FIXED_DATE,
      description: 'pago de servicio',
      amount: 200,
    };
    const v2Tx: ParsedTransaction = {
      id: 'tx-tie',
      date: FIXED_DATE,
      description: 'pago de servicio',
      amount: 200,
      bankAccountId: 'acc-synthetic',
    };
    const legacy = runLegacy(tx, [tieA, tieB]);
    const precedence = runPrecedence(precedenceTx, [tieA, tieB]);
    const v2 = runV2(v2Tx, [tieA, tieB]);

    expect(legacy.winnerId).toBeNull();
    expect(legacy.ambiguous).toBe(true);
    expect(precedence.winnerId).toBeNull();
    expect(precedence.ambiguous).toBe(true);
    expect(v2.winnerId).toBeNull();
    expect(new Set([legacy.ambiguous, precedence.ambiguous, v2.ambiguous])).toEqual(
      new Set([true]),
    );
  });

  it('single matched rule yields the same winner in all engines (no ambiguity)', () => {
    const tx = { description: 'pago de servicio', amount: 200 };
    const precedenceTx: RulePrecedenceTransaction = {
      id: 'tx-single',
      date: FIXED_DATE,
      description: 'pago de servicio',
      amount: 200,
    };
    const v2Tx: ParsedTransaction = {
      id: 'tx-single',
      date: FIXED_DATE,
      description: 'pago de servicio',
      amount: 200,
      bankAccountId: 'acc-synthetic',
    };
    const single: RuleDef = {
      id: 'R-S',
      direction: null,
      priority: 10,
      legacyConditions: [{ field: 'description', operator: 'contains', value: 'pago' }],
      engineConditions: [{ type: 'description_contains', value: 'pago' }],
    };
    const legacy = runLegacy(tx, [single]);
    const precedence = runPrecedence(precedenceTx, [single]);
    const v2 = runV2(v2Tx, [single]);
    expect(legacy.winnerId).toBe('R-S');
    expect(precedence.winnerId).toBe('R-S');
    expect(v2.winnerId).toBe('R-S');
  });

  it('R-1 AMBIGUOUS never fires when a material tier gap exists', () => {
    // BRE-009 requirement: a tier-first material gap resolves to a winner in
    // every engine, never to AMBIGUOUS.
    for (const v of VECTORS) {
      const { legacy, precedence, v2 } = runAll(v);
      expect(legacy.winnerId).toBe('R-B');
      expect(precedence.winnerId).toBe('R-B');
      expect(v2.winnerId).toBe('R-B');
      expect(legacy.ambiguous).toBe(false);
      expect(precedence.ambiguous).toBe(false);
      expect(v2.ambiguous).toBe(false);
    }
  });
});