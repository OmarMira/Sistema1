import { describe, it, expect } from 'vitest';
import {
  SCRUBBER_VERSION,
  STRING_CANARY,
  NUMERIC_CANARY,
  FIXED_DATE,
  MAGNITUDE_REMAP_RANGE,
  ScrubPolicyError,
  detectFormat,
  classifyRepresentationOrigin,
  canonicalizeRule,
  buildMagnitudeRemap,
  buildDateRemap,
  scrubStringValue,
  scrubMagnitudeValue,
  scrubRegexValue,
  scrubDateValue,
  scrubCanonicalConditions,
  scrubLegacyColumns,
  buildLegacyView,
  buildV2View,
  scrubRule,
} from '../scripts/bre010-scrub-policy.mjs';
import {
  normalize,
  detectFormat as productionDetectFormat,
  NormalizationError,
} from '@/lib/services/rule-engine-adapter/conditions-normalizer';
import { normalizeRuleForPrecedence } from '@/lib/services/rule-precedence-compat';

type RuleLike = {
  conditions: unknown;
  conditionType?: string | null;
  conditionValue?: string | null;
};

function legacyRule(conditionType: string, conditionValue: string): RuleLike {
  return { conditions: null, conditionType, conditionValue };
}

function jsonRule(conditions: unknown): RuleLike {
  return { conditions, conditionType: null, conditionValue: null };
}

describe('scrub-policy detectFormat parity', () => {
  const shapes: Record<string, unknown> = {
    v1Description: [{ field: 'description', operator: 'contains', value: 'foo' }],
    v1Amount: [{ field: 'amount', operator: 'amount_greater', value: 150 }],
    v2Description: [{ type: 'description_contains', value: 'foo' }],
    v2Amount: [{ type: 'amount_gt', value: 150 }],
    v2Range: [{ type: 'amount_range', value: 0, range: [10, 100] }],
    emptyArray: [],
    nullValue: null,
    nonArray: { type: 'description_contains', value: 'foo' },
    corruptMixed: [
      { type: 'description_contains', value: 'a' },
      { field: 'description', operator: 'contains', value: 'b' },
    ],
    corruptMissingValue: [{ type: 'description_contains' }],
  };

  for (const [name, value] of Object.entries(shapes)) {
    it(`classifies "${name}" identically to production`, () => {
      expect(detectFormat(value)).toBe(productionDetectFormat(value));
    });
  }
});

describe('scrub-policy canonical mapping parity with production', () => {
  it('canonicalizes V1 JSON conditions like production normalize()', () => {
    const rule = jsonRule([{ field: 'description', operator: 'contains', value: 'foo' }]);
    const result = canonicalizeRule(rule);
    expect(result.origin).toBe('json');
    expect(result.conditions).toEqual(normalize(rule.conditions));
    expect(result.conditions).toEqual(normalizeRuleForPrecedence(rule));
  });

  it('canonicalizes V1 JSON amount conditions like production normalize()', () => {
    const rule = jsonRule([{ field: 'amount', operator: 'amount_greater', value: 150 }]);
    const result = canonicalizeRule(rule);
    expect(result.origin).toBe('json');
    expect(result.conditions).toEqual(normalize(rule.conditions));
    expect(result.conditions[0].type).toBe('amount_gt');
  });

  it('canonicalizes V2 JSON conditions like production normalize()', () => {
    const rule = jsonRule([
      { type: 'description_contains', value: 'foo' },
      { type: 'amount_gte', value: 300 },
      { type: 'amount_range', value: 0, range: [10, 100] },
    ]);
    const result = canonicalizeRule(rule);
    expect(result.origin).toBe('json');
    expect(result.conditions).toEqual(normalize(rule.conditions));
  });

  it('builds the legacy canonical from legacy columns exactly like normalizeRuleForPrecedence', () => {
    const amountOperators: Array<[string, string]> = [
      ['greater_than', 'amount_gt'],
      ['less_than', 'amount_lt'],
      ['greaterThan', 'amount_gt'],
      ['lessThan', 'amount_lt'],
      ['amount_greater', 'amount_gt'],
      ['amount_less', 'amount_lt'],
    ];
    for (const [operator, expectedType] of amountOperators) {
      const rule = legacyRule(operator, '250.5');
      const result = canonicalizeRule(rule);
      expect(result.origin).toBe('legacy');
      expect(result.conditions).toEqual(normalizeRuleForPrecedence(rule));
      expect(result.conditions[0].type).toBe(expectedType);
    }
  });

  it('builds the legacy canonical for description operators like normalizeRuleForPrecedence', () => {
    const descriptionOperators: Array<[string, string]> = [
      ['contains', 'description_contains'],
      ['starts_with', 'description_starts_with'],
      ['ends_with', 'description_ends_with'],
      ['equals', 'description_eq'],
    ];
    for (const [operator, expectedType] of descriptionOperators) {
      const rule = legacyRule(operator, 'foo');
      const result = canonicalizeRule(rule);
      expect(result.origin).toBe('legacy');
      expect(result.conditions).toEqual(normalizeRuleForPrecedence(rule));
      expect(result.conditions[0].type).toBe(expectedType);
    }
  });

  it('routes an empty-array conditions to the legacy fallback (production ordering)', () => {
    const rule = { conditions: [], conditionType: 'greater_than', conditionValue: '500' };
    const result = canonicalizeRule(rule);
    expect(result.origin).toBe('legacy');
    expect(result.conditions).toEqual(normalizeRuleForPrecedence(rule));
  });

  it('routes null conditions with populated legacy to the legacy fallback', () => {
    const rule = legacyRule('greater_than', '500');
    const result = canonicalizeRule(rule);
    expect(result.origin).toBe('legacy');
    expect(result.conditions).toEqual(normalizeRuleForPrecedence(rule));
  });

  it('routes a non-array conditions value with populated legacy to the legacy fallback', () => {
    const rule = { conditions: { type: 'x' }, conditionType: 'contains', conditionValue: 'foo' };
    const result = canonicalizeRule(rule);
    expect(result.origin).toBe('legacy');
    expect(result.conditions).toEqual(normalizeRuleForPrecedence(rule));
  });

  it('lets conditions win over legacy columns when both are present', () => {
    const rule = {
      conditions: [{ type: 'amount_gt', value: 900 }],
      conditionType: 'amount_greater',
      conditionValue: '42',
    };
    const result = canonicalizeRule(rule);
    expect(result.origin).toBe('both');
    expect(result.conditions).toEqual(normalize(rule.conditions));
    expect(result.conditions[0].value).toBe(900);
    expect(result.conditions[0].value).not.toBe('42');
  });

  it('fails closed on corrupt (mixed V1+V2) conditions like production normalize()', () => {
    const corrupt = jsonRule([
      { type: 'description_contains', value: 'a' },
      { field: 'description', operator: 'contains', value: 'b' },
    ]);
    expect(() => canonicalizeRule(corrupt)).toThrow(ScrubPolicyError);
    expect(() => normalize(corrupt.conditions)).toThrow(NormalizationError);
  });

  it('fails closed when neither representation can be canonized (production normalize() also throws)', () => {
    const rule = { conditions: [], conditionType: null, conditionValue: null };
    expect(() => classifyRepresentationOrigin(rule)).toThrow(ScrubPolicyError);
    expect(() => canonicalizeRule(rule)).toThrow(ScrubPolicyError);
    expect(() => normalize(rule.conditions)).toThrow(NormalizationError);
  });

  it('fails closed on an unmappable legacy operator (mirrors production NormalizationError)', () => {
    const rule = legacyRule('foo', 'bar');
    expect(() => canonicalizeRule(rule)).toThrow(ScrubPolicyError);
    expect(() => normalizeRuleForPrecedence(rule)).toThrow(NormalizationError);
  });
});

describe('observational engine views', () => {
  it('legacy-only greater_than rule gets a passthrough legacy view and a stored V2 view', () => {
    const rule = legacyRule('greater_than', '150');
    const remap = buildMagnitudeRemap([150]);
    const result = scrubRule(rule, { ruleIndex: 1, magnitudeRemap: remap, dateRemap: new Map() });

    expect(result.representationOrigin).toBe('legacy');
    expect(result.legacyView.kind).toBe('passthrough');
    expect(result.legacyView.conditionType).toBe('greater_than');
    expect(result.legacyView.conditionValue).toBe(String(remap.get(150)));
    expect(result.legacyView.conditionValue).not.toBe('150');
    expect(result.legacyView.items).toBeUndefined();

    expect(result.v2View.kind).toBe('stored');
    expect(result.v2View.conditions).toBeNull();
  });

  it('JSON-origin rule gets a reverse-map legacy view and a canonical V2 view', () => {
    const rule = jsonRule([{ type: 'description_contains', value: 'real merchant' }]);
    const result = scrubRule(rule, { ruleIndex: 2, magnitudeRemap: new Map(), dateRemap: new Map() });

    expect(result.representationOrigin).toBe('json');
    expect(result.legacyView.kind).toBe('reverseMap');
    expect(result.legacyView.items).toHaveLength(1);
    expect(result.legacyView.items[0]).toEqual({
      field: 'description',
      operator: 'contains',
      value: expect.stringMatching(/^token-[0-9a-f]{8}$/),
    });

    expect(result.v2View.kind).toBe('canonical');
    expect(result.v2View.conditions).toEqual(result.conditions);
  });

  it('reverse-maps amount_gte to the strict legacy greater_than operator', () => {
    const rule = jsonRule([{ type: 'amount_gte', value: 300 }]);
    const remap = buildMagnitudeRemap([300]);
    const result = scrubRule(rule, { ruleIndex: 3, magnitudeRemap: remap, dateRemap: new Map() });
    expect(result.legacyView.kind).toBe('reverseMap');
    expect(result.legacyView.items[0]).toEqual({
      field: 'amount',
      operator: 'greater_than',
      value: remap.get(300),
    });
  });

  it('both-origin rule is canonicalized from conditions and reverse-mapped', () => {
    const rule = {
      conditions: [{ type: 'amount_gt', value: 900 }],
      conditionType: 'amount_greater',
      conditionValue: '42',
    };
    const remap = buildMagnitudeRemap([900, 42]);
    const result = scrubRule(rule, { ruleIndex: 4, magnitudeRemap: remap, dateRemap: new Map() });

    expect(result.representationOrigin).toBe('both');
    expect(result.conditions).toEqual([{ type: 'amount_gt', value: remap.get(900) }]);
    expect(result.legacyView.kind).toBe('reverseMap');
    expect(result.legacyView.items[0]).toEqual({
      field: 'amount',
      operator: 'greater_than',
      value: remap.get(900),
    });
    expect(result.v2View.kind).toBe('canonical');
  });

  it('never reverse-maps a legacy passthrough view (scrubber does not decide the field)', () => {
    const rule = legacyRule('greater_than', '150');
    const remap = buildMagnitudeRemap([150]);
    const result = scrubRule(rule, { ruleIndex: 5, magnitudeRemap: remap, dateRemap: new Map() });
    expect(result.legacyView).toEqual({
      kind: 'passthrough',
      conditionType: 'greater_than',
      conditionValue: String(remap.get(150)),
    });
    expect(result.legacyView).not.toHaveProperty('items');
  });

  it('view discriminants agree with the representation origin for every origin', () => {
    const cases: Array<{ rule: RuleLike; remap: Map<number, number>; expected: 'json' | 'legacy' | 'both' }> = [
      { rule: jsonRule([{ type: 'description_contains', value: 'x' }]), remap: new Map(), expected: 'json' },
      { rule: legacyRule('greater_than', '150'), remap: buildMagnitudeRemap([150]), expected: 'legacy' },
      {
        rule: { conditions: [{ type: 'amount_lt', value: 40 }], conditionType: 'amount_less', conditionValue: '40' },
        remap: buildMagnitudeRemap([40]),
        expected: 'both',
      },
    ];
    for (const { rule, remap, expected } of cases) {
      const result = scrubRule(rule, { ruleIndex: 6, magnitudeRemap: remap, dateRemap: new Map() });
      expect(result.representationOrigin).toBe(expected);
      if (expected === 'legacy') {
        expect(result.legacyView.kind).toBe('passthrough');
        expect(result.v2View.kind).toBe('stored');
      } else {
        expect(result.legacyView.kind).toBe('reverseMap');
        expect(result.v2View.kind).toBe('canonical');
      }
    }
  });
});

describe('scrubber constants, transforms and canary exclusion', () => {
  it('pins SCRUBBER_VERSION as the single source of truth', () => {
    expect(SCRUBBER_VERSION).toBe('bre010-scrub-1.0.0');
  });

  it('pins the sentinel constants', () => {
    expect(STRING_CANARY).toBe('BRE010_CANARY_STR_9f1c2d3e');
    expect(NUMERIC_CANARY).toBe(424242.42);
  });

  it('remaps magnitudes order- and equality-preserving into [100, 10000]', () => {
    const remap = buildMagnitudeRemap([1, 1, 5, 50, 500, 5000]);
    const values = [...remap.values()];
    expect(values[0]).toBe(MAGNITUDE_REMAP_RANGE.min);
    expect(values[values.length - 1]).toBe(MAGNITUDE_REMAP_RANGE.max);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(MAGNITUDE_REMAP_RANGE.min);
      expect(value).toBeLessThanOrEqual(MAGNITUDE_REMAP_RANGE.max);
    }
    expect(remap.get(1)).not.toBe(remap.get(5));
  });

  it('the magnitude remap can never produce the numeric canary 424242.42', () => {
    const wide = Array.from({ length: 2000 }, (_, i) => i + 1);
    const remap = buildMagnitudeRemap(wide);
    const values = [...remap.values()];
    expect(values).not.toContain(NUMERIC_CANARY);
    expect(Math.max(...values)).toBeLessThan(NUMERIC_CANARY);
    expect(Math.max(...values)).toBeLessThanOrEqual(MAGNITUDE_REMAP_RANGE.max);

    const edge = buildMagnitudeRemap(Array.from({ length: 9901 }, (_, i) => i + 1));
    expect([...edge.values()]).not.toContain(NUMERIC_CANARY);
    expect(Math.max(...edge.values())).toBe(MAGNITUDE_REMAP_RANGE.max);
  });

  it('fails closed when the distinct magnitudes cannot fit the interval', () => {
    expect(() => buildMagnitudeRemap(Array.from({ length: 9902 }, (_, i) => i + 1))).toThrow(
      ScrubPolicyError,
    );
  });

  it('preserves the wildcard verbatim and tokens all other strings', () => {
    expect(scrubStringValue('*')).toBe('*');
    const token = scrubStringValue('Mercado Libre SA');
    expect(token).toMatch(/^token-[0-9a-f]{8}$/);
    expect(token).not.toContain('Mercado');
    expect(token).not.toBe(STRING_CANARY);
  });

  it('keeps the string canary out of the token namespace by construction', () => {
    const token = scrubStringValue(STRING_CANARY);
    expect(token).toMatch(/^token-[0-9a-f]{8}$/);
    expect(token).not.toBe(STRING_CANARY);
  });

  it('scrubs regex values to the safe corpus or the canonical invalid marker', () => {
    const valid = scrubRegexValue('^COMERCIAL.*CARGO$');
    expect(valid.isValid).toBe(true);
    expect(valid.pattern).not.toContain('COMERCIAL');
    expect(scrubRegexValue('[')).toEqual({ pattern: '[', isValid: false });
  });

  it('scrubs dates to deterministic fixed offsets from FIXED_DATE', () => {
    const dateRemap = buildDateRemap(['2025-01-15T00:00:00.000Z', '2026-03-10T00:00:00.000Z']);
    const base = new Date(Date.parse(FIXED_DATE)).toISOString();
    expect(scrubDateValue('2025-01-15T00:00:00.000Z', dateRemap)).toBe(base);
    expect(scrubDateValue('2026-03-10T00:00:00.000Z', dateRemap)).toBe(
      new Date(Date.parse(FIXED_DATE) + 86400000).toISOString(),
    );
    const scrubbed = scrubCanonicalConditions(
      [{ type: 'date_before', value: '2025-01-15T00:00:00.000Z' }],
      new Map(),
      dateRemap,
    );
    expect(scrubbed[0].value).toBe(base);
  });

  it('scrubs entity_eq to a fixed synthetic id', () => {
    const scrubbed = scrubCanonicalConditions(
      [{ type: 'entity_eq', value: 'clx-real-entity' }],
      new Map(),
      new Map(),
    );
    expect(scrubbed[0].value).toBe('entity-scrubbed-1');
  });

  it('scrubs legacy amount columns to the remapped magnitude and legacy strings to tokens', () => {
    const remap = buildMagnitudeRemap([250.5]);
    expect(scrubLegacyColumns({ conditionType: 'greater_than', conditionValue: '250.5' }, remap)).toEqual({
      conditionType: 'greater_than',
      conditionValue: String(remap.get(250.5)),
    });
    expect(scrubLegacyColumns({ conditionType: 'contains', conditionValue: 'foo' }, new Map())).toEqual({
      conditionType: 'contains',
      conditionValue: expect.stringMatching(/^token-[0-9a-f]{8}$/),
    });
    expect(scrubLegacyColumns({ conditionType: 'contains', conditionValue: '*' }, new Map())).toEqual({
      conditionType: 'contains',
      conditionValue: '*',
    });
  });

  it('scrubs rule identity fields deterministically', () => {
    const remap = buildMagnitudeRemap([100]);
    const result = scrubRule(
      jsonRule([{ type: 'description_contains', value: 'x' }]),
      { ruleIndex: 7, magnitudeRemap: remap, dateRemap: new Map() },
    );
    expect(result.id).toBe('scrubbed-rule-7');
    expect(result.name).toBe('rule-7');
    expect(result.companyId).toBe('company-scrubbed-1');
  });

  it('exposes a deterministic scrubMagnitudeValue consistent with the remap', () => {
    const remap = buildMagnitudeRemap([-250.5]);
    expect(scrubMagnitudeValue('-250.5', remap)).toBe(remap.get(250.5));
  });
});
