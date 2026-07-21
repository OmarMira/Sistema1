# S7-07 — Operational Policy Service — Spec

## 1. Objective
Design and implement a read-only, consultative **Operational Policy Evaluation Service** that sits between `CanonicalReadinessService` and operational consumers (such as `Apply All`, `Import`, and `Reconciliation`). The service evaluates a mandatory, explicitly provided policy profile against readiness results and returns a structured, auditable policy decision.

S7-07 remains entirely observational. It does not block any operational workflows, write to the database, modify feature flags, or make any automated changes to system state. It serves as the foundation for transition from observation to operational enforcement in future phases.

---

## 2. Invariante fundamental
- **Profile Owned by Server**: The policy profile is never sent by the client. The backend owns the profile selection — the route handler passes the appropriate profile (e.g. `OBSERVATIONAL_POLICY_PROFILE`) to the service. The service itself still requires an explicit profile parameter; it never loads defaults, environment variables, or implicit configurations.
- **Purely Consultative**: The service only recommends an action (`ALLOW`, `WARN`, `CONFIRM`, `BLOCK`). It has zero capability to enforce, block, or modify any system execution itself.
- **Deterministic and Order-Independent**: Rule evaluation is exhaustive. The order of rules inside a profile does not alter the final decision, and no rule short-circuits the evaluation of others.
- **Traceable Decisions**: Every decision includes the exact rules evaluated, whether they matched, and the complete `CanonicalReadiness` report used as supporting evidence.

---

## 3. Scope
- **OperationalPolicyService**: Core business logic service evaluating explicit policy profiles against readiness metrics.
- **OBSERVATIONAL_POLICY_PROFILE**: The initial predefined policy profile implementing conservative, observational default policies (allowing operations but warning under high-divergence or insufficient data conditions).
- **Consultative API Route**: A new backend API endpoint (`GET /api/admin/shadow-metrics/policy`) that exposes the evaluation service to the frontend using query parameters plus the server-owned `OBSERVATIONAL_POLICY_PROFILE`.
- **Dashboard Integration**: A new read-only policy evaluation card on the super-admin readiness dashboard that fetches and displays the operational recommendation and rules evaluated.
- **Comprehensive Test Suite**: Unit and integration tests covering the evaluation algorithm, precedence, validation rules, error handling, and dashboard presentation.

---

## 4. Exclusions
- **Flow Enforcement**: No actual blocking of `Apply All`, `Import`, or `Reconciliation` is permitted in S7-07. That is deferred to S7-08.
- **Persisted Profiles**: No database schema changes, tables, or persisted company-specific profiles. Profiles are pure, code-versioned static data passed to the service.
- **Auto-Activation / Feature Flags**: No modification of feature flags, automatic cutovers, or rule engine state changes.
- **Single Apply Context**: `SINGLE_APPLY` is excluded from the scope since no first-class single-rule apply workflow exists in the codebase today.

---

## 5. Arquitectura
The service is positioned as a clean, intermediate translation layer:

```
+-----------------------------------+
|       ShadowMetricsReader         |
+-----------------------------------+
                  │
                  ▼ (raw report data)
+-----------------------------------+
|    CanonicalReadinessService      |
+-----------------------------------+
                  │
                  ▼ (CanonicalReadiness: READY | NOT_READY | INSUFFICIENT_DATA)
+-----------------------------------+
|     OperationalPolicyService      |  <--- Mandatory OperationalPolicyProfile passed here
+-----------------------------------+
                  │
                  ▼ (OperationalPolicyDecision: action + evidence)
+-----------------------------------+
|      Consultative API Route       |
+-----------------------------------+
                  │
                  ▼ (observational JSON)
+-----------------------------------+
|       Super-Admin Dashboard       |  <--- Display-only, no enforcement
+-----------------------------------+
```

---

## 6. OperationalContext
Specifies which operational workflow is requesting a policy recommendation.
```typescript
export type OperationalContext = 'APPLY_ALL' | 'IMPORT' | 'RECONCILIATION';
```
Each value corresponds to a first-class production workflow in the platform.

**`context` vs `source`:** `context` is an independent concept from `metricsQuery.source`. `source` controls which metrics are aggregated (e.g., `ALL`, `APPLY_ALL`, `MANUAL`). `context` tells the policy service which operational workflow the recommendation is for. They MAY have the same value (e.g., `APPLY_ALL` for both), but one is never inferred from the other. `source=ALL` does not imply any particular context.

---

## 7. OperationalPolicyAction
Specifies the recommendation severity returned by the policy engine.
```typescript
export type OperationalPolicyAction = 'ALLOW' | 'WARN' | 'CONFIRM' | 'BLOCK';
```

- **ALLOW**: No conditions detected that require operator friction. Recommended to proceed normally.
- **WARN**: Condition detected that the operator must know. Recommended to proceed but display a non-blocking warning.
- **CONFIRM**: High-risk condition detected. Recommended to pause execution and require explicit human confirmation.
- **BLOCK**: Prohibited condition detected. Recommended to halt the operation entirely.

*Note: S7-07 only models these actions. No consumer actually blocks or prompts the user in this phase.*

---

## 8. OperationalPolicyInput
Parameters required by the service to evaluate the policy.

```typescript
export interface OperationalPolicyInput {
  context: OperationalContext;
  metricsQuery: ShadowMetricsQuery;
}
```

`metricsQuery.companyId` is the single source of truth for the target company. There is no separate `companyId` field — that would create a redundant source of truth requiring extraneous consistency validation.

---

## 9. OperationalPolicyProfile
The complete set of rules and parameters defining the risk posture of the caller.
```typescript
export interface OperationalPolicyProfile {
  id: string;                     // e.g., 'observational-policy-v1'
  name: string;                   // e.g., 'Observational Default Policy'
  version: string;                // e.g., '1.0.0'
  defaultAction: OperationalPolicyAction;
  rules: OperationalPolicyRule[];
}
```

---

## 10. OperationalPolicyRule
A discrete mapping from a specific context and readiness status to an operational recommendation.
```typescript
export interface OperationalPolicyRule {
  id: string;                     // e.g., 'rule-apply-all-insufficient'
  context: OperationalContext;
  readinessStatus: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
  action: OperationalPolicyAction;
  reasonCode: string;             // e.g., 'INSUFFICIENT_SAMPLE', 'DIVERGENCE_HIGH'
  description: string;            // Presentational text explaining why this rule exists
}
```
**Multi-rule allowance**: Multiple rules may target the same `context` + `readinessStatus` combination. All matching rules are evaluated and recorded. The final action is resolved by precedence.
**Constraint**: Duplicate `rule.id` values are invalid. Rules with identical `context`, `readinessStatus`, `action`, and `reasonCode` are considered semantically identical duplicates and are also invalid.

---

## 11. OperationalPolicyRuleResult
The outcome of evaluating a single rule.
```typescript
export interface OperationalPolicyRuleResult {
  ruleId: string;
  matched: boolean;
  action: OperationalPolicyAction;
  reasonCode: string;
  context: OperationalContext;
  readinessStatus: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
}
```

---

## 12. OperationalPolicyReason
A lightweight, non-redundant explanation of the policy decision. All raw evidence (checks, status, reasons) lives exclusively in `decision.readiness`. `OperationalPolicyReason` MUST NOT duplicate fields already present in `CanonicalReadiness`.

```typescript
export interface OperationalPolicyReason {
  reasonCode: string;             // Machine-readable code, e.g. 'RULE_MATCHED', 'DEFAULT_ACTION'
  summary: string;                // Human-readable summary for presentational purposes
}
```

---

## 13. OperationalPolicyDecision
The final, complete payload returned by the service.
```typescript
export interface OperationalPolicyDecision {
  action: OperationalPolicyAction;
  context: OperationalContext;
  profileId: string;
  profileVersion: string;
  readiness: CanonicalReadiness;
  rules: OperationalPolicyRuleResult[];
  reasons: OperationalPolicyReason;
}
// `context` is embedded in the decision so the payload is fully self-contained and traceable — the consumer never needs to correlate it with the request parameter.
```
**Branching Constraint:** Code execution in consumers must branch *exclusively* on the root `action` property. The `summary` and sub-properties are for presentational or debugging purposes only.

**Reproducibility Invariant:** `OperationalPolicyDecision` must be completely reproducible. Given `profileId`, `profileVersion`, and the response payload, an auditor must be able to reconstruct exactly why the decision was taken — including which rules matched, which `CanonicalReadiness` evidence was used, and how precedence resolved the final action. This invariant exists because the policy service is designed to evolve toward enforcement, where decisions may be audited weeks or months later.

**Profile Immutability:** To guarantee reproducibility, `profileId` + `profileVersion` together identify an immutable snapshot. Once a version is published:
  - Its rules, `defaultAction`, and metadata must never change.
  - Any modification (adding, removing, or altering a rule; changing `defaultAction`) requires incrementing `version`.
  - Rule IDs are stable within a version — they are only added, removed, or changed in a new version.
  - Tests freeze the exact expected ruleset of `OBSERVATIONAL_POLICY_PROFILE` to detect unintended changes.

---

## 14. Algoritmo
The service evaluates policy using a single, strict sequence:

1. **Validate Input, Criteria, and Profile**:
   - Verify `input`, `criteria`, and `profile` are present and structurally valid.
   - Throws `ValidationError` on any schema violation or ID inconsistency (e.g., missing id, empty version, unknown context, duplicate rules).
2. **Filter Context Rules**:
   - Select all rules in the profile where `rule.context === input.context`.
   - If `contextRules.length === 0`, throw `ValidationError` with code `POLICY_CONTEXT_RULES_REQUIRED` — **before** any provider call.
3. **Retrieve Evidence**:
   - Call `evaluateCanonicalReadiness(input.metricsQuery, criteria, provider)` exactly once.
   - Any thrown error propagates immediately without wrapping.
4. **Evaluate Rules**:
   - For each applicable rule, determine if `rule.readinessStatus === readiness.status`.
   - If true, mark `result.matched = true` and `result.action = rule.action`.
   - If false, mark `result.matched = false`.
   - Multiple rules may match simultaneously — each is recorded in the `ruleResults` array.
5. **Determine Final Action**:
   - If rules exist for the context but none matched `readiness.status`, set final action to `profile.defaultAction`.
   - If one or more applicable rules matched, select the action with the **highest severity** according to the precedence chain.
6. **Compile Decision**:
   - Construct `OperationalPolicyReason` using checks and reasons from `readiness`.
   - Return `OperationalPolicyDecision`.

---

## 15. Precedencia
Since multiple rules may target the same `context` + `readinessStatus` combination, and each may specify a different action, the final action is resolved strictly by severity:

```
BLOCK (4) > CONFIRM (3) > WARN (2) > ALLOW (1)
```

**Precedence Invariants:**
- Every applicable rule must be evaluated. Evaluation does not halt on the first match (no short-circuit).
- The order of rules inside the `profile.rules` array must not alter the final **action** determination across different precedence levels. If two rules produce the same action severity, the action is identical and the `reasonCode` comes from the first matching rule in the profile (declarative order). The profile author controls which reason wins by ordering rules deliberately.
- If multiple rules match, the highest precedence action among all matched rules determines the final action.
- All matched rules appear in `ruleResults`, regardless of whether their action was selected by precedence.
- Precedence is only exercised when multiple rules match the same `context` + `readinessStatus`. The `OBSERVATIONAL_POLICY_PROFILE` in S7-07 has at most one rule per combination, so precedence always yields that single rule's action. Future profiles with overlapping rules will use the full chain.

---

## 16. Validaciones
The service executes strict schema and consistency checks before calling the metrics provider. Any of the following conditions triggers a `ValidationError` with a distinct programmatic error code (status 400):

- `profile` or `input` is null or undefined.
- `profile.id` is empty or missing.
- `profile.version` is missing or invalid.
- `profile.defaultAction` is unknown.
- `input.context` is unknown.
- `profile.rules` is not an array.
- **Zero rules match `input.context`** (code `POLICY_CONTEXT_RULES_REQUIRED`). A profile must define at least one rule for the requested context.
- Any rule contains an unknown context, unknown readiness status, unknown action, or empty `reasonCode`.
- Duplicate `rule.id` values exist (code `DUPLICATE_RULE_ID`).
- Semantically identical rules exist: two or more rules sharing the same `context`, `readinessStatus`, `action`, and `reasonCode` (code `DUPLICATE_RULE_CONTENT`).
- Rules with the same `context` + `readinessStatus` but different `action` or `reasonCode` are valid and intentionally test precedence.

No silent corrections, deduplications, or default fallbacks are permitted during validation.

---

## 17. Manejo de errores
- **Validation Errors**: All validation checks throw a standard `ValidationError` containing a distinct, programmatic error code (e.g., `'POLICY_PROFILE_REQUIRED'`, `'DUPLICATE_RULE'`).
- **Provider/Readiness Errors**: Any error thrown by `evaluateCanonicalReadiness` or the underlying `ShadowMetricsProvider` must propagate untouched. The service does not catch or intercept provider-level exceptions.
- **Null Rates**: If shadow metrics contain null rates (due to zero transactions evaluated), `evaluateCanonicalReadiness` handles the evaluation as passed/failed checks. The policy service consumes this result as-is without re-evaluating or interpreting null values.
- **No Silent Defaults**: If an error occurs, the service does not fall back to `ALLOW`. It halts and propagates the failure.

---

## 18. Perfil observacional inicial
The predefined observational policy profile is defined as a constant:

**File:** `src/lib/operational-policy/observational-policy-profile.ts`

```typescript
import type { OperationalPolicyProfile } from './types';

export const OBSERVATIONAL_POLICY_PROFILE: OperationalPolicyProfile = {
  id: 'observational-policy-v1',
  name: 'Observational Default Policy',
  version: '1.0.0',
  defaultAction: 'ALLOW',
  rules: [
    {
      id: 'apply-all-not-ready',
      context: 'APPLY_ALL',
      readinessStatus: 'NOT_READY',
      action: 'WARN',
      reasonCode: 'READINESS_NOT_MET',
      description: 'Canonical readiness criteria are not met. Review Apply All classifications carefully.'
    },
    {
      id: 'apply-all-insufficient',
      context: 'APPLY_ALL',
      readinessStatus: 'INSUFFICIENT_DATA',
      action: 'WARN',
      reasonCode: 'INSUFFICIENT_SAMPLE',
      description: 'Apply All runs with insufficient shadow history. Verify classifications manually.'
    },
    {
      id: 'import-not-ready',
      context: 'IMPORT',
      readinessStatus: 'NOT_READY',
      action: 'WARN',
      reasonCode: 'DIVERGENCE_HIGH',
      description: 'Divergence rate is high. V2 would differ on several imports.'
    },
    {
      id: 'import-insufficient',
      context: 'IMPORT',
      readinessStatus: 'INSUFFICIENT_DATA',
      action: 'ALLOW',
      reasonCode: 'INSUFFICIENT_SAMPLE',
      description: 'Insufficient sample data to assess import quality. Proceed normally.'
    },
    {
      id: 'reconciliation-not-ready',
      context: 'RECONCILIATION',
      readinessStatus: 'NOT_READY',
      action: 'WARN',
      reasonCode: 'DIVERGENCE_HIGH',
      description: 'Divergence is high. Verify reconciliation suggestions carefully.'
    },
    {
      id: 'reconciliation-insufficient',
      context: 'RECONCILIATION',
      readinessStatus: 'INSUFFICIENT_DATA',
      action: 'ALLOW',
      reasonCode: 'INSUFFICIENT_SAMPLE',
      description: 'Insufficient sample data to assess reconciliation suggestions.'
    }
  ]
};
```

### Justification of Rules (Product Perspective):
- **APPLY_ALL + INSUFFICIENT_DATA → WARN**: Apply All affects a high volume of transactions. Proceeding with insufficient data is a moderate risk (yellow flag) requiring manual validation.
- **IMPORT + NOT_READY → WARN**: Importing statement files is a time-sensitive operation. High divergence indicates quality issues, but blocking imports entirely would paralyze the business. Hence, warn but proceed.
- **IMPORT + INSUFFICIENT_DATA → ALLOW**: Statement batches are often small and won't meet sample thresholds. Restricting imports because of a small sample size would disrupt standard operations. Allow without friction.
- **RECONCILIATION + NOT_READY → WARN**: Reconciliation is already a manual, human-guided process. High divergence of suggestions is helpful signal, but blocking the user from reconciling would be counterproductive. Warn but allow.
- **RECONCILIATION + INSUFFICIENT_DATA → ALLOW**: Same as import, small datasets should not block manual matching. Proceed silently.
- **APPLY_ALL + NOT_READY → WARN**: Apply All is the highest-volume operational flow. When canonical criteria are not met, the operator is warned to review classifications carefully. S7-08 may harden this to BLOCK, but S7-07 maintains the full agreed matrix.

---

## 19. Integración con dashboard

### Context selector

The dashboard adds an explicit **Operational Context** selector alongside the existing source and trust-policy controls:

```
Operational Context: [Apply All ▼]  Import | Reconciliation
```

This selector:
- Is part of `draftForm` state, `appliedQuery`, and `buildPolicyQueryParams`.
- Has initial value `APPLY_ALL` (visible, editable, client-side default — not a service default).
- Is sent as `context` in the `GET /policy` request.
- Is never inferred from `source`. `source=ALL` does not change or default `context`.
- Renders alongside the result label so the operator always sees which context was evaluated.

### Single-fetch invariant

The dashboard MUST NOT call both `GET /readiness` and `GET /policy`. Since `OperationalPolicyDecision` embeds `readiness: CanonicalReadiness`, the integrated dashboard makes exactly one call to `GET /api/admin/shadow-metrics/policy` per evaluation (Apply/Retry action) and renders all components from that single response:

- The existing readiness cards (metrics, checks, status) consume `decision.readiness`.
- The new policy card consumes `decision.action`, `decision.rules`, and `decision.profileId`.

This guarantees a single snapshot per evaluation — no divergence between readiness and policy views.

### Policy card

The policy card displays:
- **Context badge**: The evaluated `decision.context` (APPLY_ALL / IMPORT / RECONCILIATION).
- **Policy Action Badge**: Renders `decision.action` (ALLOW: Green, WARN: Yellow, CONFIRM: Orange, BLOCK: Red) with clear iconography.
- **Profile Identification**: Shows `profileId` and `profileVersion` of the profile evaluated.
- **Rule Matrix Evaluation**: Lists each rule in the profile, showing its context, readiness status, matched flag, action, and reason code.
- **Collapsible Evidence**: Renders a clean, collapsible JSON view of the raw `CanonicalReadiness` for administrative audit.

The dashboard remains 100% read-only. It has no capabilities to modify thresholds, change active policy profiles, or save decisions.

---

## 20. Decisión de route
The route design follows a key principle: the **backend owns the profile selection**. Since only `OBSERVATIONAL_POLICY_PROFILE` exists in S7-07, the client has no reason to send a profile.

### Selected approach: `GET /api/admin/shadow-metrics/policy`

A read-only `GET` request with query parameters mirroring the existing readiness route, plus a mandatory `context` parameter:

```
context=APPLY_ALL | IMPORT | RECONCILIATION
```

**`context` is explicit and mandatory.** The dashboard never omits, defaults server-side, or infers `context` from `source`. An unknown, missing, or empty `context` value returns HTTP 400. The example `context=APPLY_ALL` throughout this document is illustrative — any of the three values is valid.

**Parser reuse invariant:** The policy route MUST NOT duplicate the HTTP parameter parsing that the readiness route already implements. The common parsing logic (extracting `source`, `from`, `to`, `trustPolicy`, and the 7 threshold fields from query parameters into `ShadowMetricsQuery` + `ReadinessCriteria`) must be extracted into a shared utility function. Both routes import and call this function. A single change (e.g., adding `maximumFooRate`) updates exactly one parser — the shared utility.

**Refactor limits:** The extraction modifies the readiness route *exclusively* to replace inline parsing with a call to the shared utility. The following MUST remain identical before and after:
  - Default values for each parameter
  - Validation rules and error codes
  - HTTP status codes and response format
  - Authentication and authorization
  - Overall observable behavior

**Characterization tests required:** Before extracting the parser, write characterization tests for the readiness route that capture its current parsing behavior (defaults, edge cases, error handling). After extraction, verify the same tests pass unchanged. This guarantees no behavioral regression.

The route handler:
1. Calls the shared parser to extract `ShadowMetricsQuery` and `ReadinessCriteria` from query parameters.
2. Reads `context` from the query string.
3. Selects `OBSERVATIONAL_POLICY_PROFILE` as the active profile.
4. Calls the `OperationalPolicyService` with input, criteria, provider, and profile.
5. Returns the `OperationalPolicyDecision` as JSON.

**Consumptive superset:** The policy route is the single endpoint the dashboard calls. Since `OperationalPolicyDecision` embeds `readiness: CanonicalReadiness`, the same response drives both the readiness cards and the policy card — one fetch, one snapshot, zero divergence.

**Why GET instead of POST:**
- The service is pure, deterministic, and side-effect-free. It is a genuine query.
- The profile is server-owned, so the request body has no extra structure beyond what query parameters already represent.
- It follows the same REST convention as the existing `GET /api/admin/shadow-metrics/readiness`.

### Future path: `POST /api/admin/shadow-metrics/policy/evaluate`

If a later phase introduces arbitrary client-supplied profiles (for simulation, A/B testing, or experimentation), a dedicated `POST /evaluate` sub-resource can accept the profile in the request body. This path is not implemented in S7-07.

---

## 21. Testabilidad
The implementation must be backed by a thorough unit and integration test suite:

- **Policy Action Permutations**: Assert ALLOW, WARN, CONFIRM, and BLOCK recommendations are evaluated correctly.
- **Precedence Logic**: Verify that multiple matched rules with different severities resolve correctly (e.g., a BLOCK rule wins over a WARN rule), regardless of rule order in the array. Test `WARN + BLOCK → BLOCK`, `ALLOW + CONFIRM → CONFIRM`, and the same set in different orders producing the same result.
- **Multiple Matched Rules**: Verify that when multiple rules match, all of them appear in `ruleResults` with `matched: true`, not just the highest-precedence winner.
- **Validation Constraints**: Test each validation rule to verify it throws `ValidationError` with correct programmatic error codes. Include tests for `DUPLICATE_RULE_ID` and `DUPLICATE_RULE_CONTENT`.
- **Provider Single-Invocation**: Verify that the shadow metrics provider is called exactly once per evaluation.
- **Validation Failure Short-Circuit**: Verify that the provider is NOT called if any validation fails — including perfil inválido, reglas duplicadas, contexto inválido, and **contexto sin reglas**.
- **Context Selector**: Verify that the dashboard context dropdown is visible, contains all three values (`APPLY_ALL`, `IMPORT`, `RECONCILIATION`), and part of `draftForm` / `appliedQuery` / `buildPolicyQueryParams`. Changing source does not alter context.
- **Context in Request**: Verify that the route receives exactly the applied `context` value. `source=ALL` does not infer or default `context`. An invalid or missing `context` returns HTTP 400.
- **Single Dashboard Fetch**: Verify that the integrated dashboard calls ONLY `GET /api/admin/shadow-metrics/policy` and does NOT make a separate call to the readiness route. Both readiness and policy cards render from the same `OperationalPolicyDecision.readiness`.
- **Evidence Integrity**: Assert that the complete `CanonicalReadiness` is preserved inside the decision without modifications or omissions.
- **Predefined Profile**: Verify that `OBSERVATIONAL_POLICY_PROFILE` evaluates correctly against READY, NOT_READY, and INSUFFICIENT_DATA readiness results.
- **Dashboard Presentation**: Test that the dashboard renders the policy card correctly, showing the action badge, rule results, and expandable evidence without performing any side-effects.

---

## 22. Acceptance Criteria
The phase is considered complete ONLY when:
- The policy service is fully implemented in isolation under `src/lib/operational-policy/`.
- The shared query parser is extracted to `src/lib/readiness/parse-readiness-query.ts`.
- Characterization tests for the readiness route exist and pass before and after the refactor — the readiness route is modified **only** to replace inline parsing with the shared helper, preserving all defaults, validations, HTTP codes, and observable behavior.
- The new route `GET /api/admin/shadow-metrics/policy` compiles and runs, reusing the shared parser.
- `npx tsc --noEmit` completes with zero errors.
- The entire test suite (1702 + new S7-07 tests) passes successfully.
- Build completes successfully (zero errors, zero *new* warnings introduced by S7-07; pre-existing workspace lockfile warnings are out of scope).
- No changes exist in any file listed as untouchable (the readiness route is excluded from that list by S7-07 design).
- The dashboard successfully displays the consultative policy card.
- The observational profile is tested with exactly 6 rules, exact IDs, exact context/status/action values, defaultAction ALLOW, and exact id/version identifiers frozen in test assertions.
- Precedence is tested with multiple matched rules: `WARN + BLOCK → BLOCK`, `ALLOW + CONFIRM → CONFIRM`, and order independence.
- Multiple matched rules all appear in `ruleResults` (not just the winner).
- Duplicate `rule.id` throws `DUPLICATE_RULE_ID`.
- Semantically identical rules (same `context` + `readinessStatus` + `action` + `reasonCode`) throw `DUPLICATE_RULE_CONTENT`.
- Rules with same `context` + `readinessStatus` but different actions are valid.
- Context without rules (e.g., `APPLY_ALL` with zero APPLY_ALL rules) returns `ValidationError` and the provider is called **0 times**.
- The integrated dashboard performs exactly **one fetch** (`GET /policy`) per Apply/Retry action — no separate call to `/readiness`.
- Readiness cards and policy card render from the same embedded `decision.readiness` — zero snapshot divergence.
- The dashboard context selector exposes all three contexts (`APPLY_ALL`, `IMPORT`, `RECONCILIATION`), is visible, editable, and part of `draftForm`/`appliedQuery`/`buildPolicyQueryParams`.
- Changing `source` does not alter `context`, and vice versa — `source=ALL` never infers a context.
- The route receives exactly the applied context value. Invalid, missing, or empty `context` returns HTTP 400.
- The evaluated context is displayed alongside the policy result.

---

## 23. Archivos previstos
- `src/lib/readiness/parse-readiness-query.ts` — Shared HTTP param parser extracted from readiness route
- `src/lib/operational-policy/types.ts` — Policy and profile TypeScript interfaces
- `src/lib/operational-policy/observational-policy-profile.ts` — OBSERVATIONAL_POLICY_PROFILE
- `src/lib/operational-policy/policy-service.ts` — `evaluateOperationalPolicy` core service
- `src/app/api/admin/shadow-metrics/policy/route.ts` — API route handler
- `src/app/api/admin/shadow-metrics/readiness/route.ts` — **MODIFY**: replace inline parsing with shared helper (no behavioral change)
- `src/components/spa/admin/readiness/PolicyDecisionCard.tsx` — Dashboard UI component
- `tests/unit/operational-policy.test.ts` — Policy service unit tests
- `tests/api/policy-route.test.ts` — API route integration tests
- `tests/api/readiness-route-characterization.test.ts` — Pre-refactor characterization tests for readiness route

---

## 24. Archivos intocables
- `src/lib/services/canonical-readiness-service.ts`
- `src/lib/services/shadow-metrics-reader.ts`
- `src/lib/db/audit-log-repository.ts`
- `src/lib/services/apply-all-engine.ts`
- `src/lib/services/apply-all-use-case.ts`
- `src/lib/services/import.service.ts`
- `src/lib/services/reconciliation.service.ts`
- `src/lib/services/rule-precedence-engine.ts`
- `src/lib/services/rule-precedence-shadow.ts`
- `src/lib/services/rule-matching-engine.ts`
- `src/lib/api-error.ts`
- `src/lib/api-handler.ts`
- `src/app/api/admin/shadow-metrics/route.ts`
- Any bank-rules route
- Any import route
- Any reconciliation route
- Feature flags

---

## 25. Decisiones abiertas
- **Webhook Integration**: Should crossing policy limits automatically trigger system alerts or dispatch webhooks in a future phase?
- **Company Overrides**: How will company-specific policy overrides be stored in DB during S7-08? A JSON column in the `Company` model or a separate `PolicyProfile` model?
- **Confirm Block Transition**: What are the operational rules for transition of specific rules (e.g. Apply All + NOT_READY) from ALLOW to BLOCK? Will it be automated or strictly manual via super-admin toggle?
- **POST /evaluate for Arbitrary Profiles**: When client-supplied profiles are needed (simulation, A/B testing), a `POST /api/admin/shadow-metrics/policy/evaluate` endpoint can accept the profile in the request body. Not implemented in S7-07.
