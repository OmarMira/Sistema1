# S7-05C — Canonical Readiness Service — Tasks

## File manifest

| # | File | Action |
|---|------|--------|
| 1 | `src/lib/services/canonical-readiness-service.ts` | CREATE |
| 2 | `src/app/api/admin/shadow-metrics/readiness/route.ts` | CREATE |
| 3 | `tests/unit/canonical-readiness-service.test.ts` | CREATE |
| 4 | `tests/api/admin/shadow-metrics-readiness.test.ts` | CREATE |

**Zero changes** in: `shadow-metrics-reader.ts`, `audit-log-repository.ts`,
`rule-precedence-shadow.ts`, `rule-precedence-engine.ts`,
`rule-matching-engine.ts`, `apply-all-engine.ts`, `import.service.ts`,
resolvers, feature flags.

---

## Task 1 — Contracts

**File**: `src/lib/services/canonical-readiness-service.ts`

Define and export:

```typescript
import type { ShadowMetricsReport, ShadowMetricsQuery } from './shadow-metrics-reader';

export interface SampleCriteria {
  minimumEvaluatedTransactions: number;
  minimumBatches: number;
}

export interface QualityCriteria {
  minimumAgreementRate: number;
  maximumDivergenceRate: number;
  maximumAmbiguityRate: number;
}

export interface IntegrityCriteria {
  maximumErrorRate: number;
  maximumInvalidRecordRate: number;
}

export interface ReadinessCriteria {
  sample: SampleCriteria;
  quality: QualityCriteria;
  integrity: IntegrityCriteria;
}

export type ReadinessCheckOperator = '>=' | '<=';

export type ReadinessCheckCode =
  | 'MINIMUM_EVALUATED_TRANSACTIONS'
  | 'MINIMUM_BATCHES'
  | 'MINIMUM_AGREEMENT_RATE'
  | 'MAXIMUM_DIVERGENCE_RATE'
  | 'MAXIMUM_AMBIGUITY_RATE'
  | 'MAXIMUM_ERROR_RATE'
  | 'MAXIMUM_INVALID_RECORD_RATE';

export interface ReadinessCheckResult {
  code: ReadinessCheckCode;
  operator: ReadinessCheckOperator;
  passed: boolean;
  actual: number | null;
  expected: number;
}

interface CanonicalReadinessBase {
  metrics: ShadowMetricsReport;
  checks: ReadinessCheckResult[];
}

export type CanonicalReadiness =
  | (CanonicalReadinessBase & { status: 'READY' })
  | (CanonicalReadinessBase & { status: 'NOT_READY'; failedChecks: ReadinessCheckResult[] })
  | (CanonicalReadinessBase & { status: 'INSUFFICIENT_DATA'; reasons: string[] });
```

### ShadowMetricsProvider

```typescript
export interface ShadowMetricsProvider {
  read(query: ShadowMetricsQuery): Promise<ShadowMetricsReport>;
}
```

---

## Task 2 — Validation

**File**: `src/lib/services/canonical-readiness-service.ts`

`ValidationError` is defined at `src/lib/api-error.ts` (exported from `@/lib/api-error`). Reuse it:

```typescript
import { ValidationError } from '@/lib/api-error';

export function validateReadinessCriteria(criteria: ReadinessCriteria): void {
  // sample
  assertSampleField('minimumEvaluatedTransactions', criteria.sample.minimumEvaluatedTransactions, true);
  assertSampleField('minimumBatches', criteria.sample.minimumBatches, true);
  // quality — all in [0, 1], finite
  assertRateField('minimumAgreementRate', criteria.quality.minimumAgreementRate);
  assertRateField('maximumDivergenceRate', criteria.quality.maximumDivergenceRate);
  assertRateField('maximumAmbiguityRate', criteria.quality.maximumAmbiguityRate);
  // integrity — all in [0, 1], finite
  assertRateField('maximumErrorRate', criteria.integrity.maximumErrorRate);
  assertRateField('maximumInvalidRecordRate', criteria.integrity.maximumInvalidRecordRate);
}
```

- `assertSampleField(name, value)`: throws `ValidationError` if not integer, finite, >= 0
- `assertRateField(name, value)`: throws `ValidationError` if not finite, not in [0, 1]
- Never coerce, never clamp, never default

---

## Task 3 — Declarative check building

**File**: `src/lib/services/canonical-readiness-service.ts`

Internal function:

```typescript
function buildAllChecks(
  report: ShadowMetricsReport,
  criteria: ReadinessCriteria,
): ReadinessCheckResult[]
```

Computes `invalidRecordRate` internally as `report.batches > 0 ? report.invalidRecords / report.batches : null`.

Builds exactly 7 checks with the declared operator and comparison:

**Invariant**: exactly 7 checks, one per `ReadinessCheckCode`, no duplicates. Order is deterministic and stable: sample checks first (`MINIMUM_EVALUATED_TRANSACTIONS`, `MINIMUM_BATCHES`), then quality (`MINIMUM_AGREEMENT_RATE`, `MAXIMUM_DIVERGENCE_RATE`, `MAXIMUM_AMBIGUITY_RATE`), then integrity (`MAXIMUM_ERROR_RATE`, `MAXIMUM_INVALID_RECORD_RATE`).

| code | operator | actual |
|------|----------|--------|
| MINIMUM_EVALUATED_TRANSACTIONS | >= | report.totalEvaluated |
| MINIMUM_BATCHES | >= | report.batches |
| MINIMUM_AGREEMENT_RATE | >= | report.agreementRate |
| MAXIMUM_DIVERGENCE_RATE | <= | report.divergenceRate |
| MAXIMUM_AMBIGUITY_RATE | <= | report.ambiguityRate |
| MAXIMUM_ERROR_RATE | <= | report.errorRate |
| MAXIMUM_INVALID_RECORD_RATE | <= | computed invalidRecordRate |

For each check:

> `passed = actual !== null && (operator === '>=' ? actual >= expected : actual <= expected)`

Null `actual` → `passed: false`.

---

## Task 4 — State algorithm

**File**: `src/lib/services/canonical-readiness-service.ts`

```typescript
export async function evaluateCanonicalReadiness(
  query: ShadowMetricsQuery,
  criteria: ReadinessCriteria,
  provider: ShadowMetricsProvider,
): Promise<CanonicalReadiness> {
  validateReadinessCriteria(criteria);
  const report = await provider.read(query);
  const checks = buildAllChecks(report, criteria);

  const sampleChecks = checks.filter(
    c => c.code === 'MINIMUM_EVALUATED_TRANSACTIONS' || c.code === 'MINIMUM_BATCHES',
  );
  // or scan: exclude sample codes

  // Precedence step A — INSUFFICIENT_DATA has absolute priority
  const failedSample = sampleChecks.filter(c => !c.passed);
  if (failedSample.length > 0) {
    return {
      status: 'INSUFFICIENT_DATA',
      metrics: report,
      checks,
      reasons: failedSample.map(c => `${c.code}: expected ${c.operator} ${c.expected}, got ${c.actual}`),
    };
  }

  // Precedence step B — NOT_READY
  const failedChecks = checks.filter(c => !c.passed);
  if (failedChecks.length > 0) {
    return {
      status: 'NOT_READY',
      metrics: report,
      checks,
      failedChecks,
    };
  }

  // Precedence step C — READY
  return {
    status: 'READY',
    metrics: report,
    checks,
  };
}
```

Invariants:
- `provider.read(query)` called **exactly once**, before any state decision
- `metrics` (the `report` reference) returned unmutated
- `failedChecks = checks.filter(c => !c.passed)`
- `reasons` only references sample checks (never quality/integrity)

---

## Task 5 — Error handling

- `ValidationError` thrown synchronously on invalid criteria
- Provider errors propagate uncaught
- No logging, no side effects inside `canonical-readiness-service.ts`

---

## Task 6 — Route

**File**: `src/app/api/admin/shadow-metrics/readiness/route.ts`

```
GET /api/admin/shadow-metrics/readiness
```

Reuse the same pattern from S7-05B (`src/app/api/admin/shadow-metrics/route.ts`) but adapt for the function-module architecture:

- Instantiate dependencies directly with `new` — no DI container, no factory
- `const repo = new PrismaAuditLogRepository(db);`
- `const reader = new ShadowMetricsReader(repo);`
- Call the standalone function directly:

```typescript
const result = await evaluateCanonicalReadiness(
  query,
  criteria,
  reader,   // reader satisfies ShadowMetricsProvider
);
```

There is no `CanonicalReadinessService` class. The architecture uses only the standalone `evaluateCanonicalReadiness` function. Do NOT introduce a class wrapper.

**Source validation**: the route validates `source` as `IMPORT | APPLY_ALL | ALL` (same as S7-05B). The `action` (`RULE_PRECEDENCE_SHADOW_SUMMARY`) is filtered exclusively inside the existing `PrismaAuditLogRepository` — the route does NOT receive or validate an `action` parameter.

**Date policy for readiness**: `from` and `to` are **required** (no defaults). The readiness verdict depends on the time window and must not be evaluated over an implicit period.
- Missing `from` → 400
- Missing `to` → 400
- Invalid date → 400
- `from > to` → 400
```

**Pre-apply audit**: before implementing this route, document whether extracting a shared query-param parser from S7-05B's route is worth it. List consumers, diff, tradeoffs. Do NOT extract automatically.

**Serialization decision** (already made in spec, confirmed here): all 7 criteria as individual required query params. No JSON-encoded body. No defaults.

---

## Task 7 — Tests (service)

**File**: `tests/unit/canonical-readiness-service.test.ts`

Factory helpers:
- `makeReport(overrides): ShadowMetricsReport`
- `makeCriteria(overrides): ReadinessCriteria`
- `createMockProvider(returnValue): ShadowMetricsProvider`

Tests:

| Group | Cases |
|-------|-------|
| READY | sufficient sample + all quality/integrity pass |
| NOT_READY | one failing check per quality code (4 tests), one per integrity code (2 tests), all fail |
| INSUFFICIENT_DATA | insufficient transactions, insufficient batches, both insufficient |
| Precedence | sample fails + quality would also fail → INSUFFICIENT_DATA (not NOT_READY) |
| Null actual | each rate null → passed: false, check included, does NOT cause INSUFFICIENT_DATA |
| invalidRecordRate | computed correctly with batches > 0, null when batches = 0 |
| Validation | negative criteria, decimal minimums, NaN, Infinity, rates outside [0,1] — all throw ValidationError |
| Provider not called | if criteria invalid, provider.read NOT called |
| Provider called once | if criteria valid, provider.read called exactly once |
| Query preserved | the exact query + trustPolicy forwarded to provider |
| Provider error | error propagates uncaught |
| Reference identity | returned `metrics` is the same reference from provider |
| Metrics not mutated | report object unchanged after call |
| Operator correctness | all 7 checks have correct operator |
| Check order stability | checks array order matches declared order: sample → quality → integrity |
| failedChecks invariant | equals `checks.filter(c => !c.passed)` in all variants |

---

## Task 8 — Tests (route)

**File**: `tests/api/admin/shadow-metrics-readiness.test.ts`

| Case | Expected |
|------|----------|
| All valid params → READY | 200 |
| companyId missing | 400 |
| source invalid | 400 |
| trustPolicy invalid | 400 |
| from missing | 400 |
| to missing | 400 |
| from invalid | 400 |
| to invalid | 400 |
| from > to | 400 |
| Each criteria param missing (7 tests) | 400 |
| Each criteria param non-numeric (7 tests) | 400 |
| Valid strings converted to numbers | 200 |
| Source value preserved | `IMPORT`, `APPLY_ALL`, `ALL` all accepted and forwarded as-is |
| No `action` param in HTTP contract | route never reads or validates an `action` query param |
| Service receives exact query + criteria | assert mock args |
| Service error propagated | verify apiHandler behavior |

---

## Task 9 — Prohibitions (zero changes)

Do NOT touch:

- `src/lib/services/shadow-metrics-reader.ts`
- `src/lib/db/audit-log-repository.ts`
- `src/lib/rules/rule-precedence-shadow.ts`
- `src/lib/rules/rule-precedence-engine.ts`
- `src/lib/rules/rule-matching-engine.ts`
- `src/lib/engines/apply-all-engine.ts`
- `src/lib/services/import.service.ts` (if exists)
- Any resolver files
- Feature flags

Do NOT add:
- Auto-activation
- Persistence
- Cache
- Dashboard
- Notifications
- New feature flags

---

## Task 10 — Verification commands (future, post-apply)

```bash
npx tsc --noEmit
npx vitest run tests/unit/canonical-readiness-service.test.ts
npx vitest run tests/api/admin/shadow-metrics-readiness.test.ts
npx vitest run
npm run build
git diff --check
git diff
git status --short
```
