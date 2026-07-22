# S7-08 Spec: Observational Policy Integration with Apply All

## 1. Architecture Overview

```
Apply All execution (executeApplyAllUseCase)
         │
         ├── 1. matchTransactionsWithShadow (productivo)
         ├── 2. db.$transaction → executeApplyAll (productivo)
         ├── 3. persistShadowSummaryBestEffort (productivo)
         │
         │   ── S7-08 bloque observacional ──
         ├── 4. [flag] evaluateOperationalPolicy
         ├── 5. [flag] persistOperationalPolicyObservationBestEffort
         │
         └── 6. return { matchResult, applyResult, policyObservation }
```

The productive flow (1–3) is **untouched**. The observational block (4–5) runs only when `isOperationalPolicyObservationEnabled()` is on, and never affects the return value of steps 1–3.

## 2. File Manifest

### New files

| # | File | Purpose |
|---|---|---|
| F1 | `src/lib/operational-policy/apply-all-observation-config.ts` | Server-side config: criteria, query policy, profile reference |
| F2 | `src/lib/operational-policy/apply-all-observer.ts` | Orchestrates `evaluateOperationalPolicy`, returns `PolicyObservationResponse`; no persistence |

### Modified files

| # | File | Change |
|---|---|---|
| F3 | `src/lib/services/apply-all-use-case.ts` | Add observational block + `policyObservation` to result |
| F4 | `src/app/api/bank-rules/apply-all/route.ts` | Include `policyObservation` in JSON response |
| F5 | `src/lib/feature-flags.ts` (o donde estén las flags) | Add `OPERATIONAL_POLICY_OBSERVATION_ENABLED` |

### Untouched (zero changes)

| File | Reason |
|---|---|
| `src/lib/services/apply-all-engine.ts` | No tocar el motor productivo |
| `src/lib/services/rule-precedence-apply-all-resolver.ts` | No tocar resolución de reglas |
| `src/lib/operational-policy/policy-service.ts` | No tocar el policy service — se consume tal cual |
| `src/lib/operational-policy/types.ts` | No tocar — tipos existentes son suficientes |
| `src/lib/operational-policy/observational-policy-profile.ts` | Se referencia, no se modifica |
| `src/lib/services/canonical-readiness-service.ts` | No tocar |
| `src/lib/services/shadow-metrics-reader.ts` | No tocar |
| `src/lib/db/audit-log-repository.ts` | No tocar |
| `src/lib/readiness/default-readiness-profile.ts` | No tocar — no se reutiliza |

## 3. Contracts

### 3.1 Feature flag

```ts
// src/lib/feature-flags.ts (o archivo existente de flags)
export function isOperationalPolicyObservationEnabled(): boolean {
  return process.env.OPERATIONAL_POLICY_OBSERVATION_ENABLED === 'true';
}
```

Behavior:
- `false` (default) → no evaluation, no audit log, `policyObservation` ausente
- `true` → evaluation best-effort

Same pattern as existing flags in the project — avoids freezing the value at import time.

### 3.2 Server-side config

Single encapsulated object so future contexts (IMPORT, RECONCILIATION) each get their own `*_OBSERVATION_CONFIG` without multiplying parameters.

```ts
// src/lib/operational-policy/apply-all-observation-config.ts

import type { ReadinessCriteria } from '@/lib/services/canonical-readiness-service';
import type { OperationalPolicyProfile } from './types';
import { OBSERVATIONAL_POLICY_PROFILE } from './observational-policy-profile';

export interface ObservationConfig {
  criteria: ReadinessCriteria;
  profile: OperationalPolicyProfile;
  shadowMetricsQuery: {
    source: 'APPLY_ALL';
    trustPolicy: 'INCLUDE_LEGACY_IMPORT';
    windowDays: number;
  };
}

export const APPLY_ALL_OBSERVATION_CONFIG: ObservationConfig = {
  criteria: {
    sample: {
      minimumEvaluatedTransactions: 100,
      minimumBatches: 3,
    },
    quality: {
      minimumAgreementRate: 0.95,
      maximumDivergenceRate: 0.05,
      maximumAmbiguityRate: 0.02,
    },
    integrity: {
      maximumErrorRate: 0.01,
      maximumInvalidRecordRate: 0.05,
    },
  },
  profile: OBSERVATIONAL_POLICY_PROFILE,
  shadowMetricsQuery: {
    source: 'APPLY_ALL' as const,
    trustPolicy: 'INCLUDE_LEGACY_IMPORT' as const,
    windowDays: 90,
  },
};
```

### 3.3 Observer result type

```ts
// src/lib/operational-policy/apply-all-observer.ts

export type PolicyObservationStatus = 'AVAILABLE' | 'UNAVAILABLE';

export interface PolicyObservationAvailable {
  status: 'AVAILABLE';
  decision: OperationalPolicyDecision;
}

export interface PolicyObservationUnavailable {
  status: 'UNAVAILABLE';
  errorCode: string;
}

export type PolicyObservationResponse =
  | PolicyObservationAvailable
  | PolicyObservationUnavailable;
```

### 3.4 Audit log payload

```ts
// Schema version 1
interface OperationalPolicyObservationPayload {
  policySchemaVersion: 1;     // version of the payload schema itself
  context: 'APPLY_ALL';
  profileId: string;
  profileVersion: string;     // version of the policy profile
  action: OperationalPolicyAction;
  reasonCode: string;
  readinessStatus: CanonicalReadiness['status'];
  metricsWindow: {
    from: string;   // ISO
    to: string;     // ISO
    source: 'APPLY_ALL';
    trustPolicy: ShadowMetricsTrustPolicy;
  };
}
```

`policySchemaVersion` is independent of `profileVersion` — the payload format can evolve without changing the profile, and vice versa.

Persisted under:
```
action: 'OPERATIONAL_POLICY_OBSERVATION'
entity: 'ApplyAllBatch'
entityId: shadowBatchId  // reuses same batch ID from shadow summary
```

### 3.5 ApplyAllUseCaseResult extension

```ts
// src/lib/services/apply-all-use-case.ts

export interface ApplyAllUseCaseResult {
  matchResult: MatchResult;
  applyResult: ApplyResult;
  policyObservation?: PolicyObservationResponse;  // S7-08
}
```

### 3.6 Observer function signature

```ts
// src/lib/operational-policy/apply-all-observer.ts

export interface ObservePolicyParams {
  companyId: string;
  context: OperationalContext;  // 'APPLY_ALL' | 'IMPORT' | 'RECONCILIATION'
  provider: ShadowMetricsProvider;  // injected by caller
}

export async function observePolicy(
  params: ObservePolicyParams,
): Promise<PolicyObservationResponse>;
```

The observer is **pure**: it evaluates the policy and returns a decision. It does NOT construct infrastructure (DB, providers) and does NOT persist the audit log. The `ShadowMetricsProvider` is injected by the caller — the observer knows nothing about Prisma, the repository, or how metrics are read. This keeps the observer fully testable and reusable across future operational contexts.

## 4. Execution Flow (detailed)

```
executeApplyAllUseCase(companyId):
  result = matchTransactionsWithShadow(companyId, { limit: 200 })
  
  if empty → return { matchResult, applyResult: empty, policyObservation: undefined }
  // ^ early return: no productive execution → no observation
  
  applyResult = db.$transaction → executeApplyAll(companyId, tx, matchResult)
  
  if result.kind === 'with-shadow':
    persistShadowSummaryBestEffort(...)
  
  // ── S7-08 observational block ──
  let policyObservation: PolicyObservationResponse | undefined
  if isOperationalPolicyObservationEnabled() && result.kind === 'with-shadow':
    try:
      const provider = new ShadowMetricsReader(new PrismaAuditLogRepository(db))
      
      policyObservation = await observePolicy({
        companyId,
        context: 'APPLY_ALL',
        provider,
      })
      
      // Persist audit log separately — observer is pure, batchId is only for correlation
      if policyObservation.status === 'AVAILABLE':
        const metricsWindow = computeObservationWindow()
        persistOperationalPolicyObservationBestEffort({
          companyId,
          entityId: result.shadow.batchId,
          decision: policyObservation.decision,
          metricsWindow,
        })
    catch:
      policyObservation = { status: 'UNAVAILABLE', errorCode: 'OBSERVATION_FAILED' }
  // ──────────────────────────────
  
  return { matchResult, applyResult, policyObservation }
```

## 5. Invariants

| # | Invariant | Enforcement |
|---|---|---|
| I1 | Productive flow unchanged | No edits to `apply-all-engine.ts`, resolver, or shadow pipeline |
| I2 | Observation never reverts commit | Runs after `$transaction` resolves |
| I3 | Flag off → no observation | `policyObservation` is `undefined`, no audit log |
| I4 | Flag off → no audit log | `persistOperationalPolicyObservationBestEffort` gated by same flag; never runs when flag is off |
| I5 | No shadow summary → no observation | Only runs when `result.kind === 'with-shadow'` |
| I6 | Early return → no observation | `policyObservation` is `undefined` |
| I7 | Error → UNAVAILABLE, never throw | `try/catch` wraps the entire block |
| I8 | One observation per execution | Single call to `observePolicy` per use-case invocation |
| I9 | Audit log failure does NOT degrade evaluation response | The client response is built from `observePolicy` result, not from persist outcome. `AVAILABLE` stays `AVAILABLE` even if the audit log write fails. |

## 6. Audit Log Schema

### Action code

`OPERATIONAL_POLICY_OBSERVATION`

### Persistence

Lives in `apply-all-use-case.ts` (caller's responsibility), NOT in the observer. The `from`/`to` dates are the actual dates used during evaluation, passed explicitly (the config only defines `windowDays`; the dates are computed at runtime).

```ts
async function persistOperationalPolicyObservationBestEffort(
  params: {
    companyId: string;
    entityId: string;
    decision: OperationalPolicyDecision;
    metricsWindow: {
      from: Date;
      to: Date;
    };
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
    // best-effort: never throw — I9: failure does NOT degrade AVAILABLE response
  }
}
```

### Payload structure

See section 3.4.

## 7. API Response

### POST /api/bank-rules/apply-all

```json
{
  "success": true,
  "matched": 42,
  "total": 100,
  "remaining": 58,
  "rulesApplied": [...],
  "warning": "...",
  "policyObservation": {
    "status": "AVAILABLE",
    "decision": {
      "action": "WARN",
      "context": "APPLY_ALL",
      "profileId": "observational-policy-v1",
      "profileVersion": "1.0.0",
      "readiness": { ... },
      "rules": [ ... ],
      "reasons": {
        "reasonCode": "READINESS_NOT_MET",
        "summary": "Rule \"apply-all-not-ready\" matched — READINESS_NOT_MET. Action: WARN."
      }
    }
  }
}
```

Or when unavailable:

```json
{
  "policyObservation": {
    "status": "UNAVAILABLE",
    "errorCode": "OBSERVATION_FAILED"
  }
}
```

When flag is off: the `policyObservation` field is **absent** from the response.

**Documented semantics of absent `policyObservation`:**
- `undefined` → feature disabled (`isOperationalPolicyObservationEnabled()` returned `false`)
- This is the **only** situation that produces `undefined`. Both successful and failed evaluation produce a present object.
- Clients MUST treat `undefined` as "the server did not evaluate operational policy". This is different from "the server evaluated and found no issues" (which would be `{ status: 'AVAILABLE', decision: { action: 'ALLOW', ... } }`).

## 8. Dependencies

| Dependency | Direction | Rationale |
|---|---|---|
| `apply-all-observer.ts` → `policy-service.ts` | Import | `evaluateOperationalPolicy` |
| `apply-all-observer.ts` → `apply-all-observation-config.ts` | Import | `APPLY_ALL_OBSERVATION_CONFIG` |
| `apply-all-observer.ts` → `canonical-readiness-service.ts` | Import | `ShadowMetricsProvider` — injected, but type imported |
| `apply-all-use-case.ts` → `apply-all-observer.ts` | Import | `observePolicy` |
| `apply-all-use-case.ts` → feature flag | Import | `isOperationalPolicyObservationEnabled` — guard |
| `apply-all-use-case.ts` → `db` | Import | Audit log persistence (not observer) |
| `apply-all-use-case.ts` → `shadow-metrics-reader.ts` | Import | `ShadowMetricsReader` — constructs provider |
| `apply-all-use-case.ts` → `audit-log-repository.ts` | Import | `PrismaAuditLogRepository` — constructs provider |
