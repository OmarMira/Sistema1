# S7-08 Design: Observational Policy Integration with Apply All

## 1. Execution Sequence (detailed)

### 1.1 Complete flow of `executeApplyAllUseCase`

```
executeApplyAllUseCase(companyId):
  ┌─────────────────────────────────────────────────────┐
  │ 1. matchTransactionsWithShadow (productivo)          │
  │    → MatchTransactionsWithShadowResult               │
  │    → early return si vacío                           │
  └─────────────────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────┐
  │ 2. db.$transaction (productivo)                      │
  │    ┌───────────────────────────────────────────────┐ │
  │    │ executeApplyAll(companyId, tx, matchResult)    │ │
  │    └───────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────┘
                           │ COMMIT
                           ▼
  ┌─────────────────────────────────────────────────────┐
  │ 3. persistShadowSummaryBestEffort (productivo)       │
  │    → solo si result.kind === 'with-shadow'           │
  └─────────────────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────┐
  │ 4. S7-08: Observational block (best-effort)          │
  │                                                      │
  │ if !isOperationalPolicyObservationEnabled():         │
  │   → policyObservation = undefined                    │
  │   → saltar todo el bloque                            │
  │                                                      │
  │ if result.kind !== 'with-shadow':                    │
  │   → policyObservation = undefined                    │
  │   → saltar (no hay batch ID para correlacionar)      │
  │                                                      │
  │ try:                                                 │
  │   provider = ShadowMetricsReader(PrismaAuditLogRepo) │
  │   metricsWindow = buildObservationWindow(config)     │
  │   │                                                   │
  │   decision = observePolicy({ companyId, 'APPLY_ALL', │
  │                              provider, metricsWindow })│
  │   │                                                   │
  │   policyObservation = { status: 'AVAILABLE', decision }│
  │   │                                                   │
  │   persistOperationalPolicyObservationBestEffort(     │
  │     companyId, entityId, decision, metricsWindow)    │
  │                                                      │
  │ catch error:                                          │
  │   code = classifyObservationError(error)               │
  │   policyObservation = { status: 'UNAVAILABLE',        │
  │                         errorCode: code }              │
  └─────────────────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────┐
  │ 5. return { matchResult, applyResult, policyObservation }│
  └─────────────────────────────────────────────────────┘
```

### 1.2 `observePolicy` internals

`observePolicy` receives `metricsWindow` — it does NOT compute dates. This guarantees that `observePolicy` and `persistOperationalPolicyObservationBestEffort` use the exact same time window.

```
observePolicy({ companyId, context, provider, metricsWindow }):

  metricsQuery = {
    companyId,
    source: context → 'APPLY_ALL',
    from: metricsWindow.from,
    to: metricsWindow.to,
    ...config.metricsQueryTemplate,
    companyId,
    from: metricsWindow.from,
    to: metricsWindow.to,
  }

  criteria = config.criteria
  profile = config.profile

  decision = evaluateOperationalPolicy(
    { context, metricsQuery },
    criteria,
    provider,
    profile,
  )

  return decision
```

`buildObservationWindow(now, windowDays)` is a shared helper that computes `from`/`to` once:

```
buildObservationWindow(now, windowDays):
  from = startOfUTCDay(now - windowDays)
  to = endOfUTCDay(now)
  return { from, to }
```

### 1.3 `persistOperationalPolicyObservationBestEffort` internals

```
persistOperationalPolicyObservationBestEffort(
  companyId, entityId, decision, metricsWindow):

  payload = {
    policySchemaVersion: 1,
    context: decision.context,
    profileId: decision.profileId,
    profileVersion: decision.profileVersion,
    action: decision.action,
    reasonCode: decision.reasons.reasonCode,
    readinessStatus: decision.readiness.status,
    metricsWindow: {
      from: metricsWindow.from.toISOString(),
      to: metricsWindow.to.toISOString(),
      source: 'APPLY_ALL',
      trustPolicy: 'INCLUDE_LEGACY_IMPORT',
    },
  }

  try:
    db.auditLog.create({
      data: {
        companyId,
        action: 'OPERATIONAL_POLICY_OBSERVATION',
        entity: 'ApplyAllBatch',
        entityId,
        details: JSON.stringify(payload),
      },
    })
  catch:
    // best-effort — I9: no degrada AVAILABLE
```

## 2. Transaction Boundaries

```
┌──────────────────────────────────────────────────┐
│ $transaction                                     │
│  ├── executeApplyAll (productivo)                 │
│  ├── persistShadowSummary? NO — fuera del tx      │
│  └── COMMIT                                       │
└──────────────────────────────────────────────────┘

persistShadowSummaryBestEffort(...)     ← fuera del tx

observePolicy(...)                      ← fuera del tx (nueva consulta)
persistOperationalPolicyObservation(...) ← fuera del tx (best-effort)
```

Key design decision:

| Aspect | Decision | Rationale |
|---|---|---|
| Shadow summary inside tx? | **No** — same as today | Best-effort, no reason to couple |
| Policy eval inside tx? | **No** | Would extend tx lifetime with a read-only query; no reason to hold row locks |
| Audit log inside tx? | **No** | Best-effort; failed audit log should never roll back Apply All |
| `policyObservation` build inside tx? | **N/A** | Built in memory after all I/O completes |

**Consequence**: the productive transaction commits fully before any observation code runs. A crash after commit but before observation means the Apply All succeeded but no observation was recorded. This is acceptable — the observation is advisory, not contractual.

## 3. Error Handling

### 3.1 Error propagation map

| Source | Exception type | Catch behavior | `policyObservation` |
|---|---|---|---|
| `isOperationalPolicyObservationEnabled()` returns `false` | — | Skip block entirely | `undefined` |
| `result.kind !== 'with-shadow'` | — | Skip block entirely | `undefined` |
| `new ShadowMetricsReader(...)` | Any | `catch` → `classifyObservationError(e)` | `{ status: 'UNAVAILABLE', errorCode: 'PROVIDER_ERROR' }` |
| `observePolicy(...)` | Any | `catch` → `classifyObservationError(e)` | `{ status: 'UNAVAILABLE', errorCode: varies }` |
| `evaluateOperationalPolicy(...)` | `AppError(400, ...)` / any | Propagates to caller (inside observePolicy, not caught) | `POLICY_EVALUATION_ERROR` |
| `persistOperationalPolicyObservationBestEffort(...)` | Any | Internal try/catch | Unchanged — I9: AVAILABLE stays AVAILABLE |
| `ShadowMetricsReader.read(...)` | Any | Propagates to observePolicy → catch | `UNAVAILABLE` |
| `PrismaAuditLogRepository.findShadowSummaries(...)` | Any | Propagates to ShadowMetricsReader → observePolicy → catch | `UNAVAILABLE` |

### 3.2 Error codes

| `errorCode` | Meaning | Origin |
|---|---|---|---|
| `'PROVIDER_ERROR'` | ShadowMetricsReader or repository failure | `new ShadowMetricsReader(...)` or `observePolicy` → provider.read |
| `'POLICY_EVALUATION_ERROR'` | evaluateOperationalPolicy threw (e.g. unexpected assertion) | `observePolicy` |
| `'UNEXPECTED_ERROR'` | Any other exception not classified above | Catch-all fallback |

`'AUDIT_LOG_ERROR'` exists internally but is NOT exposed — it doesn't degrade `AVAILABLE` (I9).

### 3.3 `classifyObservationError` helper

```
classifyObservationError(error):
  if error is provider-related:
    return 'PROVIDER_ERROR'
  if error is evaluateOperationalPolicy assertion:
    return 'POLICY_EVALUATION_ERROR'
  return 'UNEXPECTED_ERROR'
```

This function lives in `apply-all-use-case.ts` (or as a private helper inline). It's the single place that maps exception types to error codes, making future error-code expansion straightforward without touching the catch block logic.

The external contract stays the same: `{ status: 'UNAVAILABLE', errorCode: string }`. Clients don't need to distinguish codes; the codes exist for server-side diagnostics.

### 3.4 What CANNOT happen

- `evaluateOperationalPolicy` assertions (invalid input, missing criteria, invalid profile) → these are **programming errors** that SHOULD propagate. Caught by the outer try/catch → `UNAVAILABLE`. This is correct: a misconfigured observation should not crash Apply All.
- However, `evaluateOperationalPolicy` validates at call time, so a misconfigured config file would be caught during development/testing.

## 4. Dependency Diagram

```
apply-all-use-case.ts
  │
  ├──→ feature-flags.ts
  │     └── isOperationalPolicyObservationEnabled()
  │
  ├──→ apply-all-observer.ts
  │     ├──→ policy-service.ts
  │     │     └── evaluateOperationalPolicy()
  │     ├──→ apply-all-observation-config.ts
  │     │     └── APPLY_ALL_OBSERVATION_CONFIG
  │     └──→ canonical-readiness-service.ts
  │           └── ShadowMetricsProvider (type only)
  │
  ├──→ shadow-metrics-reader.ts
  │     └── ShadowMetricsReader
  │
  ├──→ audit-log-repository.ts
  │     └── PrismaAuditLogRepository
  │
  └──→ db
        └── prisma.auditLog.create
```

No circular dependencies. The observer imports only:
- `policy-service.ts` (pure logic)
- `apply-all-observation-config.ts` (pure data)
- `canonical-readiness-service.ts` (type only)

All infrastructure (`ShadowMetricsReader`, `PrismaAuditLogRepository`, `db`) is constructed by the use case and injected.

## 5. Integration Test Matrix

### 5.1 Test setup

Each test runs via `executeApplyAllUseCase(companyId)` with a seeded company containing:
- N active rules (various priorities)
- M unmatched transactions
- Shadow audit log records in `auditLog` (for the readiness check to read)

### 5.2 Test cases

| # | Scenario | Flag | Shadow present | Shadow data | Expected `policyObservation` | Expected audit log |
|---|---|---|---|---|---|---|
| T1 | Flag OFF, productive success | OFF | Yes | Adequate | `undefined` | None |
| T2 | Flag OFF, no unmatched txs | OFF | N/A | N/A | `undefined` | None |
| T3 | Flag ON, shadow present, READY | ON | Yes | Meets all criteria → READY | `{ status: 'AVAILABLE', decision: { action: 'ALLOW', reasonCode: 'DEFAULT_ACTION' } }` | `OPERATIONAL_POLICY_OBSERVATION` created |
| T4 | Flag ON, shadow present, NOT_READY | ON | Yes | Fails quality criteria | `{ status: 'AVAILABLE', decision: { action: 'WARN', reasonCode: 'READINESS_NOT_MET' } }` | `OPERATIONAL_POLICY_OBSERVATION` created |
| T5 | Flag ON, shadow present, INSUFFICIENT_DATA | ON | Yes | Below `minimumEvaluatedTransactions` | `{ status: 'AVAILABLE', decision: { action: 'WARN', reasonCode: 'INSUFFICIENT_SAMPLE' } }` | `OPERATIONAL_POLICY_OBSERVATION` created |
| T6 | Flag ON, no shadow (without-shadow) | ON | No | N/A | `undefined` | None |
| T7 | Flag ON, early return (no txs) | ON | N/A | N/A | `undefined` | None |
| T8 | Flag ON, provider throws | ON | Yes | Induce DB error | `{ status: 'UNAVAILABLE', errorCode: 'OBSERVATION_FAILED' }` | None |
| T9 | Flag ON, audit log fails, AVAILABLE | ON | Yes | READY, audit log fails | `{ status: 'AVAILABLE', ... }` — not degraded | None (intentional failure) |
| T10 | Flag ON, zero shadow records (empty) | ON | Yes | No audit log records for company | INSUFFICIENT_DATA (0 batches < 3) | `OPERATIONAL_POLICY_OBSERVATION` created |

### 5.3 Zero-behavioral-change verification

Each test MUST also assert:
- `matchResult` is identical to running without the observational block
- `applyResult` is identical
- Productive DB state (matched transactions, journal entries, shadow summary) is identical

This can be achieved by running the same test twice (flag ON / flag OFF, same seed data) and comparing the productive fields.

### 5.4 Test isolation

- Each test creates its own company + data
- Shadow audit log records are created with `action: 'RULE_PRECEDENCE_SHADOW_SUMMARY'` to simulate real shadow history
- Tests clean up via transaction rollback or dedicated teardown
- The `OPERATIONAL_POLICY_OBSERVATION_ENABLED` env var is toggled per test via `vi.stubEnv` or equivalent

## 6. Implementation order

| Step | File | What |
|---|---|---|
| 1 | `src/lib/operational-policy/apply-all-observation-config.ts` | New: `APPLY_ALL_OBSERVATION_CONFIG` + `ObservationConfig` type |
| 2 | Feature flag | New: `isOperationalPolicyObservationEnabled()` in existing flags file |
| 3 | `src/lib/operational-policy/apply-all-observer.ts` | New: `observePolicy` + `PolicyObservationResponse` + `ObservePolicyParams` |
| 4 | `src/lib/services/apply-all-use-case.ts` | Modified: add observational block, extend `ApplyAllUseCaseResult` |
| 5 | `src/app/api/bank-rules/apply-all/route.ts` | Modified: include `policyObservation` in response |
| 6 | Integration tests | New: full matrix from section 5 |
