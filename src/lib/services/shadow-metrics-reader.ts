// ─── Payload types by source and version ─────────────────────────────

export interface ImportMetricsV0 {
  totalEvaluated: number;
  sameWinner: number;
  bothNoMatch: number;
  productiveMatchCanonicalNoMatch: number;
  productiveNoMatchCanonicalMatch: number;
  differentWinner: number;
  canonicalAmbiguous: number;
  shadowErrors: number;
}

export interface ApplyAllMetricsV0 {
  totalEvaluated: number;
  sameWinner: number;
  differentWinner: number;
  shadowErrors: number;
  divergenceReasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}

export interface ImportMetricsV1 {
  totalEvaluated: number;
  sameWinner: number;
  bothNoMatch: number;
  productiveMatchCanonicalNoMatch: number;
  productiveNoMatchCanonicalMatch: number;
  differentWinner: number;
  canonicalAmbiguous: number;
  shadowErrors: number;
}

export interface ApplyAllMetricsV1 {
  totalEvaluated: number;
  sameWinner: number;
  differentWinner: number;
  shadowErrors: number;
  divergenceReasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}

export type ShadowMetricsEnvelopeV1 =
  | {
      schemaVersion: 1;
      source: 'IMPORT';
      metrics: ImportMetricsV1;
    }
  | {
      schemaVersion: 1;
      source: 'APPLY_ALL';
      metrics: ApplyAllMetricsV1;
    };

// ─── Pipeline types ──────────────────────────────────────────────────

export type ShadowRecordTrust = 'TRUSTED' | 'LEGACY' | 'LEGACY_UNTRUSTED' | 'INVALID';

export type ShadowMetricsTrustPolicy =
  | 'TRUSTED_ONLY'
  | 'INCLUDE_LEGACY_IMPORT'
  | 'INCLUDE_UNTRUSTED_HISTORY';

export type ShadowRecordRejectionReason =
  | 'DETAILS_MISSING'
  | 'INVALID_JSON'
  | 'UNKNOWN_SCHEMA'
  | 'UNSUPPORTED_VERSION'
  | 'SOURCE_ENTITY_MISMATCH'
  | 'INVALID_FIELD_TYPE'
  | 'NEGATIVE_COUNTER'
  | 'NON_FINITE_COUNTER'
  | 'INVARIANT_VIOLATION'
  | 'BUGGY_FIXTURE_SCHEMA';

export type DetectedShadowRecord =
  | {
      source: 'IMPORT';
      version: 'V0';
      entity: 'BankStatement';
      payload: ImportMetricsV0;
    }
  | {
      source: 'IMPORT';
      version: 'V1';
      entity: 'BankStatement';
      payload: ImportMetricsV1;
    }
  | {
      source: 'APPLY_ALL';
      version: 'V0';
      entity: 'ApplyAllBatch';
      payload: ApplyAllMetricsV0;
    }
  | {
      source: 'APPLY_ALL';
      version: 'V1';
      entity: 'ApplyAllBatch';
      payload: ApplyAllMetricsV1;
    };

export interface ValidShadowRecord {
  detected: DetectedShadowRecord;
}

export interface NormalizedShadowRecord {
  trust: ShadowRecordTrust;
  source: 'IMPORT' | 'APPLY_ALL';
  totalEvaluated: number;
  sameDecision: number;
  divergentDecision: number;
  ambiguous: number;
  errors: number;
  reasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}

export type ShadowRecordProcessingResult =
  | { kind: 'normalized'; record: NormalizedShadowRecord }
  | { kind: 'rejected'; trust: 'INVALID'; reason: ShadowRecordRejectionReason };

export interface ShadowMetricsQuery {
  companyId: string;
  source: 'IMPORT' | 'APPLY_ALL' | 'ALL';
  from: Date;
  to: Date;
  trustPolicy: ShadowMetricsTrustPolicy;
}

export interface ShadowMetricsReport {
  batches: number;
  trustedBatches: number;
  legacyBatches: number;
  legacyUntrustedBatches: number;
  invalidRecords: number;

  totalEvaluated: number;
  validComparisons: number;
  sameDecision: number;
  divergentDecision: number;
  ambiguous: number;
  errors: number;

  agreementRate: number | null;
  divergenceRate: number | null;
  ambiguityRate: number | null;
  errorRate: number | null;

  reasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}

export interface ShadowAuditLogRecord {
  id: string;
  companyId: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  createdAt: Date;
}

export interface AuditLogRepository {
  findShadowSummaries(query: ShadowMetricsQuery): Promise<ShadowAuditLogRecord[]>;
}

// ─── StageResult ─────────────────────────────────────────────────────

type StageResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ShadowRecordRejectionReason };

// ─── Raw JSON type ───────────────────────────────────────────────────

type RawJson = Record<string, unknown>;

// ─── Pipeline functions ──────────────────────────────────────────────

function parseJson(details: string | null): StageResult<RawJson> {
  if (details === null) {
    return { ok: false, reason: 'DETAILS_MISSING' };
  }
  if (details === '') {
    return { ok: false, reason: 'INVALID_JSON' };
  }
  try {
    const parsed = JSON.parse(details);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'INVALID_JSON' };
    }
    return { ok: true, value: parsed as RawJson };
  } catch {
    return { ok: false, reason: 'INVALID_JSON' };
  }
}

function hasField(obj: RawJson, field: string): boolean {
  return field in obj;
}

function isNumberField(obj: RawJson, field: string): boolean {
  return typeof obj[field] === 'number' && !Array.isArray(obj[field]);
}

const IMPORT_V0_FIELDS = [
  'totalEvaluated', 'sameWinner', 'bothNoMatch',
  'productiveMatchCanonicalNoMatch', 'productiveNoMatchCanonicalMatch',
  'differentWinner', 'canonicalAmbiguous', 'shadowErrors',
] as const;

const APPLY_ALL_V0_FIELDS = [
  'totalEvaluated', 'sameWinner', 'differentWinner', 'shadowErrors', 'divergenceReasons',
] as const;

const IMPORT_ONLY_V1_FIELDS = new Set([
  'bothNoMatch', 'productiveMatchCanonicalNoMatch',
  'productiveNoMatchCanonicalMatch', 'canonicalAmbiguous',
]);

const APPLY_ALL_ONLY_V1_FIELDS = new Set(['divergenceReasons']);

function validateObjCounters(obj: RawJson, fields: readonly string[]): StageResult<true> {
  for (const f of fields) {
    if (f === 'divergenceReasons') continue;
    if (!hasField(obj, f) || !isNumberField(obj, f)) {
      return { ok: false, reason: 'INVALID_FIELD_TYPE' };
    }
  }
  return { ok: true, value: true as const };
}

function validateDivergenceReasonsObj(dr: unknown): StageResult<ApplyAllMetricsV0['divergenceReasons']> {
  if (typeof dr !== 'object' || dr === null || Array.isArray(dr)) {
    return { ok: false, reason: 'INVALID_FIELD_TYPE' };
  }
  const m = dr as Record<string, unknown>;
  for (const key of ['NO_MATCH', 'AMBIGUOUS', 'UNDETERMINED', 'OTHER']) {
    if (typeof m[key] !== 'number') {
      return { ok: false, reason: 'INVALID_FIELD_TYPE' };
    }
  }
  return {
    ok: true,
    value: {
      NO_MATCH: m.NO_MATCH as number,
      AMBIGUOUS: m.AMBIGUOUS as number,
      UNDETERMINED: m.UNDETERMINED as number,
      OTHER: m.OTHER as number,
    },
  };
}

function detectSchema(raw: RawJson, entity: string): StageResult<DetectedShadowRecord> {
  const schemaVersion = raw.schemaVersion;

  // ── V1 detection ────────────────────────────────────────────────
  if (schemaVersion === 1) {
    const source = raw.source;
    if (!hasField(raw, 'metrics')) {
      return { ok: false, reason: 'INVALID_FIELD_TYPE' };
    }
    const metrics = raw.metrics as RawJson;
    if (typeof metrics !== 'object' || metrics === null) {
      return { ok: false, reason: 'INVALID_FIELD_TYPE' };
    }

    if (source === 'IMPORT') {
      if (entity !== 'BankStatement') {
        return { ok: false, reason: 'SOURCE_ENTITY_MISMATCH' };
      }
      if (hasField(metrics, 'divergenceReasons')) {
        return { ok: false, reason: 'INVALID_FIELD_TYPE' };
      }
      const check = validateObjCounters(metrics, IMPORT_V0_FIELDS);
      if (!check.ok) return check;

      return {
        ok: true,
        value: {
          source: 'IMPORT' as const,
          version: 'V1' as const,
          entity: 'BankStatement' as const,
          payload: {
            totalEvaluated: metrics.totalEvaluated as number,
            sameWinner: metrics.sameWinner as number,
            bothNoMatch: metrics.bothNoMatch as number,
            productiveMatchCanonicalNoMatch: metrics.productiveMatchCanonicalNoMatch as number,
            productiveNoMatchCanonicalMatch: metrics.productiveNoMatchCanonicalMatch as number,
            differentWinner: metrics.differentWinner as number,
            canonicalAmbiguous: metrics.canonicalAmbiguous as number,
            shadowErrors: metrics.shadowErrors as number,
          },
        },
      };
    }

    if (source === 'APPLY_ALL') {
      if (entity !== 'ApplyAllBatch') {
        return { ok: false, reason: 'SOURCE_ENTITY_MISMATCH' };
      }
      for (const f of IMPORT_ONLY_V1_FIELDS) {
        if (hasField(metrics, f)) {
          return { ok: false, reason: 'INVALID_FIELD_TYPE' };
        }
      }
      const fields = ['totalEvaluated', 'sameWinner', 'differentWinner', 'shadowErrors'] as const;
      const check = validateObjCounters(metrics, fields);
      if (!check.ok) return check;

      if (!hasField(metrics, 'divergenceReasons')) {
        return { ok: false, reason: 'INVALID_FIELD_TYPE' };
      }
      const dr = validateDivergenceReasonsObj(metrics.divergenceReasons);
      if (!dr.ok) return dr;
      const { value: drv } = dr;

      return {
        ok: true,
        value: {
          source: 'APPLY_ALL' as const,
          version: 'V1' as const,
          entity: 'ApplyAllBatch' as const,
          payload: {
            totalEvaluated: metrics.totalEvaluated as number,
            sameWinner: metrics.sameWinner as number,
            differentWinner: metrics.differentWinner as number,
            shadowErrors: metrics.shadowErrors as number,
            divergenceReasons: drv,
          },
        },
      };
    }

    return { ok: false, reason: 'UNKNOWN_SCHEMA' };
  }

  // ── V0 / versionless detection ───────────────────────────────────
  // Fixture contamination check
  if (hasField(raw, 'diverged') || hasField(raw, 'errors')) {
    return { ok: false, reason: 'BUGGY_FIXTURE_SCHEMA' };
  }

  if (entity === 'BankStatement') {
    const allPresent = IMPORT_V0_FIELDS.every((f) => hasField(raw, f));
    if (!allPresent) {
      return { ok: false, reason: 'UNKNOWN_SCHEMA' };
    }
    const check = validateObjCounters(raw, IMPORT_V0_FIELDS);
    if (!check.ok) return check;

    return {
      ok: true,
      value: {
        source: 'IMPORT' as const,
        version: 'V0' as const,
        entity: 'BankStatement' as const,
        payload: {
          totalEvaluated: raw.totalEvaluated as number,
          sameWinner: raw.sameWinner as number,
          bothNoMatch: raw.bothNoMatch as number,
          productiveMatchCanonicalNoMatch: raw.productiveMatchCanonicalNoMatch as number,
          productiveNoMatchCanonicalMatch: raw.productiveNoMatchCanonicalMatch as number,
          differentWinner: raw.differentWinner as number,
          canonicalAmbiguous: raw.canonicalAmbiguous as number,
          shadowErrors: raw.shadowErrors as number,
        },
      },
    };
  }

  if (entity === 'ApplyAllBatch') {
    const allPresent = APPLY_ALL_V0_FIELDS.every((f) => hasField(raw, f));
    if (!allPresent) {
      return { ok: false, reason: 'UNKNOWN_SCHEMA' };
    }
    const check = validateObjCounters(raw, APPLY_ALL_V0_FIELDS);
    if (!check.ok) return check;
    const dr = validateDivergenceReasonsObj(raw.divergenceReasons);
    if (!dr.ok) return dr;
    const { value: drv } = dr;

    return {
      ok: true,
      value: {
        source: 'APPLY_ALL' as const,
        version: 'V0' as const,
        entity: 'ApplyAllBatch' as const,
        payload: {
          totalEvaluated: raw.totalEvaluated as number,
          sameWinner: raw.sameWinner as number,
          differentWinner: raw.differentWinner as number,
          shadowErrors: raw.shadowErrors as number,
          divergenceReasons: drv,
        },
      },
    };
  }

  if (hasField(raw, 'schemaVersion') && typeof raw.schemaVersion === 'number' && raw.schemaVersion > 1) {
    return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  }

  return { ok: false, reason: 'UNKNOWN_SCHEMA' };
}

function validateInvariants(detected: DetectedShadowRecord): StageResult<ValidShadowRecord> {
  function isNonNegativeFinite(n: number): boolean {
    return typeof n === 'number' && isFinite(n) && n >= 0;
  }

  function isFiniteNumber(n: number): boolean {
    return typeof n === 'number' && isFinite(n);
  }

  function checkAllNonNegative(record: Record<string, number>): string | null {
    for (const [key, val] of Object.entries(record)) {
      if (!isNonNegativeFinite(val)) {
        if (!isFiniteNumber(val)) return 'NON_FINITE_COUNTER';
        return 'NEGATIVE_COUNTER';
      }
    }
    return null;
  }

  switch (detected.source) {
    case 'IMPORT': {
      const p = detected.payload;
      const err = checkAllNonNegative({
        totalEvaluated: p.totalEvaluated,
        sameWinner: p.sameWinner,
        bothNoMatch: p.bothNoMatch,
        productiveMatchCanonicalNoMatch: p.productiveMatchCanonicalNoMatch,
        productiveNoMatchCanonicalMatch: p.productiveNoMatchCanonicalMatch,
        differentWinner: p.differentWinner,
        canonicalAmbiguous: p.canonicalAmbiguous,
        shadowErrors: p.shadowErrors,
      });
      if (err) return { ok: false, reason: err as 'NEGATIVE_COUNTER' | 'NON_FINITE_COUNTER' };

      const sum = p.sameWinner + p.bothNoMatch + p.productiveMatchCanonicalNoMatch
        + p.productiveNoMatchCanonicalMatch + p.differentWinner + p.canonicalAmbiguous
        + p.shadowErrors;
      if (sum !== p.totalEvaluated) {
        return { ok: false, reason: 'INVARIANT_VIOLATION' };
      }
      return { ok: true, value: { detected } };
    }

    case 'APPLY_ALL': {
      const p = detected.payload;
      const err = checkAllNonNegative({
        totalEvaluated: p.totalEvaluated,
        sameWinner: p.sameWinner,
        differentWinner: p.differentWinner,
        shadowErrors: p.shadowErrors,
      });
      if (err) return { ok: false, reason: err as 'NEGATIVE_COUNTER' | 'NON_FINITE_COUNTER' };

      for (const key of ['NO_MATCH', 'AMBIGUOUS', 'UNDETERMINED', 'OTHER'] as const) {
        if (!isNonNegativeFinite(p.divergenceReasons[key])) {
          return { ok: false, reason: 'NEGATIVE_COUNTER' };
        }
      }

      if (p.differentWinner !== p.divergenceReasons.UNDETERMINED) {
        return { ok: false, reason: 'INVARIANT_VIOLATION' };
      }

      // sameDecision = totalEvaluated - (divergentDecision + ambiguous + errors)
      // Derive sameDecision >= 0
      const divergentDecision = p.divergenceReasons.NO_MATCH
        + p.divergenceReasons.OTHER
        + p.divergenceReasons.UNDETERMINED;
      const validComparisons = p.totalEvaluated - p.shadowErrors;
      const sameDecision = validComparisons - divergentDecision - p.divergenceReasons.AMBIGUOUS;
      if (sameDecision < 0) {
        return { ok: false, reason: 'INVARIANT_VIOLATION' };
      }
      return { ok: true, value: { detected } };
    }
  }
}

function classifyTrust(detected: DetectedShadowRecord): ShadowRecordTrust {
  if (detected.version === 'V1') return 'TRUSTED';
  if (detected.source === 'IMPORT' && detected.version === 'V0') return 'LEGACY';
  if (detected.source === 'APPLY_ALL' && detected.version === 'V0') return 'LEGACY_UNTRUSTED';
  return 'INVALID';
}

function normalize(valid: ValidShadowRecord): NormalizedShadowRecord {
  const { detected } = valid;
  const trust = classifyTrust(detected);

  switch (detected.source) {
    case 'IMPORT': {
      const p = detected.payload;
      const sameDecision = p.sameWinner + p.bothNoMatch;
      const divergentDecision = p.productiveMatchCanonicalNoMatch
        + p.productiveNoMatchCanonicalMatch
        + p.differentWinner;
      const ambiguous = p.canonicalAmbiguous;
      const errors = p.shadowErrors;

      return {
        trust,
        source: 'IMPORT',
        totalEvaluated: p.totalEvaluated,
        sameDecision,
        divergentDecision,
        ambiguous,
        errors,
        reasons: {
          NO_MATCH: p.productiveMatchCanonicalNoMatch + p.productiveNoMatchCanonicalMatch,
          AMBIGUOUS: p.canonicalAmbiguous,
          UNDETERMINED: p.differentWinner,
          OTHER: 0,
        },
      };
    }

    case 'APPLY_ALL': {
      const p = detected.payload;
      const divergentDecision = p.divergenceReasons.NO_MATCH
        + p.divergenceReasons.OTHER
        + p.divergenceReasons.UNDETERMINED;
      const ambiguous = p.divergenceReasons.AMBIGUOUS;
      const errors = p.shadowErrors;
      const validComparisons = p.totalEvaluated - errors;
      const sameDecision = validComparisons - divergentDecision - ambiguous;

      return {
        trust,
        source: 'APPLY_ALL',
        totalEvaluated: p.totalEvaluated,
        sameDecision,
        divergentDecision,
        ambiguous,
        errors,
        reasons: {
          NO_MATCH: p.divergenceReasons.NO_MATCH,
          AMBIGUOUS: p.divergenceReasons.AMBIGUOUS,
          UNDETERMINED: p.divergenceReasons.UNDETERMINED,
          OTHER: p.divergenceReasons.OTHER,
        },
      };
    }
  }
}

function aggregate(
  results: ShadowRecordProcessingResult[],
  query: ShadowMetricsQuery,
): ShadowMetricsReport {
  const batches = results.length;

  let trustedBatches = 0;
  let legacyBatches = 0;
  let legacyUntrustedBatches = 0;
  let invalidRecords = 0;

  for (const r of results) {
    if (r.kind === 'rejected') {
      invalidRecords++;
    } else {
      switch (r.record.trust) {
        case 'TRUSTED':
          trustedBatches++;
          break;
        case 'LEGACY':
          legacyBatches++;
          break;
        case 'LEGACY_UNTRUSTED':
          legacyUntrustedBatches++;
          break;
      }
    }
  }

  const policy = query.trustPolicy;
  const included = results.filter((r) => {
    if (r.kind === 'rejected') return false;
    switch (policy) {
      case 'TRUSTED_ONLY':
        return r.record.trust === 'TRUSTED';
      case 'INCLUDE_LEGACY_IMPORT':
        return r.record.trust === 'TRUSTED' || r.record.trust === 'LEGACY';
      case 'INCLUDE_UNTRUSTED_HISTORY':
        return true;
    }
  });

  const agg = included.reduce(
    (acc, r) => {
      if (r.kind === 'normalized') {
        acc.totalEvaluated += r.record.totalEvaluated;
        acc.sameDecision += r.record.sameDecision;
        acc.divergentDecision += r.record.divergentDecision;
        acc.ambiguous += r.record.ambiguous;
        acc.errors += r.record.errors;
        acc.reasons.NO_MATCH += r.record.reasons.NO_MATCH;
        acc.reasons.AMBIGUOUS += r.record.reasons.AMBIGUOUS;
        acc.reasons.UNDETERMINED += r.record.reasons.UNDETERMINED;
        acc.reasons.OTHER += r.record.reasons.OTHER;
      }
      return acc;
    },
    {
      totalEvaluated: 0,
      sameDecision: 0,
      divergentDecision: 0,
      ambiguous: 0,
      errors: 0,
      reasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
    },
  );

  const validComparisons = agg.totalEvaluated - agg.errors;

  function rate(num: number, den: number): number | null {
    return den > 0 ? num / den : null;
  }

  return {
    batches,
    trustedBatches,
    legacyBatches,
    legacyUntrustedBatches,
    invalidRecords,
    totalEvaluated: agg.totalEvaluated,
    validComparisons,
    sameDecision: agg.sameDecision,
    divergentDecision: agg.divergentDecision,
    ambiguous: agg.ambiguous,
    errors: agg.errors,
    agreementRate: rate(agg.sameDecision, validComparisons),
    divergenceRate: rate(agg.divergentDecision, validComparisons),
    ambiguityRate: rate(agg.ambiguous, validComparisons),
    errorRate: rate(agg.errors, agg.totalEvaluated),
    reasons: agg.reasons,
  };
}

// ─── ShadowMetricsReader ─────────────────────────────────────────────

export class ShadowMetricsReader {
  constructor(private readonly auditLogRepo: AuditLogRepository) {}

  async read(query: ShadowMetricsQuery): Promise<ShadowMetricsReport> {
    const records = await this.auditLogRepo.findShadowSummaries(query);

    const results: ShadowRecordProcessingResult[] = records.map((record) => {
      const parsed = parseJson(record.details);
      if (!parsed.ok) return { kind: 'rejected', trust: 'INVALID', reason: parsed.reason };

      const detected = detectSchema(parsed.value, record.entity);
      if (!detected.ok) return { kind: 'rejected', trust: 'INVALID', reason: detected.reason };

      const validated = validateInvariants(detected.value);
      if (!validated.ok) return { kind: 'rejected', trust: 'INVALID', reason: validated.reason };

      const normalized = normalize(validated.value);
      return { kind: 'normalized', record: normalized };
    });

    return aggregate(results, query);
  }
}
