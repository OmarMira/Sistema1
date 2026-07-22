# S7-08 Proposal: Observational Policy Integration with Apply All

## Goal

Integrate `OperationalPolicyService` into the real `Apply All` execution flow in a purely observational, non-blocking way. The policy evaluates the readiness of the shadow metrics baseline **after** each Apply All batch and records the result — but **never** modifies, blocks, or alters the productive classification flow.

## Why

S7-07 built the Operational Policy engine. S7-08 is the first real consumer: observing what the policy would recommend inside a production execution path, collecting evidence before any enforcement phase.

## Scope

| What's in | What's out |
|---|---|
| Observational policy evaluation inside `executeApplyAllUseCase` | Blocking or enforcement logic |
| Feature flag (`OPERATIONAL_POLICY_OBSERVATION_ENABLED`) | Reusing existing shadow/engine flags |
| Audit log with compact structured payload | Persisting full `CanonicalReadiness` to `AuditLog` |
| Server-side configuration file for criteria, query policy, and profile | Reusing `INITIAL_READINESS_PROFILE` from dashboard UI |
| Full `OperationalPolicyDecision` in API response | Flattened DTO |
| Best-effort error handling (never breaks Apply All) | Propagation of policy errors to caller |

## Architecture Decisions

### AD-1: Observation post-commit

Policy evaluation runs AFTER the productive DB transaction commits and AFTER the shadow summary is persisted. The execution sequence is:

```
DB transaction (productive)
    executeApplyAll(...)
COMMIT ✓

persistShadowSummaryBestEffort(...)

try {
    evaluateOperationalPolicy(...)
    persistOperationalPolicyObservationBestEffort(...)
} catch {
    // never reverts Apply All
}

return
```

Consequences:
- If the transaction fails → no observation exists (nothing to observe)
- If the transaction committed → the observation can never revert Apply All
- The policy assesses the state **including** the just-applied batch
- Zero coupling between productive commit and observation reliability

### AD-2: Feature flag isolation

`OPERATIONAL_POLICY_OBSERVATION_ENABLED` is independent from:
- `RULE_PRECEDENCE_SHADOW_ENABLED` (shadow comparison)
- `RULE_ENGINE_ADAPTER_ENABLED` (rule engine adapter)

Responsibility: flag off → no evaluation, no audit log, no observation field in response. Flag on → best-effort evaluation.

### AD-3: Server-side config

A dedicated file (`apply-all-observation-config.ts`) holds the three pieces the caller must provide to `evaluateOperationalPolicy`:
- `APPLY_ALL_OBSERVATION_CRITERIA`: `ReadinessCriteria`
- `APPLY_ALL_OBSERVATION_QUERY_POLICY`: query defaults (window, source, trust policy)
- Reference to `OBSERVATIONAL_POLICY_PROFILE`

No coupling to dashboard UI defaults.

### AD-4: Audit log with compact schema

Persists a best-effort compact payload under `action: 'OPERATIONAL_POLICY_OBSERVATION'`. Does NOT persist the full `CanonicalReadiness` (reconstructible from metrics and criteria).

### AD-5: Response wrapper

`ApplyAllUseCaseResult.policyObservation` wraps the decision:
```ts
{ status: 'AVAILABLE', decision: OperationalPolicyDecision }
// or
{ status: 'UNAVAILABLE', errorCode: string }
```

This avoids mixing "no policy" with "policy evaluated to BLOCK" in the same optional field.

### AD-6: One observation per Apply All execution

Each Apply All execution generates **at most one** policy observation — not one per transaction, rule, or journal entry.

```
Apply All execution
        │
        ├── Shadow Summary (1)
        └── Policy Observation (1)
```

This keeps granularity aligned with Shadow Summary and simplifies auditability and traceability.

## Zero-Change Guarantee

The productive flow is untouched:
- `matchTransactionsWithShadow`, `executeApplyAll`, `persistShadowSummaryBestEffort` execute exactly as before
- Policy observation runs **after** all productive work, in a separate `try/catch`
- Early return (no rules or no unmatched transactions) → no observation
- Policy errors → `status: 'UNAVAILABLE'`, Apply All success is unaffected

## Open Questions (closed)

| # | Question | Decision |
|---|---|---|---|
| 1 | API response shape | Full `OperationalPolicyDecision` in `policyObservation.decision` |
| 2 | Feature flag | `OPERATIONAL_POLICY_OBSERVATION_ENABLED` — isolated |
| 3 | Audit log schema | Compact payload, `action: OPERATIONAL_POLICY_OBSERVATION`, best-effort |
| 4 | Time window | 90 days explicit, server-side config |
| 5 | Criteria source | Server-side config file, not `INITIAL_READINESS_PROFILE` |
| 6 | Observation identity | One per Apply All execution, not per transaction/rule |
