import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
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

const SYNTHETIC_GL = 'gl-synthetic-001';
const NOT_RUN_RESOLUTION: EntityResolution = { status: 'not_run' };
const EXPECTED_SCRUBBER_VERSION = 'bre010-scrub-1.0.0';
const STRING_CANARY = 'BRE010_CANARY_STR_9f1c2d3e';
const NUMERIC_CANARY = '424242.42';
const DEAD_LABEL: DivergenceType = 'V2_PENDING_PRECEDENCE_MATCH';

type RuleKind = 'real' | 'control' | 'trap';

function isSyntheticRuleId(id: string): boolean {
  return id.startsWith('ctrl-');
}

function isRealRule(r: { ruleKind?: RuleKind; id: string }): boolean {
  return r.ruleKind === undefined ? !isSyntheticRuleId(r.id) : r.ruleKind === 'real';
}

type Direction = 'any' | 'debit' | 'credit';
type Category = 'control' | 'direccion' | 'monto' | 'wildcard' | 'ranking' | 'regex';
type RepresentationOrigin = 'json' | 'legacy' | 'both';

interface LegacyReverseMapView {
  kind: 'reverseMap';
  items: Array<{ field: string; operator: string; value: string | number }>;
}

interface LegacyPassthroughView {
  kind: 'passthrough';
  conditionType: string;
  conditionValue: string;
}

type LegacyView = LegacyReverseMapView | LegacyPassthroughView;

interface V2CanonicalView {
  kind: 'canonical';
  conditions: RuleCondition[];
}

interface V2StoredView {
  kind: 'stored';
  conditions: null;
}

type V2View = V2CanonicalView | V2StoredView;

interface FixtureRule {
  id: string;
  name: string;
  companyId: string;
  priority: number;
  transactionDirection: Direction;
  representationOrigin: RepresentationOrigin;
  ruleKind?: RuleKind;
  conditions: RuleCondition[];
  legacyView: LegacyView;
  v2View: V2View;
}

interface FixtureVector {
  caseId: string;
  category?: Category;
  ruleIds: string[];
  description: string;
  amount: number;
  expectedAxisA?: ShadowComparison;
  expectedAxisB?: DivergenceType;
}

interface FixtureMetadata {
  totalRulesRead: number;
  activeRuleCount: number;
  inactiveRuleCount: number;
  conditionTypeDistribution: Record<string, number>;
  representationOriginCounts: Record<string, number>;
  corruptConditionCount: number;
  scrubAbortReasons: string[];
  wildcardRuleCount: number;
  regexRuleCount: number;
  invalidRegexRuleCount: number;
  multiConditionRuleCount: number;
  overlappingRuleCount: number;
  priorityBandDistribution: Record<string, number>;
}

interface Fixture {
  protocol: string;
  scrubberVersion: string;
  fixtureHash: string;
  gitCommit: string;
  runId: string;
  companyId: string;
  fixedDate: string;
  rules: FixtureRule[];
  vectors: FixtureVector[];
  controls: FixtureVector[];
  metadata: FixtureMetadata;
}

const AGREE_A: readonly ShadowComparison[] = ['SAME_WINNER', 'BOTH_NO_MATCH'];
const DIVERGE_A: readonly ShadowComparison[] = [
  'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH',
  'PRODUCTIVE_NO_MATCH_CANONICAL_MATCH',
  'DIFFERENT_WINNER',
  'CANONICAL_AMBIGUOUS',
];
const AGREE_B: DivergenceType = 'SAME';
const DIVERGE_B: readonly DivergenceType[] = [
  'DIFFERENT_WINNER',
  'V2_MATCH_PRECEDENCE_NO_MATCH',
  'V2_NO_MATCH_PRECEDENCE_MATCH',
];
const ERROR_B: DivergenceType = 'V2_ERROR';
const CATEGORIES: readonly Category[] = ['control', 'direccion', 'monto', 'wildcard', 'ranking', 'regex'];
const DESCRIPTION_TYPES = new Set([
  'description_contains',
  'description_starts_with',
  'description_ends_with',
  'description_eq',
]);

let fixture: Fixture | null = null;
let fixtureText = '';
let failClosedProblems: string[] = [];
let measurement: MeasurementResult | null = null;
let report: Bre010Report | null = null;
let tempDir: string | null = null;
let tempFilePath: string | null = null;
let capturedStdout: string[] = [];
let capturedConsole: string[] = [];
let runError: string | null = null;
let canaryGateClean = false;
let controlsPass = false;
let invariantsHold = false;
let envAbortReason: string | null = null;

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

function canaryHits(text: string): string[] {
  const hits: string[] = [];
  if (text.includes(STRING_CANARY)) hits.push(STRING_CANARY);
  if (text.includes(NUMERIC_CANARY)) hits.push(NUMERIC_CANARY);
  return hits;
}

function validateFixture(f: Fixture): string[] {
  const problems: string[] = [];
  if (f.protocol !== 'BRE-010') {
    problems.push(`protocol must be "BRE-010" (got ${String(f.protocol)})`);
  }
  if (f.scrubberVersion !== EXPECTED_SCRUBBER_VERSION) {
    problems.push(
      `scrubberVersion mismatch: fixture=${f.scrubberVersion} expected=${EXPECTED_SCRUBBER_VERSION} (stale fixture replay, spec 7.4 #3)`,
    );
  }
  if (!Array.isArray(f.rules) || f.rules.length === 0) {
    problems.push('fixture.rules must be a non-empty array');
  }
  if (!Array.isArray(f.vectors)) {
    problems.push('fixture.vectors must be an array');
  }
  if (!Array.isArray(f.controls)) {
    problems.push('fixture.controls must be an array');
  }
  if (!f.metadata || typeof f.metadata !== 'object') {
    problems.push('fixture.metadata must be an object');
    return problems;
  }
  if (f.metadata.activeRuleCount === 0) {
    problems.push('dataset floor: activeRuleCount == 0, nothing to measure (spec 7.4 #7)');
  }
  if (f.metadata.corruptConditionCount !== 0) {
    problems.push(`corruptConditionCount must be 0 (got ${f.metadata.corruptConditionCount})`);
  }
  if (Array.isArray(f.metadata.scrubAbortReasons) && f.metadata.scrubAbortReasons.length > 0) {
    problems.push('scrubAbortReasons must be empty (any abort means the fixture is unusable)');
  }
  for (const rule of f.rules) {
    const origin = rule.representationOrigin;
    if (!['json', 'legacy', 'both'].includes(origin)) {
      problems.push(`rule ${rule.id}: invalid representationOrigin "${String(origin)}"`);
      continue;
    }
    const legacyKind = rule.legacyView?.kind;
    const v2Kind = rule.v2View?.kind;
    if (origin === 'legacy') {
      if (legacyKind !== 'passthrough') {
        problems.push(`rule ${rule.id}: legacyView.kind "${String(legacyKind)}" contradicts origin legacy`);
      }
      if (v2Kind !== 'stored') {
        problems.push(`rule ${rule.id}: v2View.kind "${String(v2Kind)}" contradicts origin legacy`);
      }
      if (
        legacyKind === 'passthrough' &&
        (typeof rule.legacyView.conditionType !== 'string' ||
          typeof rule.legacyView.conditionValue !== 'string')
      ) {
        problems.push(`rule ${rule.id}: passthrough view must carry conditionType/conditionValue`);
      }
      if (v2Kind === 'stored' && rule.v2View.conditions !== null) {
        problems.push(`rule ${rule.id}: stored view must carry conditions: null (never the synthesized canonical)`);
      }
    } else {
      if (legacyKind !== 'reverseMap') {
        problems.push(`rule ${rule.id}: legacyView.kind "${String(legacyKind)}" contradicts origin ${origin}`);
      }
      if (v2Kind !== 'canonical') {
        problems.push(`rule ${rule.id}: v2View.kind "${String(v2Kind)}" contradicts origin ${origin}`);
      }
      if (legacyKind === 'reverseMap' && !Array.isArray(rule.legacyView.items)) {
        problems.push(`rule ${rule.id}: reverseMap view must carry items`);
      }
      if (v2Kind === 'canonical' && !Array.isArray(rule.v2View.conditions)) {
        problems.push(`rule ${rule.id}: canonical v2 view must carry conditions`);
      }
    }
  }
  return problems;
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

function toV2Rule(rule: FixtureRule, f: Fixture): PrismaBankRule {
  return {
    id: rule.id,
    companyId: f.companyId,
    priority: rule.priority,
    conditions: rule.v2View.conditions,
    transactionDirection: rule.transactionDirection,
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
  companyId: string,
): LegacyOutcome {
  const matching = rules.filter((rule) => transactionMatchesRule(tx, rule, [], false));
  if (matching.length === 0) {
    return { state: 'NO_MATCH', winnerId: null };
  }
  const winner = evaluateWinningRule(matching, tx, companyId, {}, []);
  return { state: 'WINNER', winnerId: winner?.id ?? null };
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

function uniqueConditionTypes(ruleIds: string[], f: Fixture): string[] {
  const types = new Set<string>();
  for (const id of ruleIds) {
    const rule = f.rules.find((r) => r.id === id);
    if (rule) {
      for (const cond of rule.conditions) {
        types.add(cond.type);
      }
    }
  }
  return Array.from(types);
}

interface MeasuredVector {
  caseId: string;
  category: Category;
  isControl: boolean;
  ruleIds: string[];
  ruleOrigins: string[];
  conditionTypes: string[];
  legacyState: 'WINNER' | 'NO_MATCH';
  precedenceState: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
  v2State: 'matched' | 'pending';
  v2ErrorCode?: string;
  axisACode: ShadowComparison;
  axisBCode: DivergenceType;
  expectedAxisA?: ShadowComparison;
  expectedAxisB?: DivergenceType;
}

function measureVector(v: FixtureVector, f: Fixture, contexts: Map<string, PrismaBankRule>): MeasuredVector {
  const rules = v.ruleIds.map((id) => {
    const rule = f.rules.find((r) => r.id === id);
    if (!rule) throw new Error(`vector ${v.caseId} references unknown rule id ${id}`);
    return rule;
  });

  const legacyRules = rules.map(toLegacyRule);
  const precedenceRules = rules.map(toPrecedenceRule);
  const v2Rules = v.ruleIds.map((id) => {
    const ctx = contexts.get(id);
    if (!ctx) throw new Error(`vector ${v.caseId} references unknown rule id ${id}`);
    return ctx;
  });

  const fixedDate = new Date(f.fixedDate);
  const legacyTx = { description: v.description, amount: v.amount };
  const precedenceTx: RulePrecedenceTransaction = {
    id: `tx-${v.caseId}`,
    date: fixedDate,
    description: v.description,
    amount: v.amount,
  };
  const v2Tx: ParsedTransaction = {
    id: `tx-${v.caseId}`,
    date: fixedDate,
    description: v.description,
    amount: v.amount,
    bankAccountId: 'acc-synthetic',
  };

  const legacy = runLegacy(legacyTx, legacyRules, f.companyId);
  const precedence = runPrecedence(precedenceTx, precedenceRules);
  const rawV2 = runRuleEngineV2Shadow(v2Tx, v2Rules, NOT_RUN_RESOLUTION, f.companyId);
  const v2Result = toV2Result(rawV2);

  const axisAResult = compareRuleDecisions(precedenceTx, precedenceRules, legacy.winnerId);
  const precedenceResult: PrecedenceEngineResult = {
    reason: precedence.state,
    winnerRuleId: precedence.winnerId,
    ambiguous: precedence.ambiguous,
  };
  const axisBCode = classifyDivergence(v2Result, precedenceResult);

  return {
    caseId: v.caseId,
    category: v.category ?? 'control',
    isControl: v.expectedAxisA !== undefined,
    ruleIds: v.ruleIds,
    ruleOrigins: rules.map((r) => r.representationOrigin),
    conditionTypes: uniqueConditionTypes(v.ruleIds, f),
    legacyState: legacy.state,
    precedenceState: precedence.state,
    v2State: v2Result.outcome,
    ...(rawV2.outcome === 'pending' && rawV2.errorCode ? { v2ErrorCode: rawV2.errorCode } : {}),
    axisACode: axisAResult.comparison,
    axisBCode,
    ...(v.expectedAxisA !== undefined ? { expectedAxisA: v.expectedAxisA, expectedAxisB: v.expectedAxisB } : {}),
  };
}

interface Metrics {
  axisAAgree: number;
  axisADivergence: number;
  axisATotal: number;
  axisAAgreementRate: number;
  axisBAgree: number;
  axisBDivergence: number;
  axisBErrorCount: number;
  axisBTotal: number;
  axisBAgreementRate: number;
  v2ErrorRate: number;
  precedenceErrorRate: number;
}

interface CategoryStats {
  category: Category;
  vectors: number;
  agreeA: number;
  divergeA: number;
  agreeB: number;
  divergeB: number;
  errorB: number;
  rateA: number;
  rateB: number;
}

interface PerBre {
  bre011: {
    wildcardRuleCount: number;
    wildcardPrevalence: number;
    wildcardVectorCount: number;
    wildcardAxisADivergenceCount: number;
    wildcardAxisADivergenceRate: number;
  };
  bre012: {
    multiConditionRuleCount: number;
    overlappingRuleCount: number;
    priorityBandDistribution: Record<string, number>;
    rankingVectorCount: number;
    axisBDifferentWinnerCount: number;
    axisBDifferentWinnerRate: number;
    axisADifferentWinnerCount: number;
    axisADifferentWinnerRate: number;
    disagreementByPriorityBand: Record<string, number>;
  };
  bre013: {
    regexRuleCount: number;
    invalidRegexRuleCount: number;
    axisBErrorCount: number;
    v2ErrorRate: number;
    errorCodeDistribution: { conditions_normalization_failed: number; engine_execution_error: number };
    normalizationFailureCount: number;
    legacyOnlyV2ErrorCount: number;
  };
}

interface MeasurementResult {
  outcomes: MeasuredVector[];
  metrics: Metrics;
  categories: CategoryStats[];
  perBre: PerBre;
  controlFailures: string[];
  invariantsHold: boolean;
}

function priorityBand(priority: number): string {
  if (priority <= 10) return '1-10';
  if (priority <= 50) return '11-50';
  if (priority <= 100) return '51-100';
  return '100+';
}

function computeMetrics(outcomes: MeasuredVector[]): Metrics {
  const total = outcomes.length;
  const axisAAgree = outcomes.filter((o) => AGREE_A.includes(o.axisACode)).length;
  const axisADivergence = outcomes.filter((o) => DIVERGE_A.includes(o.axisACode)).length;
  const axisBAgree = outcomes.filter((o) => o.axisBCode === AGREE_B).length;
  const axisBDivergence = outcomes.filter((o) => DIVERGE_B.includes(o.axisBCode)).length;
  const axisBErrorCount = outcomes.filter((o) => o.axisBCode === ERROR_B).length;
  return {
    axisAAgree,
    axisADivergence,
    axisATotal: total,
    axisAAgreementRate: total === 0 ? 0 : axisAAgree / total,
    axisBAgree,
    axisBDivergence,
    axisBErrorCount,
    axisBTotal: total,
    axisBAgreementRate: total === 0 ? 0 : axisBAgree / total,
    v2ErrorRate: total === 0 ? 0 : axisBErrorCount / total,
    precedenceErrorRate: 0,
  };
}

function computeCategories(outcomes: MeasuredVector[]): CategoryStats[] {
  return CATEGORIES.map((category) => {
    const vecs = outcomes.filter((o) => o.category === category);
    const agreeA = vecs.filter((o) => AGREE_A.includes(o.axisACode)).length;
    const divergeA = vecs.filter((o) => DIVERGE_A.includes(o.axisACode)).length;
    const agreeB = vecs.filter((o) => o.axisBCode === AGREE_B).length;
    const divergeB = vecs.filter((o) => DIVERGE_B.includes(o.axisBCode)).length;
    const errorB = vecs.filter((o) => o.axisBCode === ERROR_B).length;
    return {
      category,
      vectors: vecs.length,
      agreeA,
      divergeA,
      agreeB,
      divergeB,
      errorB,
      rateA: vecs.length === 0 ? 0 : agreeA / vecs.length,
      rateB: vecs.length === 0 ? 0 : agreeB / vecs.length,
    };
  });
}

function computePerBre(f: Fixture, outcomes: MeasuredVector[]): PerBre {
  const wildcardRules = f.rules.filter((r) =>
    r.conditions.some((c) => DESCRIPTION_TYPES.has(c.type) && String(c.value) === '*'),
  );
  const wildcardRuleCount = wildcardRules.length;
  const activeRuleCount = f.metadata.activeRuleCount;
  const wildcardVectorCount = outcomes.filter(
    (o) => !o.isControl && o.ruleIds.some((id) => wildcardRules.some((r) => r.id === id)),
  ).length;
  const wildcardAxisADivergenceCount = outcomes.filter(
    (o) =>
      !o.isControl &&
      o.ruleIds.some((id) => wildcardRules.some((r) => r.id === id)) &&
      o.axisACode === 'PRODUCTIVE_MATCH_CANONICAL_NO_MATCH',
  ).length;

  const multiConditionRuleCount = f.rules.filter(
    (r) => isRealRule(r) && r.conditions.length >= 2,
  ).length;
  const rankingVectorCount = outcomes.filter((o) => o.category === 'ranking').length;
  const axisBDifferentWinnerCount = outcomes.filter((o) => o.axisBCode === 'DIFFERENT_WINNER').length;
  const axisADifferentWinnerCount = outcomes.filter((o) => o.axisACode === 'DIFFERENT_WINNER').length;
  const total = outcomes.length;
  const disagreementByPriorityBand: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.axisBCode !== 'DIFFERENT_WINNER' && o.axisACode !== 'DIFFERENT_WINNER') continue;
    const priorities = o.ruleIds.map((id) => f.rules.find((r) => r.id === id)?.priority ?? 0);
    const band = priorityBand(Math.min(...priorities));
    disagreementByPriorityBand[band] = (disagreementByPriorityBand[band] ?? 0) + 1;
  }

  const regexRuleCount = f.rules.filter((r) =>
    r.conditions.some((c) => c.type === 'description_matches'),
  ).length;
  const invalidRegexRuleCount = f.rules.filter((r) =>
    r.conditions.some((c) => c.type === 'description_matches' && String(c.value) === '['),
  ).length;
  const axisBErrorCount = outcomes.filter((o) => o.axisBCode === ERROR_B).length;
  const errorCodeDistribution: PerBre['bre013']['errorCodeDistribution'] = {
    conditions_normalization_failed: 0,
    engine_execution_error: 0,
  };
  for (const o of outcomes) {
    if (o.axisBCode === ERROR_B && o.v2ErrorCode === 'conditions_normalization_failed') {
      errorCodeDistribution.conditions_normalization_failed += 1;
    } else if (o.axisBCode === ERROR_B && o.v2ErrorCode === 'engine_execution_error') {
      errorCodeDistribution.engine_execution_error += 1;
    }
  }
  const normalizationFailureCount = outcomes.filter(
    (o) => o.axisBCode === ERROR_B && o.v2ErrorCode === 'conditions_normalization_failed',
  ).length;
  const legacyOnlyV2ErrorCount = outcomes.filter(
    (o) => o.axisBCode === ERROR_B && o.ruleOrigins.includes('legacy'),
  ).length;

  return {
    bre011: {
      wildcardRuleCount,
      wildcardPrevalence: activeRuleCount === 0 ? 0 : wildcardRuleCount / activeRuleCount,
      wildcardVectorCount,
      wildcardAxisADivergenceCount,
      wildcardAxisADivergenceRate:
        wildcardVectorCount === 0 ? 0 : wildcardAxisADivergenceCount / wildcardVectorCount,
    },
    bre012: {
      multiConditionRuleCount,
      overlappingRuleCount: f.metadata.overlappingRuleCount,
      priorityBandDistribution: { ...f.metadata.priorityBandDistribution },
      rankingVectorCount,
      axisBDifferentWinnerCount,
      axisBDifferentWinnerRate: total === 0 ? 0 : axisBDifferentWinnerCount / total,
      axisADifferentWinnerCount,
      axisADifferentWinnerRate: total === 0 ? 0 : axisADifferentWinnerCount / total,
      disagreementByPriorityBand,
    },
    bre013: {
      regexRuleCount,
      invalidRegexRuleCount,
      axisBErrorCount,
      v2ErrorRate: total === 0 ? 0 : axisBErrorCount / total,
      errorCodeDistribution,
      normalizationFailureCount,
      legacyOnlyV2ErrorCount,
    },
  };
}

function runMeasurement(f: Fixture): MeasurementResult {
  const contexts = new Map<string, PrismaBankRule>();
  for (const rule of f.rules) {
    contexts.set(rule.id, toV2Rule(rule, f));
  }

  const outcomes: MeasuredVector[] = [];
  for (const v of f.vectors) {
    outcomes.push(measureVector(v, f, contexts));
  }
  for (const c of f.controls) {
    outcomes.push(measureVector(c, f, contexts));
  }

  const metrics = computeMetrics(outcomes);
  const categories = computeCategories(outcomes);
  const perBre = computePerBre(f, outcomes);

  const controlFailures = outcomes
    .filter(
      (o) =>
        o.expectedAxisA !== undefined &&
        (o.axisACode !== o.expectedAxisA || o.axisBCode !== o.expectedAxisB),
    )
    .map((o) => o.caseId);

  const invariantsHold =
    metrics.axisAAgree + metrics.axisADivergence === metrics.axisATotal &&
    metrics.axisBAgree + metrics.axisBDivergence + metrics.axisBErrorCount === metrics.axisBTotal &&
    outcomes.every((o) => o.axisBCode !== DEAD_LABEL) &&
    outcomes
      .filter((o) => o.axisBCode === ERROR_B)
      .every((o) => !DIVERGE_B.includes(o.axisBCode) && o.axisBCode !== AGREE_B);

  return { outcomes, metrics, categories, perBre, controlFailures, invariantsHold };
}

interface Bre010Report {
  protocol: string;
  scrubberVersion: string;
  fixtureHash: string;
  gitCommit: string;
  runId: string;
  fixedDate: string;
  companyId: string;
  runValid: boolean;
  parityVerdict: 'EMITTED' | 'SUPPRESSED';
  runErrors: string[];
  controlFailures: string[];
  canaryGateClean: boolean;
  invariantsHold: boolean;
  failClosedProblems: string[];
  totalVectors: number;
  realRuleVectors: number;
  controlVectors: number;
  metrics: Metrics;
  categories: CategoryStats[];
  perBre: PerBre;
  dataQuality: {
    totalRulesRead: number;
    activeRuleCount: number;
    inactiveRuleCount: number;
    conditionTypeDistribution: Record<string, number>;
    representationOriginCounts: Record<string, number>;
    corruptConditionCount: number;
    scrubAbortReasons: string[];
    fixtureHash: string;
    scrubberVersion: string;
    gitCommit: string;
    runId: string;
    fixedDate: string;
  };
  outcomes: Array<{
    caseId: string;
    category: Category;
    conditionTypes: string[];
    legacyState: 'WINNER' | 'NO_MATCH';
    precedenceState: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
    axisACode: ShadowComparison;
    axisBCode: DivergenceType;
    v2ErrorCode?: string;
  }>;
  controlOutcomes: Array<{
    caseId: string;
    axisACode: ShadowComparison;
    expectedAxisA: ShadowComparison;
    axisBCode: DivergenceType;
    expectedAxisB: DivergenceType;
    ok: boolean;
  }>;
}

function buildReport(f: Fixture, m: MeasurementResult): Bre010Report {
  const outcomes = m.outcomes.map((o) => ({
    caseId: o.caseId,
    category: o.category,
    conditionTypes: o.conditionTypes,
    legacyState: o.legacyState,
    precedenceState: o.precedenceState,
    axisACode: o.axisACode,
    axisBCode: o.axisBCode,
    ...(o.v2ErrorCode !== undefined ? { v2ErrorCode: o.v2ErrorCode } : {}),
  }));
  const controlOutcomes = m.outcomes
    .filter((o) => o.expectedAxisA !== undefined)
    .map((o) => ({
      caseId: o.caseId,
      axisACode: o.axisACode,
      expectedAxisA: o.expectedAxisA as ShadowComparison,
      axisBCode: o.axisBCode,
      expectedAxisB: o.expectedAxisB as DivergenceType,
      ok: o.axisACode === o.expectedAxisA && o.axisBCode === o.expectedAxisB,
    }));

  const controlsPassLocal = m.controlFailures.length === 0;
  const runValid =
    controlsPassLocal && canaryGateClean && m.invariantsHold && failClosedProblems.length === 0;

  return {
    protocol: f.protocol,
    scrubberVersion: f.scrubberVersion,
    fixtureHash: f.fixtureHash,
    gitCommit: f.gitCommit,
    runId: f.runId,
    fixedDate: f.fixedDate,
    companyId: f.companyId,
    runValid,
    parityVerdict: runValid ? 'EMITTED' : 'SUPPRESSED',
    runErrors: runError !== null ? [runError] : [],
    controlFailures: m.controlFailures,
    canaryGateClean,
    invariantsHold: m.invariantsHold,
    failClosedProblems,
    totalVectors: m.outcomes.length,
    realRuleVectors: f.vectors.length,
    controlVectors: f.controls.length,
    metrics: m.metrics,
    categories: m.categories,
    perBre: m.perBre,
    dataQuality: {
      totalRulesRead: f.metadata.totalRulesRead,
      activeRuleCount: f.metadata.activeRuleCount,
      inactiveRuleCount: f.metadata.inactiveRuleCount,
      conditionTypeDistribution: { ...f.metadata.conditionTypeDistribution },
      representationOriginCounts: { ...f.metadata.representationOriginCounts },
      corruptConditionCount: f.metadata.corruptConditionCount,
      scrubAbortReasons: [...f.metadata.scrubAbortReasons],
      fixtureHash: f.fixtureHash,
      scrubberVersion: f.scrubberVersion,
      gitCommit: f.gitCommit,
      runId: f.runId,
      fixedDate: f.fixedDate,
    },
    outcomes,
    controlOutcomes,
  };
}

function sweepText(): string {
  const parts: string[] = [];
  if (fixtureText) {
    parts.push(fixtureText);
  }
  if (report) {
    const values: string[] = [];
    collectStringValues(report, values);
    parts.push(values.join('\n'));
  }
  if (tempFilePath && fs.existsSync(tempFilePath)) {
    parts.push(fs.readFileSync(tempFilePath, 'utf8'));
  }
  parts.push(capturedStdout.join(''));
  parts.push(capturedConsole.join(''));
  if (runError) {
    parts.push(runError);
  }
  return parts.join('\n');
}

function installCaptureSpies(): void {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const stdoutSpy = vi.spyOn(process.stdout, 'write');
  (stdoutSpy as unknown as { mockImplementation: (fn: (...args: unknown[]) => boolean) => void }).mockImplementation(
    (chunk: unknown, ...rest: unknown[]) => {
      capturedStdout.push(String(chunk));
      return (originalStdoutWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    },
  );

  const originalConsoleError = console.error.bind(console);
  const errorSpy = vi.spyOn(console, 'error');
  (errorSpy as unknown as { mockImplementation: (fn: (...args: unknown[]) => void) => void }).mockImplementation(
    (...args: unknown[]) => {
      capturedConsole.push(args.map(String).join(' '));
      (originalConsoleError as (...args: unknown[]) => void)(...args);
    },
  );

  const originalConsoleWarn = console.warn.bind(console);
  const warnSpy = vi.spyOn(console, 'warn');
  (warnSpy as unknown as { mockImplementation: (fn: (...args: unknown[]) => void) => void }).mockImplementation(
    (...args: unknown[]) => {
      capturedConsole.push(args.map(String).join(' '));
      (originalConsoleWarn as (...args: unknown[]) => void)(...args);
    },
  );

  const originalConsoleLog = console.log.bind(console);
  const logSpy = vi.spyOn(console, 'log');
  (logSpy as unknown as { mockImplementation: (fn: (...args: unknown[]) => void) => void }).mockImplementation(
    (...args: unknown[]) => {
      capturedConsole.push(args.map(String).join(' '));
      (originalConsoleLog as (...args: unknown[]) => void)(...args);
    },
  );
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printReport(): void {
  if (!report || !measurement) return;
  const out = (line: string): void => {
    process.stdout.write(line + '\n');
  };

  out('\n' + '='.repeat(76));
  out('BRE-010 SCRUBBED REAL-RULE CONFORMANCE MEASUREMENT — PARITY REPORT');
  out('='.repeat(76));
  out(`protocol       : ${report.protocol}`);
  out(`scrubberVersion: ${report.scrubberVersion}`);
  out(`fixtureHash    : ${report.fixtureHash}`);
  out(`git commit     : ${report.gitCommit}`);
  out(`runId          : ${report.runId}`);
  out(`fixedDate      : ${report.fixedDate}`);
  out(
    `runValid       : ${report.runValid}` +
      (report.runValid ? '' : ` INVALID — no parity verdict emitted`),
  );
  out(`parityVerdict  : ${report.parityVerdict}`);
  out(`temp JSON      : ${tempFilePath ?? '(none)'}`);
  if (report.runErrors.length > 0) {
    out(`run errors     : ${report.runErrors.join('; ')}`);
  }
  if (report.controlFailures.length > 0) {
    out(`control failures: ${report.controlFailures.join(',')}`);
  }
  out('');

  out('Cross-cutting conformance rates (exact, no sampling)');
  const m = report.metrics;
  out(`totalVectors   : ${report.totalVectors} (real=${report.realRuleVectors}, control=${report.controlVectors})`);
  out(`Axis A agree   : ${m.axisAAgree}/${m.axisATotal} (${(m.axisAAgreementRate * 100).toFixed(1)}%)`);
  out(`Axis A diverge : ${m.axisADivergence}/${m.axisATotal}`);
  out(`Axis B agree   : ${m.axisBAgree}/${m.axisBTotal} (${(m.axisBAgreementRate * 100).toFixed(1)}%)`);
  out(`Axis B diverge : ${m.axisBDivergence}/${m.axisBTotal}`);
  out(`Axis B error   : ${m.axisBErrorCount}/${m.axisBTotal} (v2ErrorRate ${(m.v2ErrorRate * 100).toFixed(1)}%)`);
  out(`precedenceErrorRate: ${m.precedenceErrorRate} (fact: Precedence fails silent, never errors)`);
  out('');

  out('Per-category (6)');
  out(
    pad('category', 12) +
      pad('vectors', 8) +
      pad('agreeA', 7) +
      pad('divergeA', 9) +
      pad('rateA', 7) +
      pad('agreeB', 7) +
      pad('divergeB', 9) +
      pad('errorB', 7) +
      pad('rateB', 7),
  );
  for (const c of report.categories) {
    out(
      pad(c.category, 12) +
        pad(String(c.vectors), 8) +
        pad(String(c.agreeA), 7) +
        pad(String(c.divergeA), 9) +
        pad(`${(c.rateA * 100).toFixed(1)}%`, 7) +
        pad(String(c.agreeB), 7) +
        pad(String(c.divergeB), 9) +
        pad(String(c.errorB), 7) +
        pad(`${(c.rateB * 100).toFixed(1)}%`, 7),
    );
  }
  out('');

  out('Per-BRE metrics');
  const pb = report.perBre;
  out(
    `BRE-011 wildcard: rules=${pb.bre011.wildcardRuleCount} prevalence=${(pb.bre011.wildcardPrevalence * 100).toFixed(1)}% vectors=${pb.bre011.wildcardVectorCount} axisA-divRate=${(pb.bre011.wildcardAxisADivergenceRate * 100).toFixed(1)}%`,
  );
  out(
    `BRE-012 ranking : multiCond=${pb.bre012.multiConditionRuleCount} overlapping=${pb.bre012.overlappingRuleCount} rankingVectors=${pb.bre012.rankingVectorCount} axisB-diffWinner=${pb.bre012.axisBDifferentWinnerCount} (${(pb.bre012.axisBDifferentWinnerRate * 100).toFixed(1)}%) axisA-diffWinner=${pb.bre012.axisADifferentWinnerCount} (${(pb.bre012.axisADifferentWinnerRate * 100).toFixed(1)}%)`,
  );
  out(
    `BRE-013 errors  : regex=${pb.bre013.regexRuleCount} invalidRegex=${pb.bre013.invalidRegexRuleCount} v2Errors=${pb.bre013.axisBErrorCount} (${(pb.bre013.v2ErrorRate * 100).toFixed(1)}%) legacyOnly=${pb.bre013.legacyOnlyV2ErrorCount} codeDist=${JSON.stringify(pb.bre013.errorCodeDistribution)}`,
  );
  out('');

  out('Controls (pre-designed axis codes)');
  out(
    pad('caseId', 22) + pad('axisA', 40) + pad('expectedA', 40) + pad('axisB', 40) + pad('expectedB', 40) + 'result',
  );
  for (const c of report.controlOutcomes) {
    out(
      pad(c.caseId, 22) +
        pad(c.axisACode, 40) +
        pad(c.expectedAxisA, 40) +
        pad(c.axisBCode, 40) +
        pad(c.expectedAxisB, 40) +
        (c.ok ? 'PASS' : 'FAIL'),
    );
  }
  out('='.repeat(76));
}

beforeAll(() => {
  const fixturePath = process.env.BRE010_FIXTURE_PATH;
  if (!fixturePath || fixturePath.trim() === '') {
    envAbortReason =
      'BRE010_FIXTURE_PATH is unset/absent/empty — skipping (no fixture available).';
    return;
  }

  fixtureText = fs.readFileSync(fixturePath, 'utf8');
  fixture = JSON.parse(fixtureText) as Fixture;

  installCaptureSpies();

  const fixtureValues: string[] = [];
  collectStringValues(fixture, fixtureValues);
  const fixtureHits = canaryHits(fixtureValues.join('\n'));
  if (fixtureHits.length > 0) {
    throw new Error(`fixture contains canary sentinel(s) before measurement: ${fixtureHits.join(', ')}`);
  }

  failClosedProblems = validateFixture(fixture);

  try {
    measurement = runMeasurement(fixture);
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  }

  if (measurement) {
    controlsPass = measurement.controlFailures.length === 0;
    invariantsHold = measurement.invariantsHold;
    const dir = path.join(os.tmpdir(), `bre010-${fixture.runId}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDir = dir;
    tempFilePath = path.join(dir, 'report.json');
    report = buildReport(fixture, measurement);
    fs.writeFileSync(tempFilePath, JSON.stringify(report, null, 2), 'utf8');
    canaryGateClean = canaryHits(sweepText()).length === 0;
    report = buildReport(fixture, measurement);
    fs.writeFileSync(tempFilePath, JSON.stringify(report, null, 2), 'utf8');
  }
});

afterAll(() => {
  if (tempDir !== null) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup (spec 7.5)
    }
    tempDir = null;
    tempFilePath = null;
  }
  vi.restoreAllMocks();
});

// When BRE010_FIXTURE_PATH is unavailable, skip the entire suite instead of failing.
// BRE-010 is a manual benchmark: fixture is generated via scripts/bre010-extract.mjs
// against a live dev DB and is never committed. Without it, no measurement is possible.
const describeFixture = process.env.BRE010_FIXTURE_PATH?.trim() ? describe : describe.skip;

describeFixture('BRE-010: hermetic real-rule parity harness (Phase 2) [skipped: manual fixture not provided — run scripts/bre010-extract.mjs]', () => {
  it('fixture was loaded from BRE010_FIXTURE_PATH and is a BRE-010 fixture', () => {
    expect(envAbortReason).toBeNull();
    expect(fixture).not.toBeNull();
    expect(fixture!.protocol).toBe('BRE-010');
    expect(fixture!.scrubberVersion).toBe(EXPECTED_SCRUBBER_VERSION);
  });

  it('fixture shape validation passes: provenance, dataset floor, zero corrupt/abort', () => {
    expect(failClosedProblems).toEqual([]);
    expect(fixture!.metadata.activeRuleCount).toBeGreaterThan(0);
    expect(fixture!.metadata.corruptConditionCount).toBe(0);
    expect(fixture!.metadata.scrubAbortReasons).toEqual([]);
    expect(fixture!.fixtureHash).toMatch(/^fnv1a-/);
  });

  it('legacyView/v2View discriminants are consistent with representationOrigin (§3.6)', () => {
    for (const rule of fixture!.rules) {
      if (rule.representationOrigin === 'legacy') {
        expect(rule.legacyView.kind).toBe('passthrough');
        expect(rule.v2View.kind).toBe('stored');
        expect(rule.v2View.conditions).toBeNull();
      } else {
        expect(rule.legacyView.kind).toBe('reverseMap');
        expect(rule.v2View.kind).toBe('canonical');
        expect(rule.v2View.conditions).toBeInstanceOf(Array);
      }
    }
  });

  it('a passthrough view is fed to Legacy uninterpreted and a stored view keeps null conditions', () => {
    for (const rule of fixture!.rules) {
      const legacyRule = toLegacyRule(rule);
      if (rule.legacyView.kind === 'passthrough') {
        expect(legacyRule.conditionType).toBe(rule.legacyView.conditionType);
        expect(legacyRule.conditionValue).toBe(rule.legacyView.conditionValue);
        expect(Array.isArray(legacyRule.conditions) && legacyRule.conditions.length > 0).toBe(false);
      } else {
        expect(Array.isArray(legacyRule.conditions) && legacyRule.conditions.length > 0).toBe(true);
      }
      const v2Rule = toV2Rule(rule, fixture!);
      if (rule.v2View.kind === 'stored') {
        expect(v2Rule.conditions).toBeNull();
      } else {
        expect(v2Rule.conditions).toBeInstanceOf(Array);
      }
    }
  });

  it('fixture is canary-free before measurement', () => {
    const values: string[] = [];
    collectStringValues(fixture, values);
    const hits = canaryHits(values.join('\n'));
    expect(hits).toEqual([]);
  });

  it('measurement completed without error (no fail-closed trigger fired at run time)', () => {
    expect(runError).toBeNull();
    expect(measurement).not.toBeNull();
    expect(measurement!.outcomes.length).toBeGreaterThan(0);
  });

  it('all control vectors produce their pre-designed axis codes exactly (BRE-009 control semantics)', () => {
    expect(controlsPass).toBe(true);
    expect(measurement!.controlFailures).toEqual([]);
    for (const o of measurement!.outcomes) {
      if (o.expectedAxisA !== undefined) {
        expect(o.axisACode).toBe(o.expectedAxisA);
        expect(o.axisBCode).toBe(o.expectedAxisB);
      }
    }
  });

  it('Axis A accounting invariant: agree + diverge = total (no double counting)', () => {
    const m = measurement!.metrics;
    expect(m.axisAAgree + m.axisADivergence).toBe(m.axisATotal);
    expect(m.axisATotal).toBe(report!.totalVectors);
  });

  it('Axis B accounting invariant: agree + diverge + error = total (no double counting)', () => {
    const m = measurement!.metrics;
    expect(m.axisBAgree + m.axisBDivergence + m.axisBErrorCount).toBe(m.axisBTotal);
    expect(m.axisBTotal).toBe(report!.totalVectors);
  });

  it('V2_ERROR is counted ONLY as error — never as divergence, never as agreement', () => {
    const errors = measurement!.outcomes.filter((o) => o.axisBCode === 'V2_ERROR');
    for (const o of errors) {
      expect(DIVERGE_B.includes(o.axisBCode)).toBe(false);
      expect(o.axisBCode).not.toBe('SAME');
    }
    const nonErrors = measurement!.outcomes.filter((o) => o.axisBCode !== 'V2_ERROR');
    for (const o of nonErrors) {
      expect(o.axisBCode).not.toBe('V2_ERROR');
    }
    const m = measurement!.metrics;
    expect(m.axisBErrorCount).toBe(errors.length);
  });

  it('dead label V2_PENDING_PRECEDENCE_MATCH is never used as a signal', () => {
    for (const o of measurement!.outcomes) {
      expect(o.axisBCode).not.toBe(DEAD_LABEL);
    }
  });

  it('emits all §6 metrics: cross-cutting, per-category (6), and per-BRE (011/012/013)', () => {
    const m = report!.metrics;
    expect(m.axisAAgreementRate).toBeGreaterThanOrEqual(0);
    expect(m.axisAAgreementRate).toBeLessThanOrEqual(1);
    expect(m.axisBAgreementRate).toBeGreaterThanOrEqual(0);
    expect(m.axisBAgreementRate).toBeLessThanOrEqual(1);
    expect(m.v2ErrorRate).toBeGreaterThanOrEqual(0);
    expect(m.v2ErrorRate).toBeLessThanOrEqual(1);
    expect(m.precedenceErrorRate).toBe(0);
    expect(report!.categories).toHaveLength(6);
    for (const c of report!.categories) {
      expect(c.vectors).toBeGreaterThanOrEqual(0);
      expect(c.agreeA + c.divergeA).toBe(c.vectors);
      expect(c.agreeB + c.divergeB + c.errorB).toBe(c.vectors);
    }

    const pb = report!.perBre;
    expect(pb.bre011.wildcardRuleCount).toBe(fixture!.metadata.wildcardRuleCount);
    expect(pb.bre011.wildcardPrevalence).toBeGreaterThanOrEqual(0);
    expect(pb.bre011.wildcardPrevalence).toBeLessThanOrEqual(1);
    expect(pb.bre012.multiConditionRuleCount).toBe(fixture!.metadata.multiConditionRuleCount);
    expect(pb.bre012.overlappingRuleCount).toBe(fixture!.metadata.overlappingRuleCount);
    expect(pb.bre012.priorityBandDistribution).toEqual(fixture!.metadata.priorityBandDistribution);
    expect(pb.bre013.regexRuleCount).toBe(fixture!.metadata.regexRuleCount);
    expect(pb.bre013.invalidRegexRuleCount).toBe(fixture!.metadata.invalidRegexRuleCount);
    expect(pb.bre013.axisBErrorCount).toBe(m.axisBErrorCount);
    expect(pb.bre013.v2ErrorRate).toBe(m.v2ErrorRate);
    expect(
      pb.bre013.errorCodeDistribution.conditions_normalization_failed +
        pb.bre013.errorCodeDistribution.engine_execution_error,
    ).toBe(pb.bre013.axisBErrorCount);
    expect(pb.bre013.legacyOnlyV2ErrorCount).toBeLessThanOrEqual(pb.bre013.axisBErrorCount);
    expect(pb.bre013.normalizationFailureCount).toBe(
      pb.bre013.errorCodeDistribution.conditions_normalization_failed,
    );
  });

  it('multiConditionRuleCount excludes synthetic rules via ruleKind (§6.2 BRE-012)', () => {
    const trap = fixture!.rules.filter((r) => r.ruleKind === 'trap');
    const control = fixture!.rules.filter((r) => r.ruleKind === 'control');
    const real = fixture!.rules.filter((r) => isRealRule(r));
    expect(trap.length).toBeGreaterThan(0);
    expect(control.length).toBeGreaterThan(0);
    expect(real.length).toBeGreaterThan(0);

    for (const r of trap) {
      expect(r.conditions.length).toBeGreaterThanOrEqual(2);
      expect(isRealRule(r)).toBe(false);
    }
    for (const r of control) {
      expect(isRealRule(r)).toBe(false);
    }

    const realMulti = real.filter((r) => r.conditions.length >= 2).length;
    const syntheticMulti = [...trap, ...control].filter((r) => r.conditions.length >= 2).length;
    expect(realMulti).toBe(fixture!.metadata.multiConditionRuleCount);
    expect(report!.perBre.bre012.multiConditionRuleCount).toBe(realMulti);
    expect(syntheticMulti).toBeGreaterThan(0);
  });

  it('data-quality metadata (§6.3) mirrors the fixture and provenance stamps', () => {
    const dq = report!.dataQuality;
    expect(dq.totalRulesRead).toBe(fixture!.metadata.totalRulesRead);
    expect(dq.activeRuleCount).toBe(fixture!.metadata.activeRuleCount);
    expect(dq.inactiveRuleCount).toBe(fixture!.metadata.inactiveRuleCount);
    expect(dq.conditionTypeDistribution).toEqual(fixture!.metadata.conditionTypeDistribution);
    expect(dq.representationOriginCounts).toEqual(fixture!.metadata.representationOriginCounts);
    expect(dq.corruptConditionCount).toBe(0);
    expect(dq.scrubAbortReasons).toEqual([]);
    expect(dq.fixtureHash).toBe(fixture!.fixtureHash);
    expect(dq.scrubberVersion).toBe(EXPECTED_SCRUBBER_VERSION);
  });

  it('report is ephemeral: temp JSON under os.tmpdir()/bre010-<runId>/, read before deletion', () => {
    printReport();
    expect(tempDir).not.toBeNull();
    expect(tempFilePath).not.toBeNull();
    const dir = path.dirname(tempFilePath!);
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    expect(dir.includes(process.cwd())).toBe(false);

    const jsonText = fs.readFileSync(tempFilePath!, 'utf8');
    const parsed = JSON.parse(jsonText) as Bre010Report;
    expect(parsed.protocol).toBe('BRE-010');
    expect(parsed.runId).toBe(fixture!.runId);
    expect(parsed.runValid).toBe(report!.runValid);
    expect(parsed.outcomes.length).toBe(parsed.totalVectors);
    expect(parsed.controlOutcomes.length).toBe(parsed.controlVectors);
    expect(parsed.outcomes).toEqual(
      expect.arrayContaining(parsed.controlOutcomes.map((c) => expect.objectContaining({ caseId: c.caseId }))),
    );
    expect(parsed.metrics.axisAAgree + parsed.metrics.axisADivergence).toBe(parsed.metrics.axisATotal);
    expect(
      parsed.metrics.axisBAgree + parsed.metrics.axisBDivergence + parsed.metrics.axisBErrorCount,
    ).toBe(parsed.metrics.axisBTotal);

    const reportValues: string[] = [];
    collectStringValues(parsed, reportValues);
    const reportText = reportValues.join('\n');
    expect(reportText).not.toContain(SYNTHETIC_GL);
    expect(capturedStdout.length).toBeGreaterThan(0);
  });

  it('runValid is computed per §7.3: controls AND canary AND invariants AND no fail-closed', () => {
    const expected =
      controlsPass && canaryGateClean && invariantsHold && failClosedProblems.length === 0;
    expect(report!.runValid).toBe(expected);
    expect(report!.canaryGateClean).toBe(canaryGateClean);
    expect(report!.invariantsHold).toBe(invariantsHold);
    expect(report!.parityVerdict).toBe(report!.runValid ? 'EMITTED' : 'SUPPRESSED');
    expect(report!.runValid).toBe(true);
  });

  it('CANARY GATE: no sentinel in fixture/report/temp JSON/stdout/stderr/error surfaces', () => {
    const text = sweepText();
    const hits = canaryHits(text);
    expect(hits, `canary leak(s) detected: ${hits.join(', ')}`).toEqual([]);
  });
});
