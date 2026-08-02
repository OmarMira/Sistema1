# Proposal: BRE-011 — Wildcard Semantics

**Change:** `bre-011-wildcard-semantics`
**Base:** `01-explore.md` (exploration, incl. §6 engine behavior + §9 open questions) · observed 8-case matrix (§12) · `tests/bre011-wildcard-corpus.test.ts` (observational — no semantic assertions)
**Artifact store:** openspec
**Status:** Proposal (gate → `sdd-spec`)

## 1. Observed evidence (closed — facts are NOT reopened here)

Measured, not asserted (`01-explore.md` §12.1, 12.2, 12.3; test 7/7 PASS; `tsc` clean):

| # | Case | Legacy | Precedence | V2 | Axis A | Axis B |
|---|---|---|---|---|---|---|
| 1 | `description_contains("*")`, probe no `*` | WINNER | NO_MATCH | pending | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `SAME` |
| 2 | `description_contains("*")`, probe WITH `*` | WINNER | WINNER | matched | `SAME_WINNER` | `SAME` |
| 3 | `description_eq("*")`, probe no `*` | WINNER | NO_MATCH | pending | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `SAME` |
| 4 | legacy-column `equals / "*"` (v2 stored null) | WINNER | NO_MATCH | pending | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `V2_ERROR` (`conditions_normalization_failed`) |
| 5 | `amount_gt("*")` | WINNER | NO_MATCH | pending | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `V2_ERROR` (`engine_execution_error`) |
| 6 | `description_matches("*")` | WINNER | NO_MATCH | pending | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `V2_ERROR` (`engine_execution_error`) |
| 7 | `description_matches(".*")` | NO_MATCH | WINNER | matched | `PRODUCTIVE_NO_MATCH_CANONICAL_MATCH` | `SAME` |
| 8 | `description_contains("*")`, probe EMPTY | NO_MATCH | NO_MATCH | pending | `BOTH_NO_MATCH` | `SAME` |

Verified execution path (`01-explore.md` §12.2): Legacy wildcard is a single guard at `rule-matching-engine.ts:48-49` — `if (strCondVal === '*') return strTxVal.length > 0` — evaluated BEFORE the operator switch (`:51`), field/operator-agnostic, and matching only **non-empty** normalized values. `.*` is NOT intercepted (case 7); `description_matches("*")` IS intercepted so the regex is never evaluated (case 6). Real-data prevalence: **0 wildcard rules** (0.00%).

## 2. Contract alternatives (the decision)

| Option | Contract | What `*` means |
|---|---|---|
| **A — Explicit, limited wildcard** | `*` = "matches any non-empty value", scoped to **string description operators only** (`contains`, `eq` — measured; `starts_with`, `ends_with` — design decision to justify in spec). Guard preserved. Excluded: `description_matches` (regex family), amount operators (defined no-match). V2/Precedence aligned to the same guard. | wildcard, bounded |
| **B — Preserve broad Legacy behavior** | `*` = "matches any non-empty value" for ANY operator/field, exactly as the pre-switch guard ships today. V2/Precedence replicate it everywhere. | wildcard, unbounded |
| **C — Literal in all engines** | `*` is a literal character in all three engines; the Legacy wildcard branch is removed. | literal |

## 3. Recommended decision — **Option A** (justified by evidence, not preference)

Each evidence point below is split into **Observation** (measured fact), **Implication** (what the fact entails), and **Recommendation** (design decision), so the spec can adopt closed decisions.

**1. Non-empty boundary**

- **Observation:** Case 8 — Legacy `NO_MATCH` on empty description; the wildcard guard returns `strTxVal.length > 0` (`rule-matching-engine.ts:48-49`). The wildcard is "any **non-empty** value", not "anything".
- **Implication:** Option A formalizes what Legacy actually ships; it is the smallest semantic change.
- **Recommendation:** preserve the non-empty guard as the wildcard boundary.

**2. Coherent surface (measured operators)**

- **Observation:** Cases 1, 3, 8 — description string operators `contains` and `eq` with a non-empty probe produce the productive Legacy match. This is documented, tested intent (`rule-matching-engine.test.ts:162-166`).
- **Observation (scope):** the 8-case matrix probes `contains` and `eq` only. **No case probes `starts_with`/`ends_with`.**
- **Implication:** the measured evidence supports `contains` and `eq`; extending to `starts_with`/`ends_with` is NOT an evidence-backed fact, it is a design extension.
- **Recommendation:** adopt `contains`/`eq` as evidence-backed; `sdd-spec` must justify `starts_with`/`ends_with` explicitly as a design decision, or exclude them.

**3. `description_matches` is a separate family**

- **Observation:** Case 6 — `*` intercepts the regex before evaluation (Legacy WINNER on an invalid pattern; side effect, not regex semantics). Case 7 — `.*` is NOT intercepted and produces `PRODUCTIVE_NO_MATCH_CANONICAL_MATCH`, the inverse family.
- **Implication:** `description_matches` collides with the wildcard guard; regex and wildcard-marker are distinct semantics (§9 Q5).
- **Recommendation:** exclude `description_matches` from the wildcard surface.

**4. Numeric operators require an explicit contract**

- **Observation:** Case 5 — `amount_gt("*")` is a non-empty amount matcher in Legacy but `engine_execution_error` in V2; the "any non-empty" semantics is not meaningful for a numeric comparator.
- **Implication:** numeric wildcard semantics produce inconsistent behavior across engines; a contract is required before implementation. Several resolutions are possible (exclude amount; treat `*` as invalid and reject the rule at validation; numeric wildcard).
- **Recommendation (RESOLVED 2026-08-02):** numeric operators and `description_matches` are non-`*`-supporting. **Runtime:** `*` on those operators produces an explicit no-match, never an exception. **Write/import:** rules with that combination are rejected at validation. Validation lives in a shared domain/API layer used by both create and import (UI shows the message but is NOT the only barrier); no DB-level restriction is added — the semantics belong to the rule domain, not the physical schema.

**5. Literal-`*` convergence**

- **Observation:** Case 2 — probe literally containing `*` → all three engines agree (`SAME_WINNER`).
- **Implication:** the wildcard does not break literal-`*` matching when the value is non-empty; alignment does not regress case 2.
- **Recommendation:** keep case 2 behavior stable under the bounded wildcard.

**6. Option C is not justified by data**

- **Observation:** 0 wildcard rules in real data (prevalence 0.00%); Legacy is the productive path (`route.ts:92-103`); the wildcard branch is documented and tested.
- **Implication:** removing the branch would delete shipped behavior for symmetry with V2/Precedence, with no measured evidence of harm.
- **Recommendation:** do not adopt Option C.

**Consequence:** BRE-011 specifies a bounded wildcard: description string operators with the non-empty guard preserved, regex and amount excluded. `contains`/`eq` are evidence-backed; `starts_with`/`ends_with` are a design decision the spec adopted as normative. V2/Precedence implement the same guard to close the axis-A `W-1` divergence (BRE-009) on the bounded surface. Both Open Questions are RESOLVED (see §11).

## 4. Productive impact

- **Today: none.** 0 wildcard rules in dev (prevalence 0.00%); the productive path (Legacy) keeps its behavior for description string operators. No tenant rule changes.
- **Latent future impact:** a future rule with `*` on description will match identically across Legacy/V2/Precedence (divergence closed). A future rule with `*` on amount or `description_matches` will NOT match in Legacy (changed from today's accidental match) — a deliberate, documented behavior change with no current data dependency.
- **BRE-009 W-1** (`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`) becomes a no-op on the bounded surface after alignment.

## 5. Compatibility risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Changing Legacy for `amount_gt("*")` / `description_matches("*")` (WINNER → no-match) breaks a hypothetical tenant rule | Low (0 real rules) | Document as breaking-only-for-unmeasured-inputs; gate on real-data re-measure if a wildcard rule appears |
| Aligning V2/Precedence to the guard changes their behavior for `*` on description | Medium (behavior change, but only for rules that previously diverged) | Bounded surface + parity tests for the 8-case matrix |
| Legacy-column passthrough (case 4): V2 cannot normalize (`conditions_normalization_failed`) | Medium | RESOLVED: conditions-first, fallback legacy → canonical normalization (§11) |
| `description_matches(".*")` regex parity remains divergent (case 7) | Known | Explicitly OUT of scope (regex family); tracked, not fixed by BRE-011 |
| Removing the wildcard branch later (Option C re-decision) | Low | Rollback plan below |

## 6. Criteria that would block advancing to `sdd-spec`

All previously open criteria are resolved (2026-08-02); none block `sdd-apply`:

- ~~Re-decision to **Option B or C**~~ — Option A stands approved.
- ~~**Real wildcard rule appears**~~ — no wildcard rules in any environment as of spec date; re-measure guard remains active for implementation.
- ~~**No agreement on the bounded surface**~~ — surface adopted (evidence-backed + design decision) in `rule-wildcard-semantics`.
- ~~**Legacy-column passthrough canonicalization** (case 4) left undecided~~ — RESOLVED: conditions-first, fallback legacy → canonical (§11).
- ~~**V2/Precedence alignment refused**~~ — alignment is part of Option A, approved.
- ~~**Runtime contract (no-match vs validation failure)**~~ — RESOLVED: runtime no-match + write/import rejection (§11).

## 7. Capabilities (contract with `sdd-spec`)

- **New — `rule-wildcard-semantics`**: definition of `*` on the bounded surface (description string operators, non-empty guard), exclusion of regex/amount, alignment contract for Legacy/V2/Precedence, legacy-column canonicalization. (New `openspec/specs/rule-wildcard-semantics/spec.md`.)
- **Modified — `rule-engine-integration`**: condition normalization/adapter must route `*` per the wildcard contract (add delta requirements for `*` handling).

## 8. Scope / non-goals

**In:** wildcard semantics spec + parity contract across the three engines (spec-level only; engine work is a later BRE/apply phase).

**Out (deferred):** `description_matches` regex parity (case 7) · empty-description matching policy beyond preserving the guard · any production engine implementation · `sdd-propose` does not modify `src/` or `tests/`.

## 9. Rollback plan

Spec-phase rollback: delete/revert `02-proposal.md` + any delta specs; no code involved. Post-apply rollback: revert the wildcard guard in V2/Precedence and restore Legacy branch; revert legacy-column normalization (case 4); parity tests for cases 1–8 revert to pre-alignment expectations. All behavior is confined to rule matching — no data migration required.

## 11. Resolved decisions (2026-08-02)

### Decision #1 — contract for `*` outside the bounded surface

**Approved:** Runtime — `*` on numeric operators or `description_matches` produces an explicit no-match, never an exception. Write/import — new rules with that combination are rejected at validation. Validation lives in a shared domain/API layer used by both creation and importation (UI shows the message but is not the only barrier). No DB-level restriction for `*`; semantics belong to the rule domain, not the physical schema.

### Decision #2 — legacy-column passthrough normalization (case 4)

**Approved:** When `conditions` is not a usable representation and `conditionType`/`conditionValue` exist, the adapter MUST normalize the legacy columns to the canonical model before V2 execution. Precedence is fixed:

1. `conditions` non-empty and valid → use `conditions`.
2. Else → fallback to `conditionType`/`conditionValue`.
3. If neither representation can be normalized → fail closed.

For `conditionType = "equals"`, `conditionValue = "*"` → canonical `description_eq("*")`, then routed through the same shared wildcard contract. It MUST NOT keep `conditions: null` on the new productive path; the null-preservation was correct for BRE-010's observational harness (measure existing behavior), not for correction.

## 10. Success criteria

- [ ] The 8-case matrix (cases 1–8) is the acceptance matrix; `*` behaves identically across Legacy/V2/Precedence on the bounded surface.
- [ ] Case 8 (empty) preserves `BOTH_NO_MATCH`; case 2 (literal `*`) preserves `SAME_WINNER`.
- [ ] Cases 5, 6 no longer produce `V2_ERROR`; amount/regex `*` is an explicit no-match contract.
- [ ] BRE-009 `W-1` no longer diverges on the bounded surface.
- [ ] No real-data dependency changed (prevalence still 0.00% or explicitly re-measured).
