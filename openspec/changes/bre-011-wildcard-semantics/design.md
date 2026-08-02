# Design: BRE-011 — Wildcard Semantics (Option A)

## Technical Approach

Extract the Legacy wildcard guard into a single shared module consumed by all three engines, scoped to the bounded surface (`description_contains`, `description_eq` [evidence-backed]; `description_starts_with`, `description_ends_with` [design decision]). Currently the guard is inline in Legacy (`rule-matching-engine.ts:48-49`, pre-switch) and absent in V2 (`conditions/description.ts` evaluators are literal) and Precedence (reuses V2 via `evaluateCondition`, `rule-precedence-engine.ts:50-61`). A shared `isWildcard` guard closes the axis-A W-1 divergence without duplicating logic.

**Scope boundary:** legacy-column passthrough canonicalization (case 4) IS in scope — resolved via Decision "Legacy-column normalization" (conditions-first, fallback legacy → canonical, fail closed). Does NOT change regex or amount evaluation beyond routing `*` as non-wildcard.

## Architecture Decisions

### Decision: Single shared wildcard guard module

**Choice:** New `src/lib/rule-engine/wildcard.ts` exporting `isWildcardValue(value: string): boolean` and `evaluateWildcardCondition(condition, transaction): EvaluatedCondition | null`. Returns a match/no-match when the condition is on the wildcard surface with value `*`; returns `null` to let the engine continue normally otherwise.
**Alternatives considered:** (a) keep guard inline in each engine — rejected: triple duplication, drift risk; (b) guard only in V2 dispatcher — rejected: Legacy has its own evaluate path.
**Rationale:** single source of truth; Legacy replaces `:48-49` inline logic, V2 evaluators and Precedence inherit via the existing `evaluateCondition` dispatch (`conditions/index.ts:20-28`) plus an explicit Legacy hook.

### Decision: Surface membership lives in one table

**Choice:** `WILDCARD_SURFACE: Record<string, boolean>` keyed by condition type: `description_contains`, `description_eq`, `description_starts_with`, `description_ends_with` → `true`; `description_matches`, `amount_*` → `false` (routed as no-match).
**Alternatives considered:** hardcoding checks in each evaluator — rejected: surface decisions scattered.
**Rationale:** the [Design decision] operators are a deliberate, documented extension; centralizing makes provenance reviewable against the spec.

**Governance rule:** Any addition or removal from `WILDCARD_SURFACE` requires a specification update to `rule-wildcard-semantics`. No operator may be added or dropped through engine code alone.

### Decision: Runtime contract — explicit no-match; validation rejection at rule-write time (APPROVED 2026-08-02)

**Decision (binding):** `*` on excluded operators (amount, regex) evaluates to **explicit no-match at runtime** (no exception, no `engine_execution_error`), AND **rejection at rule validation/import** (rule with `*` on amount/regex fails creation). Validation lives in a shared domain/API layer used by both create and import (UI shows the message but is NOT the only barrier); no DB-level restriction for `*`. (Approval: proposal §11 Decision #1.)

**Alternatives considered:** (a) runtime no-match only — rejected: leaves broken rules stored, silent; (b) validation rejection only — rejected: existing rows must still be handled at runtime; (c) numeric wildcard — rejected in proposal §3.4.

**Rationale:** split responsibility — validation prevents new broken rules; runtime no-match guarantees deterministic engine behavior for pre-existing rows.

### Decision: Legacy-column normalization (case 4) — conditions-first, fallback legacy (APPROVED 2026-08-02)

**Decision (binding):** When `conditions` is not a usable representation and `conditionType`/`conditionValue` exist, the adapter MUST normalize the legacy columns to the canonical model before V2 execution. Precedence: (1) non-empty valid `conditions` → use them; (2) else fallback to legacy columns; (3) if neither normalizes → fail closed. For `conditionType = "equals"`, `conditionValue = "*"` → canonical `description_eq("*")`, routed through the shared wildcard contract. The productive path MUST NOT preserve `conditions: null` (null-preservation was only for BRE-010's observational harness). (Approval: proposal §11 Decision #2.)

**Alternatives considered:** special-case for `equals / "*"` — rejected: hardcode that leaves the same problem for other legacy values; generic normalization covers all legacy columns.

**Rationale:** fixes the root cause (case 4 `conditions_normalization_failed`) for any legacy value, not just `*`.

## Data Flow

```
Rule condition (value "*")
        │
        ├─ wildcard.ts: is on WILDCARD_SURFACE? ── yes → evaluateWildcardCondition
        │        │                                            │
        │        │                                            └─ strTxVal.length > 0 → match / no-match
        │        └─ no ──► engine-specific path (unchanged)
        │
        ├─ description_matches / amount_*  → routed as explicit no-match (contract above)
        └─ other values → normal evaluation (unchanged)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/rule-engine/wildcard.ts` | Create | Shared guard: `isWildcardValue`, `evaluateWildcardCondition`, `WILDCARD_SURFACE` table |
| `src/lib/services/rule-matching-engine.ts` | Modify | Replace inline `:48-49` guard with `evaluateWildcardCondition` call; keep non-empty semantics |
| `src/lib/rule-engine/conditions/description.ts` | Modify | In `contains`/`eq`/`starts_with`/`ends_with`, short-circuit `*` via shared guard (literal path otherwise) |
| `src/lib/rule-engine/conditions/amount.ts` | Modify | Route `*` to explicit no-match (never `Number('*')` → `InvalidNumericValue`) |
| `src/lib/rule-engine/conditions/index.ts` | Modify | (Optional) central dispatcher hook if surface guard should pre-empt evaluators |
| Adapter normalization (`rule-engine-adapter` or `rule-precedence-compat`) | Modify | Legacy-column normalization: conditions-first, fallback legacy → canonical, fail closed (case 4) |
| `description_matches` | Modify | `*` as invalid regex → no-match via shared contract, not `InvalidRegex` throw |
| `tests/bre011-wildcard-corpus.test.ts` | Modify | After implementation, assert the acceptance matrix (currently observational) |
| Validation layer (create/import) | Create | Shared domain/API validation rejecting `*` on amount/regex |

## Interfaces / Contracts

```ts
// src/lib/rule-engine/wildcard.ts
export const WILDCARD_SURFACE: Readonly<Record<string, boolean>>;
export function isWildcardValue(value: string): boolean;   // normalizeText(value) === '*'
export function evaluateWildcardCondition(
  condition: RuleCondition,
  transaction: Transaction,
): EvaluatedCondition | null;   // null → engine continues normally
```

Contract: `evaluateWildcardCondition` MUST return non-null only when `WILDCARD_SURFACE[type]` is true AND value is `*`; MUST match iff normalized tx value is non-empty; MUST never throw for `*`.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `wildcard.ts` guard | Direct calls: surface membership, non-empty match, empty no-match |
| Unit | Legacy / V2 / Precedence engines | Re-run `tests/bre011-wildcard-corpus.test.ts` (8 cases) asserting parity |
| Unit | Legacy-column normalization | conditions-first, legacy fallback, fail-closed (general, not just `*`) |
| Integration | Validation rejection of `*` on amount/regex | Rule create/import path rejects; error surfaced via shared layer |
| Regression | BRE-009 parity harness | W-1 no longer diverges on bounded surface |

## Migration / Rollout

No data migration. Behavior change applies only to conditions with value `*` (currently 0 real rules, 0.00% prevalence). Rollback: revert all `wildcard.ts` consumers (Legacy `rule-matching-engine.ts`, `conditions/description.ts`, `conditions/amount.ts`, `conditions/index.ts`), delete the shared module `wildcard.ts`, restore the Legacy inline guard, revert legacy-column normalization, and revert the corpus test to observational mode.

## Open Questions

All previously open questions are RESOLVED (2026-08-02):

- [x] **#1 — no-match vs validation failure:** RESOLVED — runtime no-match + write/import rejection (proposal §11 Decision #1).
- [x] **#2 — legacy-column passthrough (case 4):** RESOLVED — conditions-first, fallback legacy → canonical, fail closed (proposal §11 Decision #2).
- [x] **#3 — starts_with / ends_with [Design decision]:** adopted as normative in `rule-wildcard-semantics`; implementation follows spec.

Moved to `sdd-tasks` (implementation detail, not architecture): **validation-rejection placement** — which layer enforces rejection (rule create UI, import resolver, DB-level check) — resolved as shared domain/API layer in Decision #1.
