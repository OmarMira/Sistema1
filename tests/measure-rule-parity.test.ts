import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
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
  compareRuleDecisions,
  type ShadowComparison,
} from '@/lib/services/rule-precedence-shadow';
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
import type { EntityResolution } from '@/lib/rule-engine/types';
import type { RuleCondition as SharedRuleCondition } from '@/lib/types/shared';
import { evaluateRulesPure } from '@/lib/rule-engine';
import type {
  RuleInput,
  Transaction,
  BankRule,
  RuleCondition,
  RuleEngineExecution,
  TraceEvent,
} from '@/lib/rule-engine';

const COMPANY_ID = 'company-bre-009';
const SYNTHETIC_GL = 'gl-synthetic-001';
const NOT_RUN_RESOLUTION: EntityResolution = { status: 'not_run' };
const FIXED_DATE = new Date('2026-07-31T12:00:00.000Z');

type Direction = 'debit' | 'credit' | null;
type Category = 'control' | 'direccion' | 'monto' | 'wildcard' | 'ranking' | 'regex';

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

const RULES: Record<string, RuleDef> = {
  'R-CTRL': {
    id: 'R-CTRL',
    direction: 'debit',
    priority: 10,
    legacyConditions: [{ field: 'description', operator: 'contains', value: 'control' }],
    engineConditions: [{ type: 'description_contains', value: 'control' }],
  },
  'R-DIR': {
    id: 'R-DIR',
    direction: 'credit',
    priority: 10,
    legacyConditions: [{ field: 'description', operator: 'contains', value: 'servicio' }],
    engineConditions: [{ type: 'description_contains', value: 'servicio' }],
  },
  'R-AMT1': {
    id: 'R-AMT1',
    direction: 'debit',
    priority: 10,
    legacyConditions: [{ field: 'amount', operator: 'amount_greater', value: 100 }],
    engineConditions: [{ type: 'amount_gt', value: 100 }],
  },
  'R-AMT1C': {
    id: 'R-AMT1C',
    direction: 'credit',
    priority: 10,
    legacyConditions: [{ field: 'amount', operator: 'amount_greater', value: 100 }],
    engineConditions: [{ type: 'amount_gt', value: 100 }],
  },
  'R-AMT2': {
    id: 'R-AMT2',
    direction: null,
    priority: 10,
    legacyConditions: [{ field: 'amount', operator: 'equals', value: 150 }],
    engineConditions: [{ type: 'amount_eq', value: 150 }],
  },
  'R-WLD': {
    id: 'R-WLD',
    direction: null,
    priority: 10,
    legacyConditions: [{ field: 'description', operator: 'contains', value: '*' }],
    engineConditions: [{ type: 'description_contains', value: '*' }],
  },
  'R-A': {
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
  },
  'R-B': {
    id: 'R-B',
    direction: null,
    priority: 10,
    legacyConditions: [{ field: 'description', operator: 'starts_with', value: 'mercado' }],
    engineConditions: [{ type: 'description_starts_with', value: 'mercado' }],
  },
  'R-REG': {
    id: 'R-REG',
    direction: null,
    priority: 10,
    legacyConditions: [{ field: 'description', operator: 'matches', value: '[' }],
    engineConditions: [{ type: 'description_matches', value: '[' }],
  },
};

interface VectorDef {
  caseId: string;
  category: Category;
  ruleIds: string[];
  description: string;
  amount: number;
  expectedAxisA: ShadowComparison;
  expectedAxisB: DivergenceType;
}

const VECTORS: VectorDef[] = [
  {
    caseId: 'C-pos',
    category: 'control',
    ruleIds: ['R-CTRL'],
    description: 'control unitario',
    amount: -100,
    expectedAxisA: 'SAME_WINNER',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'C-neg',
    category: 'control',
    ruleIds: ['R-CTRL'],
    description: 'sin coincidencia',
    amount: -100,
    expectedAxisA: 'BOTH_NO_MATCH',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'D-pos',
    category: 'direccion',
    ruleIds: ['R-DIR'],
    description: 'pago de servicio',
    amount: 200,
    expectedAxisA: 'SAME_WINNER',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'D-neg',
    category: 'direccion',
    ruleIds: ['R-DIR'],
    description: 'pago de servicio',
    amount: -200,
    expectedAxisA: 'BOTH_NO_MATCH',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'M-1',
    category: 'monto',
    ruleIds: ['R-AMT1'],
    description: 'compra',
    amount: -200,
    expectedAxisA: 'SAME_WINNER',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'M-2',
    category: 'monto',
    ruleIds: ['R-AMT1'],
    description: 'compra',
    amount: -50,
    expectedAxisA: 'BOTH_NO_MATCH',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'M-3',
    category: 'monto',
    ruleIds: ['R-AMT2'],
    description: 'compra',
    amount: -150,
    expectedAxisA: 'SAME_WINNER',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'M-control',
    category: 'monto',
    ruleIds: ['R-AMT1C'],
    description: 'compra',
    amount: 200,
    expectedAxisA: 'SAME_WINNER',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'W-1',
    category: 'wildcard',
    ruleIds: ['R-WLD'],
    description: 'cualquier cosa',
    amount: -100,
    expectedAxisA: 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'R-1',
    category: 'ranking',
    ruleIds: ['R-A', 'R-B'],
    description: 'mercado pago sa',
    amount: -100,
    expectedAxisA: 'SAME_WINNER',
    expectedAxisB: 'DIFFERENT_WINNER',
  },
  {
    caseId: 'R-2',
    category: 'ranking',
    ruleIds: ['R-A', 'R-B'],
    description: 'mercado libre solo start',
    amount: -100,
    expectedAxisA: 'SAME_WINNER',
    expectedAxisB: 'SAME',
  },
  {
    caseId: 'X-1',
    category: 'regex',
    ruleIds: ['R-REG'],
    description: 'x',
    amount: -100,
    expectedAxisA: 'BOTH_NO_MATCH',
    expectedAxisB: 'V2_ERROR',
  },
];

const AGREE_A: readonly ShadowComparison[] = ['SAME_WINNER', 'BOTH_NO_MATCH'];
const DIVERGE_A: readonly ShadowComparison[] = [
  'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH',
  'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH',
  'DIFFERENT_WINNER',
  'CANONICAL_AMBIGUOUS',
];
const DIVERGE_B: readonly DivergenceType[] = [
  'DIFFERENT_WINNER',
  'V2_MATCH_PRECEDENCE_NO_MATCH',
  'V2_NO_MATCH_PRECEDENCE_MATCH',
];
const AGREE_B: DivergenceType = 'SAME';

const CATEGORIES: readonly Category[] = ['control', 'direccion', 'monto', 'wildcard', 'ranking', 'regex'];

const CONTROLS: Record<string, { axisA: ShadowComparison; axisB: DivergenceType }> = {
  'C-pos': { axisA: 'SAME_WINNER', axisB: 'SAME' },
  'C-neg': { axisA: 'BOTH_NO_MATCH', axisB: 'SAME' },
  'D-pos': { axisA: 'SAME_WINNER', axisB: 'SAME' },
  'D-neg': { axisA: 'BOTH_NO_MATCH', axisB: 'SAME' },
  'M-2': { axisA: 'BOTH_NO_MATCH', axisB: 'SAME' },
  'M-control': { axisA: 'SAME_WINNER', axisB: 'SAME' },
  'R-2': { axisA: 'SAME_WINNER', axisB: 'SAME' },
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

interface LegacyOutcome {
  state: 'WINNER' | 'NO_MATCH';
  winnerId: string | null;
}

function runLegacy(
  tx: { description: string; amount: number },
  rules: MatchingRule[],
): LegacyOutcome {
  const matching = rules.filter((rule) => transactionMatchesRule(tx, rule, [], false));
  if (matching.length === 0) {
    return { state: 'NO_MATCH', winnerId: null };
  }
  const winner = evaluateWinningRule(matching, tx, COMPANY_ID, {}, []);
  return { state: 'WINNER', winnerId: winner.id };
}

function runPrecedence(tx: RulePrecedenceTransaction, rules: RulePrecedenceRule[]) {
  const output = evaluateTransactionAgainstRules(tx, rules);
  return {
    state: output.reason,
    winnerId: output.winner?.ruleId ?? null,
    ambiguous: output.ambiguous,
  };
}

function toV2Result(match: ReturnType<typeof runRuleEngineV2Shadow>): V2EngineResult {
  if (match.outcome === 'matched') {
    return { outcome: 'matched', matchedRuleId: match.matchedRuleId };
  }
  if (match.outcome === 'pending' && match.errorCode) {
    return { outcome: 'pending', errorCode: match.errorCode };
  }
  return { outcome: 'pending' };
}

function uniqueConditionTypes(ruleIds: string[]): string[] {
  const types = new Set<string>();
  for (const id of ruleIds) {
    for (const cond of RULES[id]!.engineConditions) {
      types.add(cond.type);
    }
  }
  return Array.from(types);
}

interface CaseOutcome {
  caseId: string;
  category: Category;
  conditionTypes: string[];
  legacyState: 'WINNER' | 'NO_MATCH';
  precedenceState: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
  v2State: 'matched' | 'pending';
  v2ErrorCode?: string;
  axisACode: ShadowComparison;
  axisBCode: DivergenceType;
  expectedAxisA: ShadowComparison;
  expectedAxisB: DivergenceType;
}

interface Metrics {
  legacyPrecedenceTotal: number;
  legacyPrecedenceAgree: number;
  legacyPrecedenceDivergence: number;
  legacyPrecedenceAgreementRate: number;
  v2PrecedenceTotal: number;
  v2PrecedenceAgree: number;
  v2DivergenceCount: number;
  v2ErrorCount: number;
  v2PrecedenceAgreementRate: number;
  v2ErrorRate: number;
  precedenceErrorRate: number;
}

interface CategoryStats {
  category: Category;
  verdict: 'PARITY' | 'DIVERGENCE_CONFIRMED' | 'FIXTURE_ERROR';
  designedAxisA: number;
  detectedAxisA: number;
  designedAxisB: number;
  detectedAxisB: number;
  designedErrors: number;
  detectedErrors: number;
  recallA: number;
  recallB: number;
  falsePositiveAxisA: number;
  falsePositiveAxisB: number;
}

interface ProtocolResult {
  outcomes: CaseOutcome[];
  metrics: Metrics;
  categories: CategoryStats[];
  runValid: boolean;
  controlFailures: string[];
}

function computeCategory(category: Category, outcomes: CaseOutcome[]): CategoryStats {
  const vecs = outcomes.filter((o) => o.category === category);

  const designedAxisA = vecs.filter((v) => DIVERGE_A.includes(v.expectedAxisA)).length;
  const detectedAxisA = vecs.filter(
    (v) => DIVERGE_A.includes(v.expectedAxisA) && v.axisACode === v.expectedAxisA,
  ).length;
  const designedAxisB = vecs.filter((v) => DIVERGE_B.includes(v.expectedAxisB)).length;
  const detectedAxisB = vecs.filter(
    (v) => DIVERGE_B.includes(v.expectedAxisB) && v.axisBCode === v.expectedAxisB,
  ).length;
  const designedErrors = vecs.filter((v) => v.expectedAxisB === 'V2_ERROR').length;
  const detectedErrors = vecs.filter(
    (v) => v.expectedAxisB === 'V2_ERROR' && v.axisBCode === 'V2_ERROR',
  ).length;

  const falsePositiveAxisA = vecs.filter(
    (v) => DIVERGE_A.includes(v.axisACode) && v.axisACode !== v.expectedAxisA,
  ).length;
  const falsePositiveAxisB = vecs.filter(
    (v) =>
      (DIVERGE_B.includes(v.axisBCode) || v.axisBCode === 'V2_ERROR') &&
      v.axisBCode !== v.expectedAxisB,
  ).length;

  const recallA = designedAxisA === 0 ? 1 : detectedAxisA / designedAxisA;
  const recallB =
    designedAxisB + designedErrors === 0
      ? 1
      : (detectedAxisB + detectedErrors) / (designedAxisB + designedErrors);

  const fixtureFailure = vecs.some(
    (v) =>
      (DIVERGE_A.includes(v.expectedAxisA) && AGREE_A.includes(v.axisACode)) ||
      (DIVERGE_B.includes(v.expectedAxisB) && v.axisBCode === AGREE_B) ||
      (v.expectedAxisB === 'V2_ERROR' && v.axisBCode === AGREE_B),
  );

  const hasDesigned = designedAxisA + designedAxisB + designedErrors > 0;
  const allDetected =
    detectedAxisA === designedAxisA &&
    detectedAxisB === designedAxisB &&
    detectedErrors === designedErrors;

  let verdict: CategoryStats['verdict'];
  if (fixtureFailure || (hasDesigned && !allDetected)) {
    verdict = 'FIXTURE_ERROR';
  } else if (hasDesigned && allDetected) {
    verdict = 'DIVERGENCE_CONFIRMED';
  } else {
    verdict = 'PARITY';
  }

  return {
    category,
    verdict,
    designedAxisA,
    detectedAxisA,
    designedAxisB,
    detectedAxisB,
    designedErrors,
    detectedErrors,
    recallA,
    recallB,
    falsePositiveAxisA,
    falsePositiveAxisB,
  };
}

function runProtocol(): ProtocolResult {
  const outcomes: CaseOutcome[] = VECTORS.map((v) => {
    const legacyRules = v.ruleIds.map((id) => toLegacyRule(RULES[id]!));
    const precedenceRules = v.ruleIds.map((id) => toPrecedenceRule(RULES[id]!));
    const v2Rules = v.ruleIds.map((id) => toV2Rule(RULES[id]!));

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

    const legacy = runLegacy(legacyTx, legacyRules);
    const precedence = runPrecedence(precedenceTx, precedenceRules);
    const v2Result = toV2Result(
      runRuleEngineV2Shadow(v2Tx, v2Rules, NOT_RUN_RESOLUTION, COMPANY_ID),
    );

    const axisAResult = compareRuleDecisions(precedenceTx, precedenceRules, legacy.winnerId);
    const precedenceResult: PrecedenceEngineResult = {
      reason: precedence.state,
      winnerRuleId: precedence.winnerId,
      ambiguous: precedence.ambiguous,
    };
    const axisBCode = classifyDivergence(v2Result, precedenceResult);

    return {
      caseId: v.caseId,
      category: v.category,
      conditionTypes: uniqueConditionTypes(v.ruleIds),
      legacyState: legacy.state,
      precedenceState: precedence.state,
      v2State: v2Result.outcome,
      ...(v2Result.errorCode !== undefined ? { v2ErrorCode: v2Result.errorCode } : {}),
      axisACode: axisAResult.comparison,
      axisBCode,
      expectedAxisA: v.expectedAxisA,
      expectedAxisB: v.expectedAxisB,
    };
  });

  const legacyPrecedenceTotal = outcomes.length;
  const legacyPrecedenceAgree = outcomes.filter((o) => AGREE_A.includes(o.axisACode)).length;
  const legacyPrecedenceDivergence = outcomes.filter((o) =>
    DIVERGE_A.includes(o.axisACode),
  ).length;

  const v2PrecedenceTotal = outcomes.length;
  const v2PrecedenceAgree = outcomes.filter((o) => o.axisBCode === AGREE_B).length;
  const v2DivergenceCount = outcomes.filter((o) => DIVERGE_B.includes(o.axisBCode)).length;
  const v2ErrorCount = outcomes.filter((o) => o.axisBCode === 'V2_ERROR').length;

  const controlFailures = outcomes
    .filter((o) => {
      const expected = CONTROLS[o.caseId];
      return expected !== undefined && (o.axisACode !== expected.axisA || o.axisBCode !== expected.axisB);
    })
    .map((o) => o.caseId);

  const categories = CATEGORIES.map((c) => computeCategory(c, outcomes));

  const metrics: Metrics = {
    legacyPrecedenceTotal,
    legacyPrecedenceAgree,
    legacyPrecedenceDivergence,
    legacyPrecedenceAgreementRate: legacyPrecedenceAgree / legacyPrecedenceTotal,
    v2PrecedenceTotal,
    v2PrecedenceAgree,
    v2DivergenceCount,
    v2ErrorCount,
    v2PrecedenceAgreementRate: v2PrecedenceAgree / v2PrecedenceTotal,
    v2ErrorRate: v2ErrorCount / v2PrecedenceTotal,
    precedenceErrorRate: 0,
  };

  return {
    outcomes,
    metrics,
    categories,
    runValid: controlFailures.length === 0,
    controlFailures,
  };
}

interface ReportJson {
  fixtureVersion: string;
  gitCommit: string;
  commitSource: string;
  runId: string;
  runValid: boolean;
  controlFailures: string[];
  metrics: Metrics;
  axisA: Array<{
    caseId: string;
    category: Category;
    conditionTypes: string[];
    legacyState: 'WINNER' | 'NO_MATCH';
    precedenceState: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
    axisACode: ShadowComparison;
    expectedAxisA: ShadowComparison;
    ok: boolean;
  }>;
  axisB: Array<{
    caseId: string;
    category: Category;
    conditionTypes: string[];
    v2State: 'matched' | 'pending';
    precedenceState: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
    axisBCode: DivergenceType;
    expectedAxisB: DivergenceType;
    v2ErrorCode?: string;
    ok: boolean;
  }>;
  categories: CategoryStats[];
}

function fixtureVersion(): string {
  const canonical = JSON.stringify({ rules: RULES, vectors: VECTORS });
  return `fnv1a-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

function getCommit(): { gitCommit: string; commitSource: string } {
  try {
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    return { gitCommit: commit, commitSource: 'git-rev-parse' };
  } catch {
    return { gitCommit: 'unknown', commitSource: 'fallback-unknown' };
  }
}

function buildReportJson(protocol: ProtocolResult): ReportJson {
  return {
    fixtureVersion: fixtureVersion(),
    ...getCommit(),
    runId: crypto.randomUUID(),
    runValid: protocol.runValid,
    controlFailures: protocol.controlFailures,
    metrics: protocol.metrics,
    axisA: protocol.outcomes.map((o) => ({
      caseId: o.caseId,
      category: o.category,
      conditionTypes: o.conditionTypes,
      legacyState: o.legacyState,
      precedenceState: o.precedenceState,
      axisACode: o.axisACode,
      expectedAxisA: o.expectedAxisA,
      ok: o.axisACode === o.expectedAxisA,
    })),
    axisB: protocol.outcomes.map((o) => ({
      caseId: o.caseId,
      category: o.category,
      conditionTypes: o.conditionTypes,
      v2State: o.v2State,
      precedenceState: o.precedenceState,
      axisBCode: o.axisBCode,
      expectedAxisB: o.expectedAxisB,
      ...(o.v2ErrorCode !== undefined ? { v2ErrorCode: o.v2ErrorCode } : {}),
      ok: o.axisBCode === o.expectedAxisB,
    })),
    categories: protocol.categories,
  };
}

function validateReportJson(report: ReportJson): void {
  if (report.axisA.length !== 12 || report.axisB.length !== 12) {
    throw new Error('report validation failed: axis matrices must have 12 rows');
  }
  if (report.categories.length !== 6) {
    throw new Error('report validation failed: must have 6 categories');
  }
  const m = report.metrics;
  if (m.legacyPrecedenceAgree + m.legacyPrecedenceDivergence !== 12) {
    throw new Error('report validation failed: axis A accounting (agree + divergence != 12)');
  }
  if (m.v2PrecedenceAgree + m.v2DivergenceCount + m.v2ErrorCount !== 12) {
    throw new Error('report validation failed: axis B accounting (agree + divergence + error != 12)');
  }
  for (const row of report.axisA) {
    if (!row.ok) throw new Error(`report validation failed: axis A mismatch on ${row.caseId}`);
  }
  for (const row of report.axisB) {
    if (!row.ok) throw new Error(`report validation failed: axis B mismatch on ${row.caseId}`);
  }
  for (const c of report.categories) {
    if (c.verdict === 'FIXTURE_ERROR') {
      throw new Error(`report validation failed: category ${c.category} has FIXTURE_ERROR`);
    }
    if (c.recallA !== 1 || c.recallB !== 1) {
      throw new Error(`report validation failed: category ${c.category} recall != 1`);
    }
    if (c.falsePositiveAxisA !== 0 || c.falsePositiveAxisB !== 0) {
      throw new Error(`report validation failed: category ${c.category} falsePositive != 0`);
    }
  }
  if (!report.runValid) {
    throw new Error(`report validation failed: run INVALID, failed controls: ${report.controlFailures.join(',')}`);
  }
}

let protocol: ProtocolResult;
let tempDir: string | null = null;
let tempFilePath: string | null = null;

beforeAll(() => {
  protocol = runProtocol();
  const report = buildReportJson(protocol);
  validateReportJson(report);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-parity-'));
  tempDir = dir;
  tempFilePath = path.join(dir, 'measure-rule-parity.json');
  fs.writeFileSync(tempFilePath, JSON.stringify(report, null, 2), 'utf8');
});

afterAll(() => {
  if (tempDir !== null) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    tempDir = null;
    tempFilePath = null;
  }
});

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function collectStringValues(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) {
      collectStringValues(item, out);
    }
  } else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) {
      collectStringValues(value, out);
    }
  }
}

function printReport(): void {
  const report = buildReportJson(protocol);
  const m = protocol.metrics;
  const meta = {
    fixtureVersion: report.fixtureVersion,
    gitCommit: report.gitCommit,
    commitSource: report.commitSource,
    runId: report.runId,
    tempFilePath: tempFilePath ?? '(none)',
  };

  const out = (line: string): void => {
    process.stdout.write(line + '\n');
  };

  out('\n' + '='.repeat(76));
  out('BRE-009 REPRODUCIBLE SHADOW MEASUREMENT — PARITY REPORT');
  out('='.repeat(76));
  out(`fixtureVersion : ${meta.fixtureVersion}`);
  out(`git commit     : ${meta.gitCommit} (source: ${meta.commitSource})`);
  out(`runId          : ${meta.runId}`);
  out(
    `runValid       : ${protocol.runValid}` +
      (protocol.runValid ? '' : ` INVALID — failed controls: ${protocol.controlFailures.join(',')}`),
  );
  out(`temp JSON      : ${meta.tempFilePath}`);
  out('');

  out('Per-category verdicts');
  out(
    pad('category', 12) +
      pad('verdict', 24) +
      pad('desA', 5) +
      pad('detA', 5) +
      pad('recallA', 8) +
      pad('desB', 5) +
      pad('detB', 5) +
      pad('desErr', 7) +
      pad('detErr', 7) +
      pad('recallB', 8) +
      pad('FP_A', 5) +
      pad('FP_B', 5),
  );
  for (const c of protocol.categories) {
    out(
      pad(c.category, 12) +
        pad(c.verdict, 24) +
        pad(String(c.designedAxisA), 5) +
        pad(String(c.detectedAxisA), 5) +
        pad(String(c.recallA), 8) +
        pad(String(c.designedAxisB), 5) +
        pad(String(c.detectedAxisB), 5) +
        pad(String(c.designedErrors), 7) +
        pad(String(c.detectedErrors), 7) +
        pad(String(c.recallB), 8) +
        pad(String(c.falsePositiveAxisA), 5) +
        pad(String(c.falsePositiveAxisB), 5),
    );
  }
  out('');

  out('AXIS A — Legacy vs Precedence (12 vectors)');
  out(
    pad('caseId', 10) +
      pad('category', 12) +
      pad('L', 9) +
      pad('P', 10) +
      pad('code', 40) +
      pad('expected', 40) +
      'result',
  );
  for (const o of protocol.outcomes) {
    const ok = o.axisACode === o.expectedAxisA;
    out(
      pad(o.caseId, 10) +
        pad(o.category, 12) +
        pad(o.legacyState, 9) +
        pad(o.precedenceState, 10) +
        pad(o.axisACode, 40) +
        pad(o.expectedAxisA, 40) +
        (ok ? 'PASS' : 'FAIL'),
    );
  }
  out('');

  out('AXIS B — V2 vs Precedence (12 vectors)');
  out(
    pad('caseId', 10) +
      pad('category', 12) +
      pad('V2', 9) +
      pad('P', 10) +
      pad('code', 40) +
      pad('expected', 40) +
      pad('errorCode', 34) +
      'result',
  );
  for (const o of protocol.outcomes) {
    const ok = o.axisBCode === o.expectedAxisB;
    out(
      pad(o.caseId, 10) +
        pad(o.category, 12) +
        pad(o.v2State, 9) +
        pad(o.precedenceState, 10) +
        pad(o.axisBCode, 40) +
        pad(o.expectedAxisB, 40) +
        pad(o.v2ErrorCode ?? '-', 34) +
        (ok ? 'PASS' : 'FAIL'),
    );
  }
  out('');

  out('Aggregate conformance rates (exact, no sampling)');
  out(`legacyPrecedenceAgreementRate : ${m.legacyPrecedenceAgree}/${m.legacyPrecedenceTotal} (${(m.legacyPrecedenceAgreementRate * 100).toFixed(1)}%)`);
  out(`v2PrecedenceAgreementRate     : ${m.v2PrecedenceAgree}/${m.v2PrecedenceTotal} (${(m.v2PrecedenceAgreementRate * 100).toFixed(1)}%)`);
  out(`v2ErrorRate                    : ${m.v2ErrorCount}/${m.v2PrecedenceTotal} (${(m.v2ErrorRate * 100).toFixed(1)}%)`);
  out(`precedenceErrorRate            : ${m.precedenceErrorRate} (fact: Precedence fails silent, never errors)`);
  out(`v2DivergenceCount              : ${m.v2DivergenceCount}`);
  out(`v2ErrorCount                   : ${m.v2ErrorCount}`);
  out('='.repeat(76));
}

describe('BRE-009: reproducible shadow measurement protocol', () => {
  it('produces the exact expected axis codes for all 12 hermetic vectors', () => {
    for (const o of protocol.outcomes) {
      expect(o.axisACode).toBe(o.expectedAxisA);
      expect(o.axisBCode).toBe(o.expectedAxisB);
    }
  });

  it('axis A metrics match the spec: 11 agreements / 1 divergence / rate 11/12', () => {
    const m = protocol.metrics;
    expect(m.legacyPrecedenceTotal).toBe(12);
    expect(m.legacyPrecedenceAgree).toBe(11);
    expect(m.legacyPrecedenceDivergence).toBe(1);
    expect(m.legacyPrecedenceAgreementRate).toBeCloseTo(11 / 12, 10);
  });

  it('axis B metrics match the spec: 10 agreements / 1 divergence / 1 error / rate 10/12', () => {
    const m = protocol.metrics;
    expect(m.v2PrecedenceTotal).toBe(12);
    expect(m.v2PrecedenceAgree).toBe(10);
    expect(m.v2DivergenceCount).toBe(1);
    expect(m.v2ErrorCount).toBe(1);
    expect(m.v2PrecedenceAgreementRate).toBeCloseTo(10 / 12, 10);
    expect(m.v2ErrorRate).toBeCloseTo(1 / 12, 10);
    expect(m.precedenceErrorRate).toBe(0);
  });

  it('accounting sanity per axis: A 11+1=12, B 10+1+1=12, no double counting', () => {
    const m = protocol.metrics;
    expect(m.legacyPrecedenceAgree + m.legacyPrecedenceDivergence).toBe(12);
    expect(m.v2PrecedenceAgree + m.v2DivergenceCount + m.v2ErrorCount).toBe(12);
    const onlyDivergence = protocol.outcomes.filter((o) =>
      DIVERGE_B.includes(o.axisBCode),
    );
    expect(onlyDivergence.some((o) => o.axisBCode === 'V2_ERROR')).toBe(false);
    expect(protocol.outcomes.filter((o) => o.axisBCode === 'V2_ERROR')).toHaveLength(1);
  });

  it('all mandatory controls pass (C-pos, C-neg, D, M-2/M-control, R-2)', () => {
    expect(protocol.runValid).toBe(true);
    expect(protocol.controlFailures).toEqual([]);
    for (const [caseId, expected] of Object.entries(CONTROLS)) {
      const o = protocol.outcomes.find((x) => x.caseId === caseId)!;
      expect(o.axisACode).toBe(expected.axisA);
      expect(o.axisBCode).toBe(expected.axisB);
    }
  });

  it('recall=1 and falsePositive=0 in every category on both axes', () => {
    for (const c of protocol.categories) {
      expect(c.recallA).toBe(1);
      expect(c.recallB).toBe(1);
      expect(c.falsePositiveAxisA).toBe(0);
      expect(c.falsePositiveAxisB).toBe(0);
    }
  });

  it('no category ends in FIXTURE_ERROR: every designed signal was observed', () => {
    for (const c of protocol.categories) {
      expect(c.verdict).not.toBe('FIXTURE_ERROR');
    }
  });

  it('a diverge-expected vector never produces SAME (FIXTURE_FAILURE semantics, never "parity won")', () => {
    for (const o of protocol.outcomes) {
      if (DIVERGE_A.includes(o.expectedAxisA)) {
        expect(o.axisACode).not.toBe('SAME_WINNER');
        expect(o.axisACode).not.toBe('BOTH_NO_MATCH');
      }
      if (DIVERGE_B.includes(o.expectedAxisB) || o.expectedAxisB === 'V2_ERROR') {
        expect(o.axisBCode).not.toBe('SAME');
      }
    }
  });

  it('X-1: V2_ERROR with engine_execution_error; Precedence silent NO_MATCH is a measured fact', () => {
    const x1 = protocol.outcomes.find((o) => o.caseId === 'X-1')!;
    expect(x1.axisBCode).toBe('V2_ERROR');
    expect(x1.v2ErrorCode).toBe('engine_execution_error');
    expect(x1.precedenceState).toBe('NO_MATCH');
  });

  it('never uses the dead label V2_PENDING_PRECEDENCE_MATCH as a signal', () => {
    for (const o of protocol.outcomes) {
      expect(o.axisBCode).not.toBe('V2_PENDING_PRECEDENCE_MATCH');
    }
  });

  it('R-1: input order [R-A, R-B] is load-bearing for the Legacy engine', () => {
    const tx = { description: 'mercado pago sa', amount: -100 };
    const forward = [toLegacyRule(RULES['R-A']!), toLegacyRule(RULES['R-B']!)];
    const reversed = [toLegacyRule(RULES['R-B']!), toLegacyRule(RULES['R-A']!)];
    expect(runLegacy(tx, forward).winnerId).toBe('R-A');
    expect(runLegacy(tx, reversed).winnerId).toBe('R-B');
  });

  it('emits the ephemeral report (console + temp JSON in os.tmpdir(), never in the repo)', () => {
    printReport();
    expect(tempDir).not.toBeNull();
    expect(tempFilePath).not.toBeNull();
    const dir = path.dirname(tempFilePath!);
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    expect(dir.includes(process.cwd())).toBe(false);

    const jsonText = fs.readFileSync(tempFilePath!, 'utf8');
    const report = JSON.parse(jsonText) as ReportJson;
    expect(report.axisA).toHaveLength(12);
    expect(report.axisB).toHaveLength(12);
    expect(report.categories).toHaveLength(6);
    expect(report.metrics.legacyPrecedenceAgreementRate).toBeCloseTo(11 / 12, 10);
    expect(report.metrics.v2PrecedenceAgreementRate).toBeCloseTo(10 / 12, 10);
    expect(report.metrics.v2ErrorRate).toBeCloseTo(1 / 12, 10);
    expect(report.metrics.precedenceErrorRate).toBe(0);
    expect(report.fixtureVersion).toMatch(/^fnv1a-/);
    expect(report.runId).toBeTruthy();

    for (const row of [...report.axisA, ...report.axisB]) {
      expect(row.ok).toBe(true);
    }
    const reportValues: string[] = [];
    collectStringValues(report, reportValues);
    const reportText = reportValues.join('\n');
    for (const v of VECTORS) {
      if (v.description.length >= 3) {
        expect(reportText).not.toContain(v.description);
      }
    }
    for (const id of Object.keys(RULES)) {
      expect(reportText).not.toContain(id);
    }
    expect(reportText).not.toContain(SYNTHETIC_GL);
    expect(reportText).not.toContain(COMPANY_ID);
  });
});

type ContractOperator = 'amount_gt' | 'amount_gte' | 'amount_lt' | 'amount_lte' | 'amount_eq' | 'amount_range';

interface ContractCase {
  caseId: string;
  operator: ContractOperator;
  value: number;
  range?: [number, number];
  amount: number;
  direction: 'debit' | 'credit' | 'any';
  expected: boolean;
  invariant: boolean;
}

const CONTRACT_CASES: ContractCase[] = [
  // amount_gt — value 100
  { caseId: 'GT-1', operator: 'amount_gt', value: 100, amount: -200, direction: 'debit', expected: true, invariant: false },
  { caseId: 'GT-2', operator: 'amount_gt', value: 100, amount: -100, direction: 'debit', expected: false, invariant: false },
  { caseId: 'GT-3', operator: 'amount_gt', value: 100, amount: 50, direction: 'credit', expected: false, invariant: false },
  { caseId: 'GT-4', operator: 'amount_gt', value: 100, amount: -150, direction: 'debit', expected: true, invariant: false },
  { caseId: 'GT-5', operator: 'amount_gt', value: 100, amount: -200, direction: 'credit', expected: false, invariant: true },
  // amount_gte — value 100
  { caseId: 'GTE-1', operator: 'amount_gte', value: 100, amount: -200, direction: 'debit', expected: true, invariant: false },
  { caseId: 'GTE-2', operator: 'amount_gte', value: 100, amount: -100, direction: 'debit', expected: true, invariant: false },
  { caseId: 'GTE-3', operator: 'amount_gte', value: 100, amount: 50, direction: 'credit', expected: false, invariant: false },
  { caseId: 'GTE-4', operator: 'amount_gte', value: 100, amount: -100, direction: 'debit', expected: true, invariant: false },
  { caseId: 'GTE-5', operator: 'amount_gte', value: 100, amount: -100, direction: 'credit', expected: false, invariant: true },
  // amount_lt — value 200
  { caseId: 'LT-1', operator: 'amount_lt', value: 200, amount: -150, direction: 'debit', expected: true, invariant: false },
  { caseId: 'LT-2', operator: 'amount_lt', value: 200, amount: -200, direction: 'debit', expected: false, invariant: false },
  { caseId: 'LT-3', operator: 'amount_lt', value: 200, amount: 250, direction: 'credit', expected: false, invariant: false },
  { caseId: 'LT-4', operator: 'amount_lt', value: 200, amount: -150, direction: 'debit', expected: true, invariant: false },
  { caseId: 'LT-5', operator: 'amount_lt', value: 200, amount: -150, direction: 'credit', expected: false, invariant: true },
  // amount_lte — value 200
  { caseId: 'LTE-1', operator: 'amount_lte', value: 200, amount: -150, direction: 'debit', expected: true, invariant: false },
  { caseId: 'LTE-2', operator: 'amount_lte', value: 200, amount: -200, direction: 'debit', expected: true, invariant: false },
  { caseId: 'LTE-3', operator: 'amount_lte', value: 200, amount: 250, direction: 'credit', expected: false, invariant: false },
  { caseId: 'LTE-4', operator: 'amount_lte', value: 200, amount: -200, direction: 'debit', expected: true, invariant: false },
  { caseId: 'LTE-5', operator: 'amount_lte', value: 200, amount: -200, direction: 'credit', expected: false, invariant: true },
  // amount_eq — value 150
  { caseId: 'EQ-1', operator: 'amount_eq', value: 150, amount: -150, direction: 'debit', expected: true, invariant: false },
  { caseId: 'EQ-2', operator: 'amount_eq', value: 150, amount: 150, direction: 'credit', expected: true, invariant: false },
  { caseId: 'EQ-3', operator: 'amount_eq', value: 150, amount: -149, direction: 'any', expected: false, invariant: false },
  { caseId: 'EQ-4', operator: 'amount_eq', value: 150, amount: -150, direction: 'any', expected: true, invariant: false },
  { caseId: 'EQ-5', operator: 'amount_eq', value: 150, amount: -150, direction: 'credit', expected: false, invariant: true },
  // amount_range — bounds [100,500] unless redefined
  { caseId: 'RNG-1', operator: 'amount_range', value: 0, range: [100, 500], amount: 200, direction: 'any', expected: true, invariant: false },
  { caseId: 'RNG-2', operator: 'amount_range', value: 0, range: [-500, -100], amount: -200, direction: 'any', expected: true, invariant: false },
  { caseId: 'RNG-3', operator: 'amount_range', value: 0, range: [500, 100], amount: 200, direction: 'any', expected: true, invariant: false },
  { caseId: 'RNG-4', operator: 'amount_range', value: 0, range: [150, 150], amount: -150, direction: 'any', expected: true, invariant: false },
  { caseId: 'RNG-5', operator: 'amount_range', value: 0, range: [150, 150], amount: -149, direction: 'any', expected: false, invariant: false },
  { caseId: 'RNG-6', operator: 'amount_range', value: 0, range: [100, 500], amount: 300, direction: 'any', expected: true, invariant: false },
  { caseId: 'RNG-7', operator: 'amount_range', value: 0, range: [100, 500], amount: 600, direction: 'any', expected: false, invariant: false },
  { caseId: 'RNG-8', operator: 'amount_range', value: 0, range: [100, 500], amount: 50, direction: 'any', expected: false, invariant: false },
  { caseId: 'RNG-9', operator: 'amount_range', value: 0, range: [100, 500], amount: -200, direction: 'debit', expected: true, invariant: false },
  { caseId: 'RNG-10', operator: 'amount_range', value: 0, range: [100, 500], amount: -200, direction: 'credit', expected: false, invariant: true },
];

function contractCondition(c: ContractCase): RuleCondition {
  if (c.operator === 'amount_range') {
    return { type: 'amount_range', value: 0, range: c.range };
  }
  return { type: c.operator, value: c.value };
}

function runContract(c: ContractCase): { execution: RuleEngineExecution; rule: BankRule } {
  const rule: BankRule = {
    id: c.caseId,
    companyId: COMPANY_ID,
    priority: 10,
    conditions: [contractCondition(c)],
    direction: c.direction,
    action: { glAccountId: SYNTHETIC_GL },
    isActive: true,
    lifecycleStatus: 'active',
  };
  const tx: Transaction = {
    id: `tx-${c.caseId}`,
    date: FIXED_DATE,
    description: 'contrato monto',
    amount: c.amount,
    bankAccountId: 'acc-synthetic',
    companyId: COMPANY_ID,
  };
  const execution = evaluateRulesPure({
    transaction: tx,
    context: {
      availableRules: [rule],
      entityContexts: [],
      historicalMatches: [],
      entityResolution: NOT_RUN_RESOLUTION,
    },
  });
  return { execution, rule };
}

function candidatesCollected(execution: RuleEngineExecution): number {
  for (const e of execution.trace?.events ?? []) {
    if (e.event === 'candidates_collected') return e.count;
  }
  return -1;
}

function amountConditionsEvaluated(execution: RuleEngineExecution): Extract<TraceEvent, { event: 'condition_evaluated' }>[] {
  return (execution.trace?.events ?? []).filter(
    (e): e is Extract<TraceEvent, { event: 'condition_evaluated' }> =>
      e.event === 'condition_evaluated' && e.conditionType.startsWith('amount_'),
  );
}

describe('BRE-006: amount semantics contract (magnitude)', () => {
  const operatorGroups: Array<{ operator: ContractOperator; group: string }> = [
    { operator: 'amount_gt', group: 'GT' },
    { operator: 'amount_gte', group: 'GTE' },
    { operator: 'amount_lt', group: 'LT' },
    { operator: 'amount_lte', group: 'LTE' },
    { operator: 'amount_eq', group: 'EQ' },
    { operator: 'amount_range', group: 'RNG' },
  ];

  for (const { operator, group } of operatorGroups) {
    it(`contract ${group}: magnitude semantics for ${operator}`, () => {
      const cases = CONTRACT_CASES.filter((c) => c.operator === operator);
      expect(cases.length).toBe(group === 'RNG' ? 10 : 5);
      for (const c of cases) {
        const { execution, rule } = runContract(c);
        const decision = execution.output.decision!;
        if (c.expected) {
          expect(decision.result, `${c.caseId}: expected match by magnitude`).toBe('winner');
          expect(decision.ruleId, `${c.caseId}: expected winner rule`).toBe(rule.id);
        } else {
          expect(decision.result, `${c.caseId}: expected no match`).toBe('no_match');
        }
        if (c.invariant) {
          expect(candidatesCollected(execution), `${c.caseId}: direction pre-filter discards before amount`).toBe(0);
        } else {
          expect(candidatesCollected(execution), `${c.caseId}: direction-compatible rule reaches amount evaluation`).toBe(1);
        }
      }
    });
  }

  it('contract invariants: contrary direction is discarded by the pre-filter BEFORE amount evaluation (GT-5, GTE-5, LT-5, LTE-5, EQ-5, RNG-10)', () => {
    const invariantCases = CONTRACT_CASES.filter((c) => c.invariant);
    expect(invariantCases.map((c) => c.caseId)).toEqual(['GT-5', 'GTE-5', 'LT-5', 'LTE-5', 'EQ-5', 'RNG-10']);

    for (const c of invariantCases) {
      const { execution } = runContract(c);
      const events = execution.trace?.events ?? [];
      const decision = execution.output.decision!;

      expect(decision.result, `${c.caseId}: contrary direction yields no match`).toBe('no_match');

      const collected = events.filter((e) => e.event === 'candidates_collected');
      expect(collected, `${c.caseId}: candidates_collected trace event exists`).toHaveLength(1);
      expect(candidatesCollected(execution), `${c.caseId}: zero candidates after direction pre-filter`).toBe(0);

      const evaluated = events.filter((e) => e.event === 'condition_evaluated');
      expect(evaluated, `${c.caseId}: zero conditions evaluated (discard precedes conditions/amount.ts)`).toHaveLength(0);
      expect(amountConditionsEvaluated(execution), `${c.caseId}: zero amount_* conditions evaluated`).toHaveLength(0);
    }
  });
});
