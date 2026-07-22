# S7-08 — Observational Policy Integration with Apply All — Tasks

## File Manifest

### CREATE (2 files)

| # | File | Purpose |
|---|------|---------|
| 1 | `src/lib/operational-policy/apply-all-observation-config.ts` | `APPLY_ALL_OBSERVATION_CONFIG` — single object with criteria, metricsQueryTemplate, windowDays, and `OBSERVATIONAL_POLICY_PROFILE` reference |
| 2 | `src/lib/operational-policy/apply-all-observer.ts` | `observePolicy()` — pure policy evaluator; no persistence, no infrastructure construction |

### MODIFY (3 files)

| # | File | Change |
|---|------|--------|
| 1 | Feature flags (wherever `isRulePrecedenceShadowEnabled` lives) | Add `isOperationalPolicyObservationEnabled()` — function, not const |
| 2 | `src/lib/services/apply-all-use-case.ts` | Add observational block + `policyObservation` to `ApplyAllUseCaseResult` |
| 3 | `src/app/api/bank-rules/apply-all/route.ts` | Include `policyObservation` in JSON response |

### CREATE (test file)

| # | File | Purpose |
|---|------|---------|
| T | `tests/api/apply-all-observation.test.ts` | Full integration test matrix for the observational block |

### Zero-change list

The following files must NOT be modified:

- `src/lib/services/apply-all-engine.ts`
- `src/lib/services/rule-precedence-apply-all-resolver.ts`
- `src/lib/operational-policy/policy-service.ts`
- `src/lib/operational-policy/types.ts`
- `src/lib/operational-policy/observational-policy-profile.ts`
- `src/lib/services/canonical-readiness-service.ts`
- `src/lib/services/shadow-metrics-reader.ts`
- `src/lib/db/audit-log-repository.ts`
- `src/lib/readiness/default-readiness-profile.ts`
- Any import, reconciliation, or readiness route

---

## Implementation Order

### Step 0: Feature flag

**Files:** Feature flags file (follow existing project pattern)

Add:

```ts
export function isOperationalPolicyObservationEnabled(): boolean {
  return process.env.OPERATIONAL_POLICY_OBSERVATION_ENABLED === 'true';
}
```

Verify:
- Module exports the function
- Defaults to `false` when env var is unset
- Returns `true` when env var is `'true'`

---

### Step 1: Server-side config

**File:** `src/lib/operational-policy/apply-all-observation-config.ts`

Create `ObservationConfig` interface and `APPLY_ALL_OBSERVATION_CONFIG`.

Verify:
- TypeScript compiles with no errors
- `criteria` matches `ReadinessCriteria` shape
- `profile` references `OBSERVATIONAL_POLICY_PROFILE` by import (not redefined)
- `metricsQueryTemplate` has correct source/trustPolicy, `windowDays` is a top-level number

---

### Step 2: Observer

**File:** `src/lib/operational-policy/apply-all-observer.ts`

Types to export:

| Export | Kind |
|---|---|
| `PolicyObservationStatus` | Type |
| `PolicyObservationAvailable` | Interface |
| `PolicyObservationUnavailable` | Interface |
| `PolicyObservationResponse` | Union type |
| `ObservePolicyParams` | Interface |
| `observePolicy` | Async function |

`ObservePolicyParams`:

```ts
export interface ObservePolicyParams {
  companyId: string;
  context: OperationalContext;
  provider: ShadowMetricsProvider;
  metricsWindow: { from: Date; to: Date };
}
```

`observePolicy` implementation:

```ts
export async function observePolicy(
  params: ObservePolicyParams,
): Promise<PolicyObservationResponse> {
  const { companyId, context, provider, metricsWindow } = params;
  const config = APPLY_ALL_OBSERVATION_CONFIG;

  const metricsQuery: ShadowMetricsQuery = {
    ...config.metricsQueryTemplate,
    companyId,
    from: metricsWindow.from,
    to: metricsWindow.to,
  };

  const decision = await evaluateOperationalPolicy(
    { context, metricsQuery },
    config.criteria,
    provider,
    config.profile,
  );

  return { status: 'AVAILABLE', decision };
}
```

Note: `observePolicy` does NOT catch — errors propagate to the caller's `try/catch` in the use case. This keeps the observer pure and avoids catching programming errors silently.

Verify:
- No circular imports (observer only imports `policy-service`, `apply-all-observation-config`, `canonical-readiness-service` types)
- `PolicyObservationResponse` types are correct
- Function signature matches design

---

### Step 3: Use case integration

**File:** `src/lib/services/apply-all-use-case.ts`

Changes:

1. Import new dependencies:

```ts
import { isOperationalPolicyObservationEnabled } from '@/lib/feature-flags';
import { observePolicy, type PolicyObservationResponse } from '@/lib/operational-policy/apply-all-observer';
import { APPLY_ALL_OBSERVATION_CONFIG } from '@/lib/operational-policy/apply-all-observation-config';
import { ShadowMetricsReader } from '@/lib/services/shadow-metrics-reader';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
```

2. Extend `ApplyAllUseCaseResult`:

```ts
export interface ApplyAllUseCaseResult {
  matchResult: MatchResult;
  applyResult: ApplyResult;
  policyObservation?: PolicyObservationResponse;
}
```

3. Add `buildObservationWindow` helper — pure function, injected `now` makes it fully deterministic:

```ts
function buildObservationWindow(
  now: Date,
  windowDays: number,
): { from: Date; to: Date } {
  const from = new Date(now);
  from.setDate(from.getDate() - windowDays);
  from.setUTCHours(0, 0, 0, 0);

  const to = new Date(now);
  to.setUTCHours(23, 59, 59, 999);

  return { from, to };
}
```

Called as:
```ts
const metricsWindow = buildObservationWindow(
  new Date(),
  APPLY_ALL_OBSERVATION_CONFIG.windowDays,
);
```

4. Add `classifyObservationError` helper — uses `error.code` (AppError) or `instanceof`, never by message text:

```ts
import { AppError, ValidationError } from '@/lib/api-error';

function classifyObservationError(error: unknown): string {
  if (error instanceof ValidationError) {
    // ValidationError is thrown by evaluateOperationalPolicy assertions
    return 'POLICY_EVALUATION_ERROR';
  }
  if (error instanceof AppError) {
    // Provider errors throw AppError from within ShadowMetricsReader
    return 'PROVIDER_ERROR';
  }
  return 'UNEXPECTED_ERROR';
}
```

Note: check actual error hierarchy in the project. If `ShadowMetricsReader` or `PrismaAuditLogRepository` throw `AppError` with specific codes, those can be used. The key rule: classify by type/code, never by string matching on `error.message`.

5. Add `persistOperationalPolicyObservationBestEffort` helper:

```ts
async function persistOperationalPolicyObservationBestEffort(
  params: {
    companyId: string;
    entityId: string;
    decision: OperationalPolicyDecision;
    metricsWindow: { from: Date; to: Date };
  },
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        companyId: params.companyId,
        action: 'OPERATIONAL_POLICY_OBSERVATION',
        entity: 'ApplyAllBatch',
        entityId: params.entityId,
        details: JSON.stringify({
          policySchemaVersion: 1,
          context: params.decision.context,
          profileId: params.decision.profileId,
          profileVersion: params.decision.profileVersion,
          action: params.decision.action,
          reasonCode: params.decision.reasons.reasonCode,
          readinessStatus: params.decision.readiness.status,
          metricsWindow: {
            from: params.metricsWindow.from.toISOString(),
            to: params.metricsWindow.to.toISOString(),
            source: 'APPLY_ALL',
            trustPolicy: 'INCLUDE_LEGACY_IMPORT',
          },
        }),
      },
    });
  } catch {
    // best-effort — I9: failure does not degrade AVAILABLE
  }
}
```

6. Add observational block inside `executeApplyAllUseCase`, AFTER shadow persist, BEFORE return:

```ts
let policyObservation: PolicyObservationResponse | undefined;

if (isOperationalPolicyObservationEnabled() && result.kind === 'with-shadow') {
  try {
    const provider = new ShadowMetricsReader(new PrismaAuditLogRepository(db));
    const metricsWindow = buildObservationWindow();

    policyObservation = await observePolicy({
      companyId,
      context: 'APPLY_ALL',
      provider,
      metricsWindow,
    });

    if (policyObservation.status === 'AVAILABLE') {
      await persistOperationalPolicyObservationBestEffort({
        companyId,
        entityId: result.shadow.batchId,
        decision: policyObservation.decision,
        metricsWindow,
      });
    }
  } catch (error) {
    policyObservation = {
      status: 'UNAVAILABLE',
      errorCode: classifyObservationError(error),
    };
  }
}
```

**Invariant — buildObservationWindow runs exactly once per execution:**
The `metricsWindow` is computed once at function scope, before `observePolicy`. It is passed as a parameter to both `observePolicy` and `persistOperationalPolicyObservationBestEffort`. Neither function computes dates internally.

Verify:
- `tsc` compiles with no errors
- Zero changes to `apply-all-engine.ts`, resolver, shadow pipeline, or productive flow
- Early return path has `policyObservation: undefined`
- Flag off skips entire block
- `result.kind !== 'with-shadow'` skips entire block
- `classifyObservationError` maps error types correctly
- `persistOperationalPolicyObservationBestEffort` never throws

---

### Step 4: API route

**File:** `src/app/api/bank-rules/apply-all/route.ts`

After building `response`, conditionally include `policyObservation`:

```ts
if (policyObservation) {
  response.policyObservation = policyObservation;
}
```

No other changes to the route. The `policyObservation` field is absent when flag is off.

Verify:
- Response JSON includes `policyObservation` when present
- Response JSON omits `policyObservation` when `undefined`
- Existing tests pass (response shape backward compatible)

---

### Step 5: Integration tests

**File:** `tests/api/apply-all-observation.test.ts`

#### Test setup

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { executeApplyAllUseCase } from '@/lib/services/apply-all-use-case';
```

Helper to seed a company with active rules and unmatched transactions, plus shadow audit log records. Each test creates fresh data and cleans up after itself.

#### Test cases

| # | Name | Flag | Shadow | Expect `policyObservation` | Expect audit log |
|---|---|---|---|---|---|
| T1 | flag off, shadow present | OFF | Yes | `undefined` | None |
| T2 | flag off, no unmatched txs | OFF | N/A | `undefined` | None |
| T3 | flag on, READY | ON | Adequate history | `{ status: 'AVAILABLE', decision.action: 'ALLOW' }` | 1 row |
| T4 | flag on, NOT_READY | ON | Fails quality | `{ status: 'AVAILABLE', decision.action: 'WARN', reasonCode: 'READINESS_NOT_MET' }` | 1 row |
| T5 | flag on, INSUFFICIENT_DATA | ON | Below min txs | `{ status: 'AVAILABLE', decision.action: 'WARN', reasonCode: 'INSUFFICIENT_SAMPLE' }` | 1 row |
| T6 | flag on, no shadow | ON | No | `undefined` | None |
| T7 | flag on, early return | ON | N/A | `undefined` | None |
| T8 | flag on, provider throws | ON | Yes | `{ status: 'UNAVAILABLE', errorCode: 'PROVIDER_ERROR' }` | None |
| T9 | flag on, audit log fails | ON | READY | `{ status: 'AVAILABLE' }` (not degraded) | None (intentional) |
| T10 | flag on, empty shadow | ON | Yes, 0 records | `{ status: 'AVAILABLE', decision.action: 'WARN', reasonCode: 'INSUFFICIENT_SAMPLE' }` | 1 row |

#### Zero-behavioral-change verification

For each test case where flag ON produces a result, run the same scenario with flag OFF and assert:

```ts
const flagOnResult = await executeApplyAllUseCase(companyId);
// reset DB
const flagOffResult = await executeApplyAllUseCase(companyId);

// DTO equality
// flagOffResult.policyObservation === undefined
// flagOnResult.matchResult === flagOffResult.matchResult (deep equal)
// flagOnResult.applyResult === flagOffResult.applyResult (deep equal)

// DB state equality — verify invisible side effects are identical
// count(JournalEntry) with flag ON === count(JournalEntry) with flag OFF
// count(AuditLog) where action !== 'OPERATIONAL_POLICY_OBSERVATION' — same
// count(BankTransaction) where matchedRuleId is not null — same
// count(BankTransaction) where glAccountId is not null — same
```

#### Observation window consistency test

```ts
it('uses the same metricsWindow for observePolicy and audit log', async () => {
  // Execute Apply All with flag ON
  // Read the audit log row (action: OPERATIONAL_POLICY_OBSERVATION)
  // Parse its metricsWindow.from and metricsWindow.to
  // Assert they match the decision.readiness.metricsQuery.from/to exactly
  // This proves buildObservationWindow ran once and both consumers received the same dates
});
```

---

## Invariant Summary

| # | Invariant | Where enforced |
|---|---|---|
| I1 | Productive flow unchanged | Step 3: no edits to engine/resolver/shadow |
| I2 | Observation never reverts commit | Step 3: eval after `$transaction` resolves |
| I3 | Flag off → no observation | Step 3: guard at block entry |
| I4 | Flag off → no audit log | Step 3: persist gated by same condition |
| I5 | No shadow summary → no observation | Step 3: guard at block entry |
| I6 | Early return → no observation | Step 3: `undefined` in early path |
| I7 | Error → UNAVAILABLE, never throw | Step 3: `try/catch` wraps entire block |
| I8 | One observation per execution | Step 3: single `observePolicy` call |
| I9 | Audit log failure doesn't degrade AVAILABLE | Step 3: `persistOperationalPolicyObservationBestEffort` catch does not change `policyObservation` |
| I10 | `buildObservationWindow` runs exactly once | Step 3: computed before both consumers, not inside either |
| I11 | Same window for eval and audit log | Step 3: same `metricsWindow` reference passed to both |

---

## Build and verification

```bash
npx vitest run tests/api/apply-all-observation.test.ts
npx tsc --noEmit
npx vitest run  # full suite — must not regress
```

---

## Risk assessment

| Risk | Mitigation |
|---|---|
| Feature flag typo | Step 0 test: flag name matches env var |
| Observer imports wrong config | Step 2: single `APPLY_ALL_OBSERVATION_CONFIG` source |
| `evaluateOperationalPolicy` throws due to bad criteria at runtime | Step 3: outer `try/catch` catches → `UNAVAILABLE` |
| Shadow metrics query from/to diverges from audit log | Step 3: same `metricsWindow` reference — enforced by I10, verified by observation window consistency test |
| New audit log action code breaks existing queries | Existing `findShadowSummaries` filters by `RULE_PRECEDENCE_SHADOW_SUMMARY` — not affected |
