import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SCRUBBER_VERSION,
  STRING_CANARY,
  NUMERIC_CANARY,
  FIXED_DATE,
  ScrubPolicyError,
  canonicalizeRule,
  buildMagnitudeRemap,
  buildDateRemap,
  scrubRule,
  isValidRegexPattern,
} from './bre010-scrub-policy.mjs';

export {
  SCRUBBER_VERSION,
  STRING_CANARY,
  NUMERIC_CANARY,
  FIXED_DATE,
  ScrubPolicyError,
  canonicalizeRule,
  buildMagnitudeRemap,
  buildDateRemap,
  scrubRule,
  isValidRegexPattern,
} from './bre010-scrub-policy.mjs';

export const PROTOCOL = 'BRE-010';

// ─── Deterministic primitives ───────────────────────────────────────────────

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sha256Hex(str) {
  return createHash('sha256').update(str).digest('hex');
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeFixtureHash(fixture) {
  const canonical = {
    rules: fixture.rules,
    vectors: fixture.vectors,
    controls: fixture.controls,
    metadata: fixture.metadata,
  };
  return `fnv1a-${sha256Hex(stableStringify(canonical)).slice(0, 12)}`;
}

const CORPUS_WORDS = [
  'banco', 'super', 'extra', 'pago', 'carne', 'vuelto',
  'luz', 'agua', 'gym', 'kiosko', 'viaje', 'feria',
];

export function rngWord(rng, prefix) {
  const word = CORPUS_WORDS[Math.floor(rng() * CORPUS_WORDS.length)];
  return `${prefix ? `${prefix}-` : ''}${word}-${Math.floor(rng() * 10000)}`;
}

// ─── Condition family classification ────────────────────────────────────────

const DESCRIPTION_TYPES = new Set([
  'description_contains',
  'description_starts_with',
  'description_ends_with',
  'description_eq',
]);

export function classifyConditions(conditions) {
  const descConds = [];
  const amountConds = [];
  const regexConds = [];
  const otherConds = [];
  let wildcard = false;
  for (const cond of conditions) {
    if (cond.type === 'description_matches') regexConds.push(cond);
    else if (DESCRIPTION_TYPES.has(cond.type)) {
      if (String(cond.value) === '*') wildcard = true;
      else descConds.push(cond);
    } else if (cond.type.startsWith('amount_')) amountConds.push(cond);
    else otherConds.push(cond);
  }
  return { descConds, amountConds, regexConds, otherConds, wildcard };
}

function amountConditionSatisfied(cond, absAmount) {
  switch (cond.type) {
    case 'amount_gt': return absAmount > cond.value;
    case 'amount_gte': return absAmount >= cond.value;
    case 'amount_lt': return absAmount < cond.value;
    case 'amount_lte': return absAmount <= cond.value;
    case 'amount_eq': return absAmount === cond.value;
    case 'amount_range':
      return absAmount >= cond.range[0] && absAmount <= cond.range[1];
    default: return true;
  }
}

function candidateAmounts(cond) {
  const vals = new Set([0, 1, 100, 10000]);
  if (cond.type === 'amount_range') {
    const [lo, hi] = cond.range;
    for (const v of [lo, hi, lo - 1, hi + 1, Math.floor((lo + hi) / 2)]) {
      if (Number.isFinite(v)) vals.add(Math.max(0, v));
    }
  } else if (cond.value !== undefined) {
    for (const v of [cond.value, cond.value - 1, cond.value + 1, cond.value + 5]) {
      if (Number.isFinite(v)) vals.add(Math.max(0, v));
    }
  }
  return [...vals].filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
}

export function satisfyingAmount(amountConds) {
  const candidates = [...new Set(amountConds.flatMap(candidateAmounts))].sort((a, b) => a - b);
  for (const c of candidates) {
    if (amountConds.every((cond) => amountConditionSatisfied(cond, c))) return c;
  }
  return null;
}

export function satisfyingDescription(descConds) {
  const eqVals = descConds.filter((c) => c.type === 'description_eq').map((c) => String(c.value));
  const uniqueEq = [...new Set(eqVals)];
  if (uniqueEq.length > 1) return null;
  const starts = descConds.filter((c) => c.type === 'description_starts_with').map((c) => String(c.value));
  const ends = descConds.filter((c) => c.type === 'description_ends_with').map((c) => String(c.value));
  const contains = descConds.filter((c) => c.type === 'description_contains').map((c) => String(c.value));
  if (uniqueEq.length === 1) {
    const v = uniqueEq[0];
    if (starts.some((s) => !v.startsWith(s))) return null;
    if (ends.some((e) => !v.endsWith(e))) return null;
    if (contains.some((t) => !v.includes(t))) return null;
    return v;
  }
  let desc = `TX synthetique ${[...contains, ...starts, ...ends].join(' ')}`.trim();
  for (const s of starts) if (!desc.startsWith(s)) desc = `${s} ${desc}`;
  for (const e of ends) if (!desc.endsWith(e)) desc = `${desc} ${e}`;
  for (const t of contains) if (!desc.includes(t)) desc = `${desc} ${t}`;
  return desc.trim();
}

// ─── Trap + control synthetic rules ─────────────────────────────────────────

export function buildTrapRule() {
  return {
    id: `trap-rule-${STRING_CANARY}`,
    companyId: `trap-company-${STRING_CANARY}`,
    name: `trap-name-${STRING_CANARY}`,
    conditionType: 'amount_greater',
    conditionValue: String(NUMERIC_CANARY),
    conditions: [
      { field: 'description', operator: 'contains', value: STRING_CANARY },
      { field: 'amount', operator: 'amount_greater', value: NUMERIC_CANARY },
    ],
    transactionDirection: 'any',
    priority: 0,
    isActive: true,
  };
}

export function buildControlRules() {
  return [
    {
      tag: 'ctrl-dir-pos',
      raw: {
        id: 'ctrl-dir-pos', companyId: 'ctrl-company', name: 'control direction positive',
        conditionType: 'contains', conditionValue: 'CONTROL_TXT_POS',
        conditions: [{ field: 'description', operator: 'contains', value: 'CONTROL_TXT_POS' }],
        transactionDirection: 'any', priority: 30, isActive: true,
      },
    },
    {
      tag: 'ctrl-dir-neg',
      raw: {
        id: 'ctrl-dir-neg', companyId: 'ctrl-company', name: 'control direction negative',
        conditionType: 'contains', conditionValue: 'CONTROL_TXT_NEG',
        conditions: [{ field: 'description', operator: 'contains', value: 'CONTROL_TXT_NEG' }],
        transactionDirection: 'any', priority: 31, isActive: true,
      },
    },
    {
      tag: 'ctrl-monto-pos',
      raw: {
        id: 'ctrl-monto-pos', companyId: 'ctrl-company', name: 'control monto positive',
        conditionType: 'amount_greater', conditionValue: '500',
        conditions: [{ field: 'amount', operator: 'amount_greater', value: 500 }],
        transactionDirection: 'any', priority: 40, isActive: true,
      },
    },
    {
      tag: 'ctrl-monto-neg',
      raw: {
        id: 'ctrl-monto-neg', companyId: 'ctrl-company', name: 'control monto negative',
        conditionType: 'amount_greater', conditionValue: '500',
        conditions: [{ field: 'amount', operator: 'amount_greater', value: 500 }],
        transactionDirection: 'any', priority: 41, isActive: true,
      },
    },
    {
      tag: 'ctrl-rank-high',
      raw: {
        id: 'ctrl-rank-high', companyId: 'ctrl-company', name: 'control ranking high',
        conditionType: 'contains', conditionValue: 'CONTROL_RANK',
        conditions: [{ field: 'description', operator: 'contains', value: 'CONTROL_RANK' }],
        transactionDirection: 'any', priority: 90, isActive: true,
      },
    },
    {
      tag: 'ctrl-rank-low',
      raw: {
        id: 'ctrl-rank-low', companyId: 'ctrl-company', name: 'control ranking low',
        conditionType: 'contains', conditionValue: 'CONTROL_RANK',
        conditions: [{ field: 'description', operator: 'contains', value: 'CONTROL_RANK' }],
        transactionDirection: 'any', priority: 10, isActive: true,
      },
    },
  ];
}

// ─── Raw analysis pass (canonicalize + gather remap inputs) ─────────────────

export function collectRawAnalyses(rawRules) {
  const magnitudes = [];
  const dates = [];
  const analyses = [];
  for (const raw of rawRules) {
    const canonical = canonicalizeRule(raw);
    const families = classifyConditions(canonical.conditions);
    for (const cond of canonical.conditions) {
      if (cond.type.startsWith('amount_')) {
        if (cond.type === 'amount_range') {
          for (const e of cond.range) magnitudes.push(Math.abs(Number(e)));
        } else {
          magnitudes.push(Math.abs(Number(cond.value)));
        }
      }
      if (cond.type === 'date_before' || cond.type === 'date_after') {
        dates.push(String(cond.value));
      }
    }
    if (
      typeof raw.conditionType === 'string' &&
      raw.conditionType.length > 0 &&
      typeof raw.conditionValue === 'string' &&
      raw.conditionValue.length > 0
    ) {
      const asNumber = Number(raw.conditionValue);
      if (Number.isFinite(asNumber)) magnitudes.push(Math.abs(asNumber));
    }
    analyses.push({ raw, canonical, families, origin: canonical.origin });
  }
  return { magnitudes, dates, analyses };
}

// ─── Scrubbed rule assembly ─────────────────────────────────────────────────

export function buildScrubbedRules(rawRules, magnitudeRemap, dateRemap) {
  return rawRules.map((raw, i) => {
    const scrubbed = scrubRule(raw, { ruleIndex: i + 1, magnitudeRemap, dateRemap });
    return {
      ...scrubbed,
      priority: raw.priority ?? 10,
      transactionDirection: raw.transactionDirection ?? 'any',
    };
  });
}

export function fixtureRuleView(rule) {
  return {
    id: rule.id,
    name: rule.name,
    companyId: rule.companyId,
    priority: rule.priority,
    transactionDirection: rule.transactionDirection,
    representationOrigin: rule.representationOrigin,
    conditions: rule.conditions,
    legacyView: rule.legacyView,
    v2View: rule.v2View,
  };
}

// ─── Probe / vector generation ──────────────────────────────────────────────

function descriptionMatchingProbe(cond) {
  const v = String(cond.value);
  switch (cond.type) {
    case 'description_starts_with': return `${v} supplement`;
    case 'description_ends_with': return `prefix ${v}`;
    case 'description_eq': return v;
    default: return `TX synthetique ${v}`;
  }
}

function descriptionNonMatchingProbe(cond) {
  const v = String(cond.value);
  switch (cond.type) {
    case 'description_starts_with': return `x${v}`;
    case 'description_ends_with': return `${v}x`;
    case 'description_eq': return `${v}x`;
    default: return 'TX synthetique aleatoire';
  }
}

const REGEX_PROBES = {
  '^TX synthetique': 'TX synthetique abcdef',
  'con sintetique': 'PAGO con sintetique',
  'PAGO sintetique': 'PAGO sintetique 123',
};

function regexMatchingProbe(pattern) {
  return REGEX_PROBES[pattern] ?? `TX synthetique ${pattern}`;
}

function amountProbesForCond(cond) {
  let below;
  let equal;
  let above;
  if (cond.type === 'amount_range') {
    below = Math.max(1, cond.range[0] - 1);
    equal = cond.range[0];
    above = cond.range[1] + 1;
  } else {
    const t = Number(cond.value);
    below = Math.max(1, t - 1);
    equal = t;
    above = t + 1;
  }
  return [below, equal, above].flatMap((m) => [m, -m]);
}

export function generateProbesForRule(rule, analysis, rng, vectorIndex) {
  const vectors = [];
  const baseRule = { ruleIds: [rule.id] };

  const push = (category, description, amount) => {
    vectorIndex.count += 1;
    vectors.push({
      caseId: `bre010-v-${vectorIndex.count}`,
      category,
      ruleIds: baseRule.ruleIds,
      description,
      amount,
    });
  };

  if (analysis.families.wildcard) {
    push('wildcard', `TX synthetique ${rngWord(rng)}`, analysis.amount ?? 0);
  }

  if (analysis.families.regexConds.length > 0) {
    for (const cond of analysis.families.regexConds) {
      push('regex', regexMatchingProbe(String(cond.value)), analysis.amount ?? 0);
      push('regex', 'AOTRO texto sin correspondencia', analysis.amount ?? 0);
    }
  }

  if (analysis.families.descConds.length > 0) {
    const amount = analysis.amount ?? 0;
    for (const cond of analysis.families.descConds) {
      push('direccion', descriptionMatchingProbe(cond), amount);
      push('direccion', descriptionNonMatchingProbe(cond), amount);
      push('direccion', '', amount);
    }
  }

  if (analysis.families.amountConds.length > 0) {
    const description = analysis.description ?? 'TX synthetique base';
    for (const cond of analysis.families.amountConds) {
      for (const amount of amountProbesForCond(cond)) {
        push('monto', description, amount);
      }
    }
  }

  if (
    analysis.families.otherConds.length > 0 &&
    analysis.families.descConds.length === 0 &&
    analysis.families.amountConds.length === 0 &&
    analysis.families.regexConds.length === 0 &&
    !analysis.families.wildcard
  ) {
    push('direccion', `TX synthetique ${rngWord(rng)}`, analysis.amount ?? 0);
  }

  return vectors;
}

export function generateProbes(scrubbedRules, analyses, rng) {
  const vectorIndex = { count: 0 };
  const vectors = [];
  for (let i = 0; i < scrubbedRules.length; i += 1) {
    if (analyses[i].isControl) continue;
    const families = classifyConditions(scrubbedRules[i].conditions);
    const analysis = {
      families,
      amount: satisfyingAmount(families.amountConds),
      description: satisfyingDescription(families.descConds),
    };
    vectors.push(...generateProbesForRule(scrubbedRules[i], analysis, rng, vectorIndex));
  }
  return vectors;
}

function sharedProbe(ruleA, ruleB, rng) {
  const famA = classifyConditions(ruleA.conditions);
  const famB = classifyConditions(ruleB.conditions);
  if (famA.otherConds.length > 0 || famB.otherConds.length > 0) return null;
  const description = satisfyingDescription([...famA.descConds, ...famB.descConds]);
  const amount = satisfyingAmount([...famA.amountConds, ...famB.amountConds]);
  const onlyDesc =
    famA.amountConds.length === 0 &&
    famB.amountConds.length === 0 &&
    (famA.descConds.length > 0 || famB.descConds.length > 0 || famA.wildcard || famB.wildcard);
  const onlyAmount =
    famA.descConds.length === 0 &&
    famB.descConds.length === 0 &&
    !famA.wildcard &&
    !famB.wildcard &&
    (famA.amountConds.length > 0 || famB.amountConds.length > 0);
  if (description !== null && amount !== null) {
    return { description, amount };
  }
  if (description !== null && onlyDesc) return { description, amount: 0 };
  if (amount !== null && onlyAmount) {
    return { description: `TX synthetique ${rngWord(rng)}`, amount };
  }
  return null;
}

export function generateRankingVectors(scrubbedRules, analyses, rng, maxVectors = 50) {
  const vectors = [];
  const pairSeen = new Set();
  let emitted = 0;
  for (let i = 0; i < scrubbedRules.length; i += 1) {
    if (analyses[i].isControl || analyses[i].isTrap) continue;
    for (let j = i + 1; j < scrubbedRules.length; j += 1) {
      if (emitted >= maxVectors) break;
      if (analyses[j].isControl || analyses[j].isTrap) continue;
      const probe = sharedProbe(scrubbedRules[i], scrubbedRules[j], rng);
      if (!probe) continue;
      const key = `${scrubbedRules[i].id}|${scrubbedRules[j].id}`;
      if (pairSeen.has(key)) continue;
      pairSeen.add(key);
      emitted += 1;
      vectors.push({
        caseId: `bre010-v-${vectors.length + 1}`,
        category: 'ranking',
        ruleIds: [scrubbedRules[i].id, scrubbedRules[j].id],
        description: probe.description,
        amount: probe.amount,
      });
    }
  }
  return vectors;
}

// ─── Controls ───────────────────────────────────────────────────────────────

export function buildControlVectors(scrubbedRules, analyses) {
  const byTag = new Map();
  for (let i = 0; i < scrubbedRules.length; i += 1) {
    if (analyses[i].isControl) byTag.set(analyses[i].tag, scrubbedRules[i]);
  }
  const controls = [];
  const dirPos = byTag.get('ctrl-dir-pos');
  const dirNeg = byTag.get('ctrl-dir-neg');
  const montoPos = byTag.get('ctrl-monto-pos');
  const montoNeg = byTag.get('ctrl-monto-neg');
  const rankHigh = byTag.get('ctrl-rank-high');
  const rankLow = byTag.get('ctrl-rank-low');

  const dirPosToken = dirPos ? String(dirPos.conditions[0].value) : null;
  const dirNegToken = dirNeg ? String(dirNeg.conditions[0].value) : null;
  const montoThreshold = montoPos ? Number(montoPos.conditions[0].value) : null;
  const rankToken = rankHigh ? String(rankHigh.conditions[0].value) : null;

  if (dirPos && dirPosToken !== null) {
    controls.push({
      caseId: 'ctrl-dir-pos',
      ruleIds: [dirPos.id],
      description: `TX synthetique ${dirPosToken}`,
      amount: 0,
      expectedAxisA: 'SAME_WINNER',
      expectedAxisB: 'SAME',
    });
  }
  if (dirNeg && dirNegToken !== null) {
    controls.push({
      caseId: 'ctrl-dir-neg',
      ruleIds: [dirNeg.id],
      description: 'TX synthetique aleatoire',
      amount: 0,
      expectedAxisA: 'BOTH_NO_MATCH',
      expectedAxisB: 'SAME',
    });
  }
  if (montoPos && montoThreshold !== null) {
    for (const sign of [1, -1]) {
      controls.push({
        caseId: `ctrl-monto-pos-${sign > 0 ? 'credit' : 'debit'}`,
        ruleIds: [montoPos.id],
        description: 'TX synthetique monto',
        amount: sign * (montoThreshold + 1),
        expectedAxisA: 'SAME_WINNER',
        expectedAxisB: 'SAME',
      });
    }
  }
  if (montoNeg && montoThreshold !== null) {
    for (const sign of [1, -1]) {
      controls.push({
        caseId: `ctrl-monto-neg-${sign > 0 ? 'credit' : 'debit'}`,
        ruleIds: [montoNeg.id],
        description: 'TX synthetique monto',
        amount: sign * Math.max(1, montoThreshold - 1),
        expectedAxisA: 'BOTH_NO_MATCH',
        expectedAxisB: 'SAME',
      });
    }
  }
  if (rankHigh && rankLow && rankToken !== null) {
    controls.push({
      caseId: 'ctrl-rank',
      ruleIds: [rankHigh.id, rankLow.id],
      description: `TX synthetique ${rankToken}`,
      amount: 0,
      expectedAxisA: 'SAME_WINNER',
      expectedAxisB: 'V2_NO_MATCH_PRECEDENCE_MATCH',
    });
  }

  return controls;
}

// ─── Metadata ───────────────────────────────────────────────────────────────

function priorityBand(priority) {
  if (priority <= 10) return '1-10';
  if (priority <= 50) return '11-50';
  if (priority <= 100) return '51-100';
  return '100+';
}

export function buildMetadata(rawAnalyses, counts, rankingVectors) {
  const conditionTypeDistribution = {};
  const representationOriginCounts = { json: 0, legacy: 0, both: 0 };
  let wildcardRuleCount = 0;
  let regexRuleCount = 0;
  let invalidRegexRuleCount = 0;
  let multiConditionRuleCount = 0;
  const priorityBandDistribution = {};

  const realAnalyses = rawAnalyses.filter((a) => !a.isControl && !a.isTrap);
  for (const a of realAnalyses) {
    representationOriginCounts[a.origin] = (representationOriginCounts[a.origin] ?? 0) + 1;
    for (const cond of a.canonical.conditions) {
      conditionTypeDistribution[cond.type] = (conditionTypeDistribution[cond.type] ?? 0) + 1;
    }
    const families = a.families;
    if (families.wildcard) wildcardRuleCount += 1;
    if (families.regexConds.length > 0) {
      regexRuleCount += 1;
      const anyInvalid = families.regexConds.some((c) => !isValidRegexPattern(String(c.value)));
      if (anyInvalid) invalidRegexRuleCount += 1;
    }
    if (a.canonical.conditions.length >= 2) multiConditionRuleCount += 1;
    const band = priorityBand(a.raw.priority ?? 10);
    priorityBandDistribution[band] = (priorityBandDistribution[band] ?? 0) + 1;
  }

  const overlappingRules = new Set();
  for (const v of rankingVectors) {
    for (const id of v.ruleIds) overlappingRules.add(id);
  }

  return {
    totalRulesRead: counts.totalRulesRead,
    activeRuleCount: counts.activeRuleCount,
    inactiveRuleCount: counts.inactiveRuleCount,
    conditionTypeDistribution,
    representationOriginCounts,
    corruptConditionCount: 0,
    scrubAbortReasons: [],
    wildcardRuleCount,
    regexRuleCount,
    invalidRegexRuleCount,
    multiConditionRuleCount,
    overlappingRuleCount: overlappingRules.size,
    priorityBandDistribution,
  };
}

// ─── Fixture assembly ───────────────────────────────────────────────────────

export function gitCommit() {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

export function buildFixture({
  scrubbedRules,
  realAnalyses,
  vectors,
  controls,
  metadata,
  counts,
}) {
  const fixture = {
    protocol: PROTOCOL,
    scrubberVersion: SCRUBBER_VERSION,
    gitCommit: gitCommit(),
    runId: randomUUID(),
    companyId: 'company-scrubbed-1',
    fixedDate: FIXED_DATE,
    rules: scrubbedRules.map(fixtureRuleView),
    vectors,
    controls,
    metadata,
  };
  fixture.fixtureHash = computeFixtureHash(fixture);
  void realAnalyses;
  void counts;
  return fixture;
}

// ─── Run orchestration (CLI wiring stays thin) ─────────────────────────────

export function parseArgs(argv) {
  const opts = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--companyId') {
      opts.companyId = argv[i + 1];
      i += 1;
    } else if (arg === '--out') {
      opts.out = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

function dbNameFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
}

export function loadEnv() {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env is optional; DATABASE_URL may come from the environment.
  }
}

export async function runDryRun(db, companyId) {
  const [active, inactive] = await Promise.all([
    db.bankRule.count({ where: { companyId, isActive: true } }),
    db.bankRule.count({ where: { companyId, isActive: false } }),
  ]);
  console.error(`BRE-010 dry-run: companyId=${companyId} activeRuleCount=${active} inactiveRuleCount=${inactive}`);
  if (active === 0) {
    console.error('WARNING: activeRuleCount == 0 — a real run would abort (spec 7.4 #7).');
  }
}

export async function runExtract(db, { companyId, outDir }) {
  const [activeRules, inactiveCount] = await Promise.all([
    db.bankRule.findMany({
      where: { companyId, isActive: true },
      select: {
        id: true,
        companyId: true,
        name: true,
        conditionType: true,
        conditionValue: true,
        conditions: true,
        transactionDirection: true,
        priority: true,
        isActive: true,
      },
    }),
    db.bankRule.count({ where: { companyId, isActive: false } }),
  ]);

  if (activeRules.length === 0) {
    throw new ScrubPolicyError(
      `FAIL CLOSED: activeRuleCount == 0 for companyId ${companyId} (spec 7.4 #7). No fixture written.`,
    );
  }

  activeRules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : (a.priority ?? 0) - (b.priority ?? 0)));

  const trapRule = buildTrapRule();
  const controlSpecs = buildControlRules();

  const rawSet = [
    ...activeRules.map((r) => ({ ...r, isTrap: false, isControl: false, tag: null })),
    { ...trapRule, isTrap: true, isControl: false, tag: null },
    ...controlSpecs.map((c) => ({ ...c.raw, isTrap: false, isControl: true, tag: c.tag })),
  ];

  const { magnitudes, dates, analyses } = collectRawAnalyses(rawSet);
  const magnitudeRemap = buildMagnitudeRemap(magnitudes);
  const dateRemap = buildDateRemap(dates);

  const scrubbedRules = buildScrubbedRules(rawSet, magnitudeRemap, dateRemap);

  analyses.forEach((a, i) => {
    a.isControl = rawSet[i].isControl;
    a.isTrap = rawSet[i].isTrap;
    a.tag = rawSet[i].tag;
  });

  const runSeed = fnv1a32(sha256Hex(stableStringify(scrubbedRules.map(fixtureRuleView))));
  const rng = mulberry32(runSeed);

  const probeVectors = generateProbes(scrubbedRules, analyses, rng);
  const rankingVectors = generateRankingVectors(scrubbedRules, analyses, rng);
  const controlVectors = buildControlVectors(scrubbedRules, analyses, rng);
  const vectors = [...probeVectors, ...rankingVectors];

  const counts = {
    totalRulesRead: activeRules.length + inactiveCount,
    activeRuleCount: activeRules.length,
    inactiveRuleCount: inactiveCount,
  };
  const metadata = buildMetadata(analyses, counts, rankingVectors);
  const fixture = buildFixture({
    scrubbedRules,
    realAnalyses: analyses,
    vectors,
    controls: controlVectors,
    metadata,
    counts,
  });

  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });
  const fixturePath = join(out, 'fixture.json');
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return fixturePath;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.companyId) {
    console.error('Usage: node scripts/bre010-extract.mjs --companyId <cuid> [--out <dir>] [--dry-run]');
    console.error('  --companyId <cuid>  (required) exactly one company to measure');
    console.error('  --out <dir>         fixture directory (default os.tmpdir()/bre010-<runId>/)');
    console.error('  --dry-run           run SELECTs, print counts, write nothing');
    process.exit(2);
  }

  if (process.env.NODE_ENV === 'test') {
    console.error('FAIL CLOSED: NODE_ENV must NOT be "test" — the extractor reads the real dev database.');
    process.exit(1);
  }

  loadEnv();

  const dbName = dbNameFromUrl(process.env.DATABASE_URL);
  if (!dbName || !dbName.includes('accountexpress') || dbName.includes('test')) {
    console.error(
      `FAIL CLOSED: DATABASE_URL must point to the dev "accountexpress" database (got "${dbName ?? '(missing)'}"). ` +
        'Never point this at a test or production database.',
    );
    process.exit(1);
  }

  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    if (opts.dryRun) {
      await runDryRun(db, opts.companyId);
      console.error('BRE-010 dry-run complete: read-only SELECTs only, no fixture written.');
    } else {
      const outDir = opts.out ?? join(tmpdir(), `bre010-${randomUUID()}`);
      const fixturePath = await runExtract(db, { companyId: opts.companyId, outDir });
      console.log(fixturePath);
    }
  } catch (err) {
    console.error(`BRE-010 extractor failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

const invokedAsMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsMain) {
  await main();
}
