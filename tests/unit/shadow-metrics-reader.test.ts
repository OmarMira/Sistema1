import { describe, it, expect } from 'vitest';
import { NextResponse } from 'next/server';
import { parseDateOrError } from '@/app/api/admin/shadow-metrics/route';
import {
  ShadowMetricsReader,
} from '@/lib/services/shadow-metrics-reader';
import type {
  AuditLogRepository,
  ShadowMetricsQuery,
  ShadowAuditLogRecord,
  ShadowMetricsReport,
} from '@/lib/services/shadow-metrics-reader';

// ─── Helpers ─────────────────────────────────────────────────────────

// Note: the reader pipeline is agnostic to the `action` field — it only
// reads entity + details. The real Prisma repository filters by
// action: 'RULE_PRECEDENCE_SHADOW_SUMMARY'. Both are exercised here.
function makeRecord(overrides: Partial<ShadowAuditLogRecord> & { details: string | null }): ShadowAuditLogRecord {
  return {
    id: 'r1',
    companyId: 'c1',
    action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
    entity: 'BankStatement',
    entityId: 'stmt-1',
    details: overrides.details,
    createdAt: new Date('2025-01-15'),
    ...overrides,
  };
}

function makeQuery(overrides?: Partial<ShadowMetricsQuery>): ShadowMetricsQuery {
  return {
    companyId: 'c1',
    source: 'ALL',
    from: new Date('2025-01-01'),
    to: new Date('2025-02-01'),
    trustPolicy: 'TRUSTED_ONLY',
    ...overrides,
  };
}

class FakeRepo implements AuditLogRepository {
  records: ShadowAuditLogRecord[] = [];

  async findShadowSummaries(): Promise<ShadowAuditLogRecord[]> {
    return this.records;
  }
}

function readerWithRecords(records: ShadowAuditLogRecord[]): ShadowMetricsReader {
  const repo = new FakeRepo();
  repo.records = records;
  return new ShadowMetricsReader(repo);
}

// ─── Pipeline unit tests ─────────────────────────────────────────────

describe('parseJson', () => {
  it('rejects null details', async () => {
    const r = readerWithRecords([makeRecord({ details: null })]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects empty string', async () => {
    const r = readerWithRecords([makeRecord({ details: '' })]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects malformed JSON', async () => {
    const r = readerWithRecords([makeRecord({ details: '{"bad":"json"' })]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects non-object JSON (array)', async () => {
    const r = readerWithRecords([makeRecord({ details: '[]' })]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects non-object JSON (string)', async () => {
    const r = readerWithRecords([makeRecord({ details: '"hello"' })]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });
});

describe('detectSchema', () => {
  it('detects V0 BankStatement (Import)', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
          productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
          differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.trustedBatches).toBe(0);
    expect(report.legacyBatches).toBe(1);
    expect(report.batches).toBe(1);
  });

  it('detects V0 ApplyAllBatch (Apply All)', async () => {
    const r = readerWithRecords([
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, differentWinner: 5,
          shadowErrors: 3, divergenceReasons: { NO_MATCH: 1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.batches).toBe(1);
    expect(report.legacyUntrustedBatches).toBe(1);
  });

  it('detects V1 Import', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1,
          source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
          },
        }),
      }),
    ]);
    const report = await r.read(makeQuery());
    expect(report.trustedBatches).toBe(1);
    expect(report.invalidRecords).toBe(0);
  });

  it('detects V1 Apply All', async () => {
    const r = readerWithRecords([
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          schemaVersion: 1,
          source: 'APPLY_ALL',
          metrics: {
            totalEvaluated: 50, sameWinner: 40, differentWinner: 5,
            shadowErrors: 3, divergenceReasons: { NO_MATCH: 1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
          },
        }),
      }),
    ]);
    const report = await r.read(makeQuery());
    expect(report.trustedBatches).toBe(1);
  });

  it('rejects unsupported version (> 1)', async () => {
    const r = readerWithRecords([
      makeRecord({
        details: JSON.stringify({
          schemaVersion: 2,
          source: 'IMPORT',
          metrics: { totalEvaluated: 10, sameWinner: 10 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects source/entity mismatch', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1,
          source: 'APPLY_ALL',
          metrics: { totalEvaluated: 10, sameWinner: 10 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects V1 Import with divergenceReasons', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1,
          source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
            divergenceReasons: { NO_MATCH: 0, AMBIGUOUS: 0, UNDETERMINED: 0, OTHER: 0 },
          },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects V1 Apply All with Import-only fields', async () => {
    const r = readerWithRecords([
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          schemaVersion: 1,
          source: 'APPLY_ALL',
          metrics: {
            totalEvaluated: 50, sameWinner: 40, differentWinner: 5,
            shadowErrors: 3, bothNoMatch: 2,
            divergenceReasons: { NO_MATCH: 1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
          },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects buggy fixture schema (diverged field)', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 1, sameWinner: 1, diverged: 0, errors: 0,
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });
});

describe('validateInvariants', () => {
  it('rejects negative counter (Import)', async () => {
    const r = readerWithRecords([
      makeRecord({
        details: JSON.stringify({
          totalEvaluated: 100, sameWinner: -1, bothNoMatch: 5,
          productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
          differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects non-finite counter (Import)', async () => {
    const r = readerWithRecords([
      makeRecord({
        details: JSON.stringify({
          totalEvaluated: 100, sameWinner: Infinity, bothNoMatch: 5,
          productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
          differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects Import sum mismatch', async () => {
    const r = readerWithRecords([
      makeRecord({
        details: JSON.stringify({
          totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
          productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
          differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 1, // sum = 99
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects negative divergenceReasons counter', async () => {
    const r = readerWithRecords([
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, differentWinner: 5,
          shadowErrors: 3, divergenceReasons: { NO_MATCH: -1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects Apply All differentWinner !== UNDETERMINED', async () => {
    const r = readerWithRecords([
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, differentWinner: 10,
          shadowErrors: 3, divergenceReasons: { NO_MATCH: 1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });

  it('rejects negative sameDecision (Apply All)', async () => {
    const r = readerWithRecords([
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 10, sameWinner: 0, differentWinner: 5,
          shadowErrors: 1, divergenceReasons: { NO_MATCH: 5, AMBIGUOUS: 5, UNDETERMINED: 5, OTHER: 0 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.invalidRecords).toBe(1);
  });
});

describe('normalize', () => {
  it('classifies V1 Import as TRUSTED', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1,
          source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
          },
        }),
      }),
    ]);
    const report = await r.read(makeQuery());
    expect(report.trustedBatches).toBe(1);
    expect(report.legacyBatches).toBe(0);
    expect(report.legacyUntrustedBatches).toBe(0);
  });

  it('classifies V0 Import as LEGACY', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
          productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
          differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.legacyBatches).toBe(1);
  });

  it('classifies V0 Apply All as LEGACY_UNTRUSTED', async () => {
    const r = readerWithRecords([
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, differentWinner: 5,
          shadowErrors: 3, divergenceReasons: { NO_MATCH: 1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.legacyUntrustedBatches).toBe(1);
  });

  it('maps Import fields to normalized shape', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
          productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
          differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.totalEvaluated).toBe(100);
    // sameDecision = sameWinner 80 + bothNoMatch 5 = 85
    expect(report.sameDecision).toBe(85);
    // divergentDecision = productiveMatchCanonicalNoMatch 3 + productiveNoMatchCanonicalMatch 2 + differentWinner 5 = 10
    expect(report.divergentDecision).toBe(10);
    expect(report.ambiguous).toBe(3);
    expect(report.errors).toBe(2);
    expect(report.reasons.NO_MATCH).toBe(5); // productiveMatchCanonicalNoMatch + productiveNoMatchCanonicalMatch
    expect(report.reasons.UNDETERMINED).toBe(5);
  });
});

describe('aggregate', () => {
  it('filters by TRUSTED_ONLY by default', async () => {
    const r = readerWithRecords([
      // V1 trusted
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1, source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
          },
        }),
      }),
      // V0 legacy — excluded by TRUSTED_ONLY
      makeRecord({
        id: 'r2',
        entity: 'BankStatement',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, bothNoMatch: 2,
          productiveMatchCanonicalNoMatch: 1, productiveNoMatchCanonicalMatch: 1,
          differentWinner: 3, canonicalAmbiguous: 2, shadowErrors: 1,
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'TRUSTED_ONLY' }));
    expect(report.batches).toBe(2);
    expect(report.trustedBatches).toBe(1);
    expect(report.legacyBatches).toBe(1);
    // Only V1 counted in aggregations
    expect(report.totalEvaluated).toBe(100);
  });

  it('includes LEGACY with INCLUDE_LEGACY_IMPORT policy', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1, source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
          },
        }),
      }),
      makeRecord({
        id: 'r2',
        entity: 'BankStatement',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, bothNoMatch: 2,
          productiveMatchCanonicalNoMatch: 1, productiveNoMatchCanonicalMatch: 1,
          differentWinner: 3, canonicalAmbiguous: 2, shadowErrors: 1,
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_LEGACY_IMPORT' }));
    expect(report.totalEvaluated).toBe(150);
  });

  it('excludes LEGACY_UNTRUSTED from INCLUDE_LEGACY_IMPORT', async () => {
    const r = readerWithRecords([
      // V0 Apply All
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, differentWinner: 5,
          shadowErrors: 3, divergenceReasons: { NO_MATCH: 1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_LEGACY_IMPORT' }));
    expect(report.batches).toBe(1);
    expect(report.totalEvaluated).toBe(0); // excluded from aggregation
  });

  it('includes everything with INCLUDE_UNTRUSTED_HISTORY', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1, source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
          },
        }),
      }),
      makeRecord({
        id: 'r2',
        entity: 'BankStatement',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, bothNoMatch: 2,
          productiveMatchCanonicalNoMatch: 1, productiveNoMatchCanonicalMatch: 1,
          differentWinner: 3, canonicalAmbiguous: 2, shadowErrors: 1,
        }),
      }),
      makeRecord({
        id: 'r3',
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 30, sameWinner: 25, differentWinner: 2,
          shadowErrors: 1, divergenceReasons: { NO_MATCH: 0, AMBIGUOUS: 1, UNDETERMINED: 2, OTHER: 0 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.batches).toBe(3);
    expect(report.totalEvaluated).toBe(180);
    expect(report.trustedBatches).toBe(1);
    expect(report.legacyBatches).toBe(1);
    expect(report.legacyUntrustedBatches).toBe(1);
  });

  it('computes rates correctly', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1, source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
          },
        }),
      }),
    ]);
    const report = await r.read(makeQuery());
    // totalEvaluated=100, errors=2 => validComparisons=98
    // sameDecision=85, divergentDecision=10, ambiguous=3
    // agreementRate = 85/98 ≈ 0.867
    expect(report.validComparisons).toBe(98);
    expect(report.agreementRate).toBeCloseTo(85 / 98, 5);
    expect(report.divergenceRate).toBeCloseTo(10 / 98, 5);
    expect(report.ambiguityRate).toBeCloseTo(3 / 98, 5);
    expect(report.errorRate).toBeCloseTo(2 / 100, 5);
  });

  it('returns null rates when no valid comparisons', async () => {
    const report = await readerWithRecords([]).read(makeQuery());
    expect(report.totalEvaluated).toBe(0);
    expect(report.validComparisons).toBe(0);
    expect(report.agreementRate).toBeNull();
    expect(report.divergenceRate).toBeNull();
    expect(report.ambiguityRate).toBeNull();
    expect(report.errorRate).toBeNull();
  });
});

describe('ShadowMetricsReader (integration)', () => {
  it('processes empty records', async () => {
    const report = await readerWithRecords([]).read(makeQuery());
    expect(report.batches).toBe(0);
    expect(report.totalEvaluated).toBe(0);
    expect(report.invalidRecords).toBe(0);
  });

  it('rejects null details', async () => {
    const r = readerWithRecords([
      makeRecord({ details: null }),
      makeRecord({ details: null }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.batches).toBe(2);
    expect(report.invalidRecords).toBe(2);
  });

  it('filters by source: IMPORT only', async () => {
    const r = readerWithRecords([
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1, source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
          },
        }),
      }),
      makeRecord({
        id: 'r2',
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          schemaVersion: 1, source: 'APPLY_ALL',
          metrics: {
            totalEvaluated: 50, sameWinner: 40, differentWinner: 5,
            shadowErrors: 3, divergenceReasons: { NO_MATCH: 1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
          },
        }),
      }),
    ]);
    // source: IMPORT means DB filter returns only BankStatement records
    const repo = new FakeRepo();
    repo.records = [
      makeRecord({
        entity: 'BankStatement',
        details: JSON.stringify({
          schemaVersion: 1, source: 'IMPORT',
          metrics: {
            totalEvaluated: 100, sameWinner: 80, bothNoMatch: 5,
            productiveMatchCanonicalNoMatch: 3, productiveNoMatchCanonicalMatch: 2,
            differentWinner: 5, canonicalAmbiguous: 3, shadowErrors: 2,
          },
        }),
      }),
    ];
    const reader = new ShadowMetricsReader(repo);
    const report = await reader.read(makeQuery({ source: 'IMPORT' }));
    expect(report.batches).toBe(1);
    expect(report.totalEvaluated).toBe(100);
  });

  it('computes Apply All normalized values correctly', async () => {
    // totalEvaluated=50, errors=3 => validComparisons=47
    // divergentDecision = NO_MATCH(1) + OTHER(0) + UNDETERMINED(5) = 6
    // sameDecision = 47 - 6 - AMBIGUOUS(1) = 40
    const r = readerWithRecords([
      makeRecord({
        action: 'APPLY_ALL',
        entity: 'ApplyAllBatch',
        details: JSON.stringify({
          totalEvaluated: 50, sameWinner: 40, differentWinner: 5,
          shadowErrors: 3, divergenceReasons: { NO_MATCH: 1, AMBIGUOUS: 1, UNDETERMINED: 5, OTHER: 0 },
        }),
      }),
    ]);
    const report = await r.read(makeQuery({ trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY' }));
    expect(report.totalEvaluated).toBe(50);
    expect(report.sameDecision).toBe(40);
    expect(report.divergentDecision).toBe(6);
    expect(report.ambiguous).toBe(1);
    expect(report.errors).toBe(3);
    expect(report.reasons.NO_MATCH).toBe(1);
    expect(report.reasons.UNDETERMINED).toBe(5);
  });
});

// ─── Route validation ────────────────────────────────────────────────

describe('parseDateOrError', () => {
  it('returns a Date for valid ISO strings', () => {
    const result = parseDateOrError('2025-01-15', 'from');
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toContain('2025-01-15');
  });

  it('returns a Date for valid date-time strings', () => {
    const result = parseDateOrError('2025-01-15T10:30:00Z', 'from');
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toContain('2025-01-15');
  });

  it('returns NextResponse with status 400 for invalid dates', () => {
    const result = parseDateOrError('not-a-date', 'from');
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it('returns NextResponse with status 400 for garbage strings', () => {
    const result = parseDateOrError('', 'to');
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });
});
