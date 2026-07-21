# S7-07 — Operational Policy Service — Tasks

## File Manifest

### CREATE (7 files)

| # | File | Purpose |
|---|------|---------|
| 1 | `src/lib/readiness/parse-readiness-query.ts` | Shared HTTP param parser extracted from readiness route |
| 2 | `src/lib/readiness/build-policy-query-params.ts` | Builds URLSearchParams for GET /policy (composes `buildReadinessQueryParams` + `context`) |
| 3 | `src/lib/operational-policy/types.ts` | All policy-related TypeScript interfaces |
| 4 | `src/lib/operational-policy/observational-policy-profile.ts` | OBSERVATIONAL_POLICY_PROFILE constant |
| 5 | `src/lib/operational-policy/policy-service.ts` | `evaluateOperationalPolicy` core service |
| 6 | `src/app/api/admin/shadow-metrics/policy/route.ts` | New GET route handler |
| 7 | `src/components/spa/admin/readiness/PolicyDecisionCard.tsx` | Dashboard policy card component |

### MODIFY (2 files)

| # | File | Change |
|---|------|--------|
| 1 | `src/app/api/admin/shadow-metrics/readiness/route.ts` | Replace inline query-param parsing with call to `parse-readiness-query` shared utility. No behavioral, default, validation, HTTP code, or auth changes. |
| 2 | `src/components/spa/admin/AdminReadinessDashboardPage.tsx` | Add Operational Context selector to form state; add `fetchPolicy` that calls `GET /policy`; render PolicyDecisionCard; remove the separate `GET /readiness` call (use `decision.readiness` from policy response instead). |

### Zero-change list

The following files must NOT be modified:

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
- Any bank-rules, import, or reconciliation route
- Feature flags

---

## Implementation Order

### Step 0: Characterization tests (BEFORE any code change)

**File:** `tests/api/readiness-route-characterization.test.ts`

Capture the current parsing behavior of the readiness route:

- Default values for each query parameter
- Valid values for `source`, `trustPolicy`
- Date parsing (`from`, `to`) — valid ISO strings, invalid strings, missing
- Number parsing for all 7 criteria thresholds
- Boundary: `from > to` returns 400
- CompanyId validation — missing returns 400
- Authentication mock: valid session, invalid session, non-super-admin

These tests must pass BEFORE the refactor and AFTER. They are the regression guard.

### Step 1: Extract shared parser

**CREATE** `src/lib/readiness/parse-readiness-query.ts`

Extract the inline helpers from the readiness route into a shared module:

```typescript
export interface ParsedReadinessRequest {
  metricsQuery: ShadowMetricsQuery;
  criteria: ReadinessCriteria;
}

export function parseReadinessQuery(params: URLSearchParams): ParsedReadinessRequest
```

The type is intentionally domain-neutral — `ParsedReadinessRequest`, not `ParsedPolicyRequest`. The helper knows nothing about Policy, OperationalContext, or profiles. It only transforms `URLSearchParams` into domain objects.

- Reuse the exact same parsing logic: `parseRequiredDate`, `parseRequiredNumber`, `companyId` null check, `source` default + validation, `trustPolicy` default + validation, `from <= to` guard, threshold ranges.
- All error codes, messages, and HTTP statuses must be identical.
- The function is pure — takes `URLSearchParams`, returns parsed result or throws `ValidationError`.

After extraction, the readiness route handler becomes:

```typescript
const { metricsQuery, criteria } = parseReadinessQuery(request.nextUrl.searchParams);
```

Run the characterization tests — they must pass identically.

### Step 2: Policy types

**CREATE** `src/lib/operational-policy/types.ts`

```typescript
export type OperationalContext = 'APPLY_ALL' | 'IMPORT' | 'RECONCILIATION';

export type OperationalPolicyAction = 'ALLOW' | 'WARN' | 'CONFIRM' | 'BLOCK';

export interface OperationalPolicyProfile {
  id: string;
  name: string;
  version: string;
  defaultAction: OperationalPolicyAction;
  rules: OperationalPolicyRule[];
}

export interface OperationalPolicyRule {
  id: string;
  context: OperationalContext;
  readinessStatus: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
  action: OperationalPolicyAction;
  reasonCode: string;
  description: string;
}

export interface OperationalPolicyRuleResult {
  ruleId: string;
  matched: boolean;
  action: OperationalPolicyAction;
  reasonCode: string;
  context: OperationalContext;
  readinessStatus: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
}

export interface OperationalPolicyReason {
  reasonCode: string;
  summary: string;
}

export interface OperationalPolicyDecision {
  action: OperationalPolicyAction;
  context: OperationalContext;
  profileId: string;
  profileVersion: string;
  readiness: CanonicalReadiness;
  rules: OperationalPolicyRuleResult[];
  reasons: OperationalPolicyReason;
}

export interface OperationalPolicyInput {
  context: OperationalContext;
  metricsQuery: ShadowMetricsQuery;
}
```

Import types from existing locations:
- `CanonicalReadiness` from `@/lib/services/canonical-readiness-service`
- `ShadowMetricsQuery`, `ReadinessCriteria` from `@/lib/services/shadow-metrics-reader`

**Validation constraints (in code comments or JSDoc):**
- Multi-rule allowance: same `context` + `readinessStatus` with different actions is valid.
- Duplicate `rule.id` → `DUPLICATE_RULE_ID` error.
- Semantically identical rules (same `context` + `readinessStatus` + `action` + `reasonCode`) → `DUPLICATE_RULE_CONTENT` error.

### Step 3: Observational profile

**CREATE** `src/lib/operational-policy/observational-policy-profile.ts`

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

### Step 4: Policy service

**CREATE** `src/lib/operational-policy/policy-service.ts`

**Signature:**

```typescript
export async function evaluateOperationalPolicy(
  input: OperationalPolicyInput,
  criteria: ReadinessCriteria,
  provider: ShadowMetricsProvider,
  profile: OperationalPolicyProfile,
): Promise<OperationalPolicyDecision>
```

**Algorithm (exact sequence from spec §14):**

1. **Validate input, criteria, and profile** — structural checks, each with its own error code:
   - `input`, `criteria`, or `profile` null/undefined → `POLICY_INPUT_REQUIRED`, `POLICY_CRITERIA_REQUIRED`, `POLICY_PROFILE_REQUIRED`
   - `profile.id` empty or missing → `POLICY_PROFILE_ID_REQUIRED`
   - `profile.version` missing or invalid → `POLICY_VERSION_REQUIRED`
   - `profile.defaultAction` unknown → `POLICY_UNKNOWN_DEFAULT_ACTION`
   - `input.context` unknown → `POLICY_UNKNOWN_CONTEXT`
   - `profile.rules` is not an array → `POLICY_RULES_NOT_ARRAY`
   - Any rule: unknown context / unknown readinessStatus / unknown action / empty `reasonCode` → `POLICY_RULE_INVALID_FIELD`
   - Duplicate `rule.id` → `DUPLICATE_RULE_ID`
   - Semantically identical rules (same `context` + `readinessStatus` + `action` + `reasonCode`) → `DUPLICATE_RULE_CONTENT`

2. **Filter context rules:**
   - `const contextRules = profile.rules.filter(r => r.context === input.context)`
   - If `contextRules.length === 0` → `POLICY_CONTEXT_RULES_REQUIRED`
   - This check happens BEFORE the provider call

3. **Retrieve evidence:**
   - `const readiness = await evaluateCanonicalReadiness(input.metricsQuery, criteria, provider)`
   - Called exactly once. Provider errors propagate untouched.

4. **Evaluate rules:**
   - Map each context rule to `OperationalPolicyRuleResult`
   - `matched = (rule.readinessStatus === readiness.status)`
   - All results recorded, including non-matched

5. **Determine final action:**
   - `matchedRules` = rules where `matched === true`
   - If `matchedRules.length === 0` → `profile.defaultAction`
   - If `matchedRules.length >= 1` → highest severity per precedence: `BLOCK(4) > CONFIRM(3) > WARN(2) > ALLOW(1)`

6. **Compile decision:**
   - Build `OperationalPolicyReason` with `reasonCode` and `summary`
   - `reasonCode` must come exclusively from the matched rule that determined the action, or from `'DEFAULT_ACTION'` if no rule matched. It is never generated freely.
   - `summary` is a human-readable string derived from the matched rule's description or the default action rationale.
   - Return `OperationalPolicyDecision` with all fields

### Step 5: Policy route

**CREATE** `src/app/api/admin/shadow-metrics/policy/route.ts`

```typescript
export const GET = apiHandler(
  async (request: NextRequest) => {
    const { metricsQuery, criteria } = parseReadinessQuery(request.nextUrl.searchParams);
    const context = request.nextUrl.searchParams.get('context');

    if (!context || !['APPLY_ALL', 'IMPORT', 'RECONCILIATION'].includes(context)) {
      throw new ValidationError('INVALID_CONTEXT');
    }

    const input: OperationalPolicyInput = { context: context as OperationalContext, metricsQuery };
    const profile = OBSERVATIONAL_POLICY_PROFILE;
    const provider = shadowMetricsReader;

    const decision = await evaluateOperationalPolicy(input, criteria, provider, profile);
    return NextResponse.json(decision);
  },
  { requireSuperAdmin: true, requireMembership: false },
);
```

### Step 6: Dashboard integration

**MODIFY** `src/components/spa/admin/AdminReadinessDashboardPage.tsx`

Changes:

1. **Form state** — Add `context` to `draftForm` and `appliedQuery`:
   ```typescript
   context: 'APPLY_ALL' | 'IMPORT' | 'RECONCILIATION';
   ```
   Initial value: `'APPLY_ALL'` (client-side only, not a service default).

2. **Context selector** — Add shadcn Select component next to the existing source selector:
   ```
   Operational Context: [Apply All ▼]
   ```
   - Never inferred from `source`
   - Changing `source` does not change `context`
   - Value is visible and editable

3. **Single fetch** — Replace `fetchReadiness()` with `fetchPolicy()`:
   - Calls `GET /api/admin/shadow-metrics/policy` with all params (including context) via `buildPolicyQueryParams`
   - Response is `OperationalPolicyDecision`
   - `decision.readiness` feeds existing readiness cards (status, metrics, checks)
   - `decision.action`, `decision.rules`, `decision.profileId` feed PolicyDecisionCard
   - No separate `GET /readiness` call
   - **AbortController continuity**: the existing cancellation mechanism (e.g., `AbortController` passed to fetch) must work identically after the change. If the previous `fetchReadiness` accepted an `AbortSignal`, `fetchPolicy` must accept and forward it.

4. **buildPolicyQueryParams** — CREATE `src/lib/readiness/build-policy-query-params.ts`:
   ```typescript
   export function buildPolicyQueryParams(
     form: ReadinessForm & { context: OperationalContext },
     companyId: string,
   ): URLSearchParams
   ```
   Internally calls `buildReadinessQueryParams(form, companyId)` and adds `context=form.context`. **No serialization logic is duplicated** — dates, thresholds, trustPolicy, and source are all delegated to the existing helper. The function body is effectively:
   ```typescript
   const params = buildReadinessQueryParams(form, companyId);
   params.set('context', form.context);
   return params;
   ```
   The existing `buildReadinessQueryParams` is NOT modified; the new helper composes it.

**CREATE** `src/components/spa/admin/readiness/PolicyDecisionCard.tsx`

Props:
```typescript
interface PolicyDecisionCardProps {
  decision: OperationalPolicyDecision;
}
```

Renders:
- Context badge (`decision.context`)
- Action badge with color: ALLOW (green), WARN (yellow), CONFIRM (orange), BLOCK (red)
- Profile identification: `profileId` + `profileVersion`
- Rule matrix table: each rule showing context, readinessStatus, matched, action, reasonCode
- Collapsible evidence: use the same Accordion/Collapsible pattern already used in the dashboard (e.g., `ReadinessCriteriaForm` or `ReadinessChecksTable`) to display the raw `CanonicalReadiness` — never `JSON.stringify()` directly

### Step 7: Characterization tests for readiness refactor

**CREATE** `tests/api/readiness-route-characterization.test.ts`

Tests (must pass BEFORE and AFTER the refactor):
- Default values for all params
- Each valid `source` and `trustPolicy` value
- Invalid source → 400
- Missing companyId → 400
- Invalid dates → 400
- `from > to` → 400
- All 7 numeric thresholds accept valid numbers
- Non-numeric thresholds → 400
- Authentication: valid session returns 200, no session returns 401, non-admin returns 403
- **Semantic equality of response**: For at least 3 representative parameter sets (defaults, custom thresholds, edge-case dates), assert deep equality (same HTTP status, same error codes, same property names and values) before and after the refactor. This catches invisible contract breaks without requiring byte-identical JSON serialization.

### Step 8: Policy service unit tests

**CREATE** `tests/unit/operational-policy.test.ts`

Test groups:

**Validation errors (frozen error codes — test must assert exact string):**
- `input`, `criteria`, or `profile` null/undefined → `POLICY_INPUT_REQUIRED`, `POLICY_CRITERIA_REQUIRED`, `POLICY_PROFILE_REQUIRED`
- Missing `profile.id` → `POLICY_PROFILE_ID_REQUIRED`
- Empty `profile.version` → `POLICY_VERSION_REQUIRED`
- Unknown `profile.defaultAction` → `POLICY_UNKNOWN_DEFAULT_ACTION`
- Unknown `input.context` → `POLICY_UNKNOWN_CONTEXT`
- `profile.rules` is not array → `POLICY_RULES_NOT_ARRAY`
- Zero rules for context → `POLICY_CONTEXT_RULES_REQUIRED`
- Rule with unknown context / readinessStatus / action / empty reasonCode → `POLICY_RULE_INVALID_FIELD`
- Duplicate `rule.id` → `DUPLICATE_RULE_ID`
- Semantically identical rules → `DUPLICATE_RULE_CONTENT`
- Rules with same `context` + `readinessStatus` but different actions → **VALID** (no error)
- Every assertion must be: `expect(error.code).toBe('POLICY_...')` — not just `expect(error).toBeInstanceOf(ValidationError)`

**Provider short-circuit:**
- Each validation error above → provider called **0 times**

**Precedence:**
- Two rules for same `context` + `readinessStatus`: WARN + BLOCK → BLOCK wins
- ALLOW + CONFIRM → CONFIRM wins
- Same rules in different array orders → same result
- All matched rules appear in `ruleResults` (not just the winner)

**Default action:**
- Rules exist for context but none match `readiness.status` → `profile.defaultAction`
- `defaultAction` is `ALLOW` in OBSERVATIONAL_POLICY_PROFILE

**Single invocation (provider + evaluateCanonicalReadiness):**
- Valid evaluation → `evaluateCanonicalReadiness` called exactly once with correct `query`, `criteria`, `provider`
- Mock `evaluateCanonicalReadiness` to verify the call count and arguments
- Also verify `provider.read()` called exactly once (indirect through readiness service)

**Input immutability:**
- Before and after calling `evaluateOperationalPolicy`, assert that `input.metricsQuery`, `criteria`, and `profile` remain structurally unchanged (`deepEqual` on serialized snapshots). The service must never mutate its arguments.

**Profile freezing:**
- `OBSERVATIONAL_POLICY_PROFILE` has exactly 6 rules
- Each rule has exact id, context, readinessStatus, action, reasonCode
- `defaultAction` is `ALLOW`
- `id` is `'observational-policy-v1'`, `version` is `'1.0.0'`

### Step 9: API route integration tests

**CREATE** `tests/api/policy-route.test.ts`

- Valid request with `APPLY_ALL` context returns 200 + `OperationalPolicyDecision`
- Valid request with `IMPORT` context returns 200
- Valid request with `RECONCILIATION` context returns 200
- Missing `context` → 400
- Invalid `context` value → 400
- `source=ALL` does not alter or default `context`
- Response shape matches `OperationalPolicyDecision` interface
- Authentication: valid session returns 200, no session returns 401, non-admin returns 403

### Step 10: Dashboard tests

Add to `tests/api/` or relevant UI tests:

- Dashboard calls ONLY `GET /policy` — no separate `GET /readiness` call
- `decision.readiness` feeds readiness cards
- Context selector is visible with 3 options
- Changing `source` does not change `context`
- PolicyDecisionCard renders context badge, action badge, profile info, rule matrix

---

## Mandatory Invariants (enforced in code and tests)

| # | Invariant | Where enforced |
|---|-----------|----------------|
| 1 | `evaluateCanonicalReadiness` called exactly **once** per valid evaluation | Service unit test with mock readiness service |
| 2 | Provider called **0 times** when any validation fails | Service unit test per frozen error code |
| 3 | `input.metricsQuery`, `criteria`, `profile` are never mutated | Service unit test: deepEqual before/after |
| 4 | Each validation error has a frozen, exact `error.code` string | Service unit test: `expect(error.code).toBe(...)` |
| 5 | Dashboard performs exactly **1 fetch** (`GET /policy`) per Apply/Retry | Dashboard integration test |
| 6 | Readiness route response is semantically identical before and after refactor (deep equality, not byte-level) | Characterization tests: 3+ parameter sets |
| 7 | `context` never inferred from `source` | Route test: `source=ALL` with no context → 400 |
| 8 | `context` is mandatory — missing/empty/unknown → 400 | Route test |
| 9 | Profile is immutable — same `id` + `version` = same content | Profile freeze test (deepEqual) |
| 10 | No silent defaults — any error propagates, never falls back to ALLOW | Service unit test |
| 11 | `reasonCode` comes exclusively from a matched rule or `'DEFAULT_ACTION'` | Service unit test: assert exact `reasons.reasonCode` |
| 12 | `action` is the single branching point — consumers never branch on `summary` | Documented constraint (not code-enforceable) |
| 13 | AbortController cancellation works identically after dashboard refactor | Dashboard test or manual verification |

---

## Test Matrix

| Test file | Type | Coverage |
|-----------|------|----------|
| `tests/api/readiness-route-characterization.test.ts` | API | Readiness route: defaults, validation, errors, auth, **semantic deep equality** for 3+ param sets. Passes before and AFTER refactor. |
| `tests/unit/operational-policy.test.ts` | Unit | All 10 validation errors with frozen codes, provider short-circuit per error, precedence (3 scenarios), default action, single invocation of `evaluateCanonicalReadiness`, input immutability, profile freeze, `reasonCode` provenance |
| `tests/api/policy-route.test.ts` | API | Context validation (missing/invalid → 400), all 3 valid contexts, auth, response shape, source/context independence |
| (within existing dashboard tests) | Integration | Single fetch (no `/readiness`), context selector presence + independence, `decision.readiness` feeds readiness cards, AbortController continuity |

---

## Verification Gates

Run in order before considering the phase complete:

```bash
# 1. Type check
npx tsc --noEmit

# 2. Full test suite (existing + new)
npx vitest run

# 3. Build
npm run build

# 4. No unintended changes
git diff --check
git status --short   # Audit: only files in manifest are modified
```

**Build criterion:** Zero errors. Zero *new* warnings introduced by S7-07. Pre-existing workspace lockfile warnings are out of scope.

**Zero-change audit:** Verify that every file in the zero-change list has zero modifications. The only MODIFY files are `readiness/route.ts` (parser extraction only) and `AdminReadinessDashboardPage.tsx` (context selector + single fetch).

---

## Open Decisions (carried forward from spec)

These are not implemented in S7-07 but documented for S7-08:
- Webhook integration for policy limit crossing
- Company-specific profile overrides (DB persistence)
- `POST /evaluate` for client-supplied profiles
- WARN → BLOCK hardening for specific rules
