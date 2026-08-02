import { createHash } from 'node:crypto';

export const SCRUBBER_VERSION = 'bre010-scrub-1.0.0';

export const STRING_CANARY = 'BRE010_CANARY_STR_9f1c2d3e';
export const NUMERIC_CANARY = 424242.42;

export const FIXED_DATE = '2026-07-31T12:00:00.000Z';

export const MAGNITUDE_REMAP_RANGE = Object.freeze({ min: 100, max: 10000 });

const DAY_MS = 24 * 60 * 60 * 1000;

export class ScrubPolicyError extends Error {
  constructor(message) {
    super(`scrub_policy_failed: ${message}`);
    this.name = 'ScrubPolicyError';
  }
}

const RULE_CONDITION_TYPES = new Set([
  'amount_gt',
  'amount_gte',
  'amount_lt',
  'amount_lte',
  'description_eq',
  'description_contains',
  'description_starts_with',
  'description_ends_with',
  'description_matches',
  'entity_eq',
  'amount_eq',
  'amount_range',
  'date_before',
  'date_after',
]);

const AMOUNT_OPERATORS = new Set([
  'amount_greater',
  'amount_less',
  'greater_than',
  'less_than',
  'greaterThan',
  'lessThan',
]);

const FIELD_OPERATOR_MAP = {
  description: {
    contains: 'description_contains',
    starts_with: 'description_starts_with',
    ends_with: 'description_ends_with',
    equals: 'description_eq',
  },
  amount: {
    equals: 'amount_eq',
    amount_greater: 'amount_gt',
    amount_less: 'amount_lt',
    greater_than: 'amount_gt',
    greaterThan: 'amount_gt',
    less_than: 'amount_lt',
    lessThan: 'amount_lt',
  },
};

const SAFE_REGEX_CORPUS = ['^TX synthetique', 'con sintetique', 'PAGO sintetique'];

function isV1Condition(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  return (
    typeof obj.field === 'string' &&
    typeof obj.operator === 'string' &&
    (typeof obj.value === 'string' || typeof obj.value === 'number')
  );
}

function isV2Condition(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  if (typeof obj.type !== 'string') return false;
  return typeof obj.value === 'string' || typeof obj.value === 'number';
}

function detectArrayFormat(arr) {
  if (arr.length === 0) return 'corrupt';
  const hasV1 = arr.every(isV1Condition);
  const hasV2 = arr.every(isV2Condition);
  if (hasV1) return 'v1';
  if (hasV2) return 'v2';
  return 'corrupt';
}

export function detectFormat(conditions) {
  if (!Array.isArray(conditions)) return 'corrupt';
  return detectArrayFormat(conditions);
}

function normalizeV1Conditions(conditions) {
  return conditions.map((cond) => {
    const fieldMap = FIELD_OPERATOR_MAP[cond.field];
    if (!fieldMap) {
      throw new ScrubPolicyError(`Unrecognized field: ${cond.field}`);
    }
    const mappedType = fieldMap[cond.operator];
    if (!mappedType) {
      throw new ScrubPolicyError(`Unrecognized operator "${cond.operator}" for field "${cond.field}"`);
    }
    return { type: mappedType, value: cond.value };
  });
}

function isPopulatedLegacy(rule) {
  return (
    typeof rule.conditionType === 'string' &&
    rule.conditionType.length > 0 &&
    typeof rule.conditionValue === 'string' &&
    rule.conditionValue.length > 0
  );
}

export function classifyRepresentationOrigin(rule) {
  const hasConditions = Array.isArray(rule.conditions) && rule.conditions.length > 0;
  const hasLegacy = isPopulatedLegacy(rule);
  if (hasConditions && hasLegacy) return 'both';
  if (hasConditions) return 'json';
  if (hasLegacy) return 'legacy';
  throw new ScrubPolicyError(
    'No canonizable representation: conditions has no elements and legacy columns are unpopulated',
  );
}

function validateCanonicalConditions(conditions) {
  for (const cond of conditions) {
    if (!RULE_CONDITION_TYPES.has(cond.type)) {
      throw new ScrubPolicyError(`Unmappable rule: canonical condition type "${cond.type}" is not a RuleConditionType`);
    }
    if (typeof cond.value !== 'string' && typeof cond.value !== 'number') {
      throw new ScrubPolicyError('Unmappable rule: condition value is not string/number');
    }
    if (cond.range !== undefined) {
      if (!Array.isArray(cond.range) || cond.range.length !== 2 || cond.range.some((e) => typeof e !== 'number')) {
        throw new ScrubPolicyError('Unmappable rule: amount_range requires a [number, number] range');
      }
    }
  }
}

export function canonicalizeRule(rule) {
  const hasConditions = Array.isArray(rule.conditions) && rule.conditions.length > 0;

  if (hasConditions) {
    const format = detectFormat(rule.conditions);
    if (format === 'corrupt') {
      throw new ScrubPolicyError('Corrupt conditions JSON: mixed V1+V2 or elements failing V1/V2 shape detection');
    }
    const canonical = format === 'v2' ? rule.conditions.slice() : normalizeV1Conditions(rule.conditions);
    validateCanonicalConditions(canonical);
    return { origin: isPopulatedLegacy(rule) ? 'both' : 'json', conditions: canonical, format };
  }

  if (isPopulatedLegacy(rule)) {
    const field = AMOUNT_OPERATORS.has(rule.conditionType) ? 'amount' : 'description';
    const canonical = normalizeV1Conditions([
      { field, operator: rule.conditionType, value: rule.conditionValue },
    ]);
    validateCanonicalConditions(canonical);
    return { origin: 'legacy', conditions: canonical, format: 'v1' };
  }

  throw new ScrubPolicyError(
    'No canonizable representation: conditions has no elements and legacy columns are unpopulated',
  );
}

export function buildMagnitudeRemap(distinctMagnitudes) {
  const sorted = [...new Set(distinctMagnitudes.map(Math.abs))].sort((a, b) => a - b);
  const { min, max } = MAGNITUDE_REMAP_RANGE;
  if (sorted.length === 0) return new Map();
  const span = max - min;
  if (sorted.length - 1 > span) {
    throw new ScrubPolicyError(
      `Magnitude remap cannot fit ${sorted.length} distinct magnitudes in [${min}, ${max}] while preserving strict order`,
    );
  }
  const step = sorted.length === 1 ? 0 : Math.floor(span / (sorted.length - 1));
  const remap = new Map();
  sorted.forEach((mag, i) => {
    remap.set(mag, min + i * step);
  });
  return remap;
}

export function buildDateRemap(distinctDates) {
  const sorted = [...new Set(distinctDates)].sort();
  const base = Date.parse(FIXED_DATE);
  const remap = new Map();
  sorted.forEach((date, i) => {
    remap.set(date, new Date(base + i * DAY_MS).toISOString());
  });
  return remap;
}

export function scrubStringValue(value) {
  const str = String(value);
  if (str === '*') return str;
  return `token-${createHash('sha256').update(str).digest('hex').slice(0, 8)}`;
}

export function scrubMagnitudeValue(value, magnitudeRemap) {
  const mag = Math.abs(Number(value));
  if (!Number.isFinite(mag)) {
    throw new ScrubPolicyError(`Non-finite magnitude cannot be scrubbed: ${String(value)}`);
  }
  if (!magnitudeRemap.has(mag)) {
    throw new ScrubPolicyError(`Magnitude ${mag} is not present in the run magnitude remap`);
  }
  return magnitudeRemap.get(mag);
}

export function isValidRegexPattern(pattern) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function scrubRegexValue(value) {
  const str = String(value);
  if (!isValidRegexPattern(str)) {
    return { pattern: '[', isValid: false };
  }
  const hash = parseInt(createHash('sha256').update(str).digest('hex').slice(0, 8), 16);
  return { pattern: SAFE_REGEX_CORPUS[hash % SAFE_REGEX_CORPUS.length], isValid: true };
}

export function scrubDateValue(value, dateRemap) {
  const str = String(value);
  if (!dateRemap.has(str)) {
    throw new ScrubPolicyError(`Date ${str} is not present in the run date remap`);
  }
  return dateRemap.get(str);
}

export function scrubCanonicalConditions(conditions, magnitudeRemap, dateRemap) {
  return conditions.map((cond) => {
    const type = cond.type;
    if (type === 'amount_gt' || type === 'amount_gte' || type === 'amount_lt' || type === 'amount_lte' || type === 'amount_eq') {
      return { ...cond, value: scrubMagnitudeValue(cond.value, magnitudeRemap) };
    }
    if (type === 'amount_range') {
      if (!Array.isArray(cond.range) || cond.range.length !== 2) {
        throw new ScrubPolicyError('amount_range requires a 2-element range');
      }
      return {
        ...cond,
        range: [
          scrubMagnitudeValue(cond.range[0], magnitudeRemap),
          scrubMagnitudeValue(cond.range[1], magnitudeRemap),
        ],
      };
    }
    if (
      type === 'description_contains' ||
      type === 'description_starts_with' ||
      type === 'description_ends_with' ||
      type === 'description_eq'
    ) {
      return { ...cond, value: scrubStringValue(cond.value) };
    }
    if (type === 'description_matches') {
      return { ...cond, value: scrubRegexValue(cond.value).pattern };
    }
    if (type === 'entity_eq') {
      return { ...cond, value: 'entity-scrubbed-1' };
    }
    if (type === 'date_before' || type === 'date_after') {
      return { ...cond, value: scrubDateValue(cond.value, dateRemap) };
    }
    throw new ScrubPolicyError(`Unknown canonical condition type during scrub: ${type}`);
  });
}

export function scrubLegacyColumns({ conditionType, conditionValue }, magnitudeRemap) {
  if (AMOUNT_OPERATORS.has(conditionType)) {
    return {
      conditionType,
      conditionValue: String(scrubMagnitudeValue(conditionValue, magnitudeRemap)),
    };
  }
  return { conditionType, conditionValue: scrubStringValue(conditionValue) };
}

const REVERSE_MAP = {
  description_contains: { field: 'description', operator: 'contains' },
  description_starts_with: { field: 'description', operator: 'starts_with' },
  description_ends_with: { field: 'description', operator: 'ends_with' },
  description_eq: { field: 'description', operator: 'equals' },
  amount_gt: { field: 'amount', operator: 'greater_than' },
  amount_gte: { field: 'amount', operator: 'greater_than' },
  amount_lt: { field: 'amount', operator: 'less_than' },
  amount_lte: { field: 'amount', operator: 'less_than' },
  amount_eq: { field: 'amount', operator: 'equals' },
  amount_range: { field: 'amount', operator: 'amount_range' },
  description_matches: { field: 'description', operator: 'description_matches' },
  entity_eq: { field: 'entity', operator: 'entity_eq' },
  date_before: { field: 'date', operator: 'date_before' },
  date_after: { field: 'date', operator: 'date_after' },
};

export function reverseMapCondition(cond) {
  const mapping = REVERSE_MAP[cond.type];
  if (!mapping) {
    throw new ScrubPolicyError(`No reverse map entry for canonical type "${cond.type}"`);
  }
  return {
    field: mapping.field,
    operator: mapping.operator,
    value: cond.type === 'amount_range' ? (Array.isArray(cond.range) ? cond.range[0] : cond.value) : cond.value,
  };
}

export function buildLegacyView(origin, { scrubbedConditions, scrubbedLegacy }) {
  if (origin === 'legacy') {
    return {
      kind: 'passthrough',
      conditionType: scrubbedLegacy.conditionType,
      conditionValue: scrubbedLegacy.conditionValue,
    };
  }
  return { kind: 'reverseMap', items: scrubbedConditions.map(reverseMapCondition) };
}

export function buildV2View(origin, { scrubbedConditions }) {
  if (origin === 'legacy') {
    return { kind: 'stored', conditions: null };
  }
  return { kind: 'canonical', conditions: scrubbedConditions };
}

export function scrubRule(rule, ctx) {
  const { ruleIndex, magnitudeRemap, dateRemap } = ctx;
  const canonicalized = canonicalizeRule(rule);
  const scrubbedConditions = scrubCanonicalConditions(
    canonicalized.conditions,
    magnitudeRemap,
    dateRemap,
  );
  const scrubbedLegacy = isPopulatedLegacy(rule)
    ? scrubLegacyColumns(
        { conditionType: rule.conditionType, conditionValue: rule.conditionValue },
        magnitudeRemap,
      )
    : null;

  return {
    id: `scrubbed-rule-${ruleIndex}`,
    name: `rule-${ruleIndex}`,
    companyId: 'company-scrubbed-1',
    representationOrigin: canonicalized.origin,
    conditions: scrubbedConditions,
    legacyView: buildLegacyView(canonicalized.origin, { scrubbedConditions, scrubbedLegacy }),
    v2View: buildV2View(canonicalized.origin, { scrubbedConditions }),
  };
}
