# BRE-011: Wildcard Semantics — Exploration

**Status:** Exploration (review-readiness gate for `sdd-propose`)
**Change:** `bre-011-wildcard-semantics`
**Base:** BRE-010 (scrubbed real-rule conformance measurement — reused, NOT modified)
**Artifact store:** openspec (file-based)
**Scope of this document:** read-only measurement over the dev database + static code analysis. No code, no commits, no changes under `src/`, `tests/`, or any BRE-010 file.

> **Mandatory boundary:** this document does **NOT** decide whether `*` should be wildcard or literal.
> The user's instruction: *"No decidas todavía si `*` debe ser wildcard o literal. Primero medimos el impacto real."*
> This exploration only measures the real impact and hands the decision to `sdd-propose`.

---

## Executive summary

- **The dev database `accountexpress` contains exactly 2 active `BankRule` rows and zero wildcard rules.** The raw scan finds **no `*` character anywhere** in `conditions`, `conditionType`, `conditionValue`, or `transactionDirection`. BRE-011's `wildcardRuleCount = 0`, `wildcardPrevalence = 0.00%`, and `wildcardAxisADivergenceRate` is undefined (no wildcard vectors exist).
- **The Legacy (V1) engine implements wildcard semantics; V2 and Precedence do not.** `rule-matching-engine.ts:48-49` short-circuits any condition whose normalized value is `*` to "matches any non-empty value". V2's evaluators (`conditions/description.ts:15-27`) treat `*` as a literal substring; Precedence reuses the same V2 evaluators. The divergence is exactly the axis-A-only pattern BRE-009 already asserts as W-1 (`tests/measure-rule-parity.test.ts:227-234`: `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`).
- **Consequence for productive rules:** today's productive classification path is the Legacy engine (`src/app/api/reconciliation/auto/route.ts:92-103`), so a rule with value `*` would be **productive in production** (matches any non-empty description) and **dead or erroring in V2/Precedence**. In the current dev dataset no productive rule depends on this — but the code-level divergence is real and would activate the moment any tenant adds such a rule.
- **Abort condition #1 has FIRED:** zero wildcard rules in the whole active rule set ⇒ BRE-011 has **no real evidence base** from BRE-010's protocol over this dataset. `sdd-propose` must decide between a static/code-level basis for the wildcard-vs-literal decision, a synthetic wildcard control corpus, or dataset extension before any implementation.
- **Recommendation:** proceed to `sdd-propose` only with an explicit re-scope decision; the measured zero-prevalence is BRE-010 §7.4 #8's "valid negative evidence that gates the downstream BRE".

---

## Quick path (review order)

1. Read **Section 2 (objective & scope)** — what this exploration measures and what it refuses to do.
2. Read **Section 3 (real wildcard measurement)** — the counts and rates over the dev database (the decisive evidence).
3. Read **Section 6 (engine behavior comparison)** — the file:line evidence for Legacy vs Precedence vs V2.
4. Read **Section 7 (productive-rule dependency)** — why the divergence matters in production.
5. Read **Section 8 (abort conditions)** and **Section 9 (open questions)** — the gate to `sdd-propose`.

---

## 1. Data-source inventory (read-only)

| Entity | Schema ref | Role in this exploration |
|---|---|---|
| `BankRule` | `prisma/schema.prisma:245-272` | **The only rule source.** Active rows across all companies + the known dev company `cmsb5l3gu0002c7toxi368y5i`. |
| `BankTransaction` | `prisma/schema.prisma:185-221` | Read **only as two aggregate counts** (total rows, non-empty-description rows) for the order-of-magnitude match-volume estimate. No row data is selected. |
| `Company`, `GlAccount`, `EntityContext` | — | Never read. |

**Guard discipline (mirrors `scripts/bre010-extract.mjs:801-815`):** the measurement scripts (temp, outside the repo) fail closed unless `NODE_ENV != test` and `DATABASE_URL` points to the dev `accountexpress` database (not `*_test`, not production). Both scripts executed only `count`/`findMany` SELECTs.

---

## 2. Objective & scope

### 2.1 What this exploration measures

- **Real wildcard prevalence** over the dev database: how many active rules carry a condition value of exactly `*` (the BRE-011 definition) and how many carry any `*` substring — across **all** operators and fields.
- **The full operator/field surface** where `*` appears (description_contains, starts/ends, eq, description_matches, amount operators, legacy columns).
- **Intentional-wildcard vs literal-`*`** buckets: exactly `*`, `*foo`, `foo*`, `*foo*`, embedded-only.
- **Regex collision**: `description_matches` patterns containing `*` and their validity.
- **Engine behavior** (Legacy vs Precedence vs V2) with `file:line` evidence — the static basis for the divergence.
- **Affected-transactions order-of-magnitude estimate** from description fill rate.

### 2.2 Non-goals (binding)

| # | Non-goal | Binding statement |
|---|---|---|
| 1 | **No wildcard-vs-literal decision** | This exploration does not decide the BRE-011 outcome. It measures the real impact and hands the decision to `sdd-propose`. |
| 2 | **No implementation** | No engine change, no schema change, no new feature, no commit. |
| 3 | **No modification of BRE-010** | `scripts/bre010-*.mjs`, `tests/measure-real-rule-parity.test.ts`, `tests/scrub-policy-drift-guard.test.ts`, and `openspec/changes/bre-010-*` are untouched. |
| 4 | **No real data in any output** | Only anonymized counts, distributions, prevalence rates, and condition-type/operator breakdowns. No raw descriptions, amounts, rule ids, company ids, or other productive values. |
| 5 | **No in-repo artifacts** | The measurement scripts live under the OS temp dir and are not committed. |

---

## 3. Real wildcard measurement (dev database `accountexpress`)

Run date: 2026-08-02. All figures are exact counts (no sampling), read-only.

### 3.1 Dataset scope

| Metric | Value |
|---|---|
| Total active `BankRule` rows (all companies) | **2** |
| Inactive rows | 0 |
| Companies with active rules | 1 |
| Unmappable rules (canonicalizeRule threw) | 0 |
| Dev company `cmsb5l3gu0002c7toxi368y5i` active rules | 2 (the full dataset) |
| Inactive rows for that company | 0 |

### 3.2 Wildcard prevalence (decisive)

| Metric | Value |
|---|---|
| **Wildcard rules — value exactly `*`, any condition type** | **0** (prevalence **0.00%**) |
| BRE-011 strict definition (`description_contains` value `*`) | 0 |
| Legacy-origin `conditionType='contains'`, `conditionValue='*'` | 0 |
| Any rule containing a `*` substring in any condition value | 0 |
| Total `*` condition-value occurrences | 0 |

### 3.3 Raw-scan cross-check

A raw scan of every string field in every `BankRule` row (`conditions` JSON recursively, `conditionType`, `conditionValue`, `transactionDirection`) found **zero `*` characters**. The zero-prevalence conclusion is not an artifact of canonicalization.

### 3.4 Structural context of the measured rules (anonymized)

| Property | Distribution |
|---|---|
| Origin (canonicalization) | `both` = 2 (all rules carry a `conditions` array AND populated legacy columns) |
| `transactionDirection` | `debit` = 2 |
| Priority band | `1-10` = 2 |
| Condition type | `contains` = 2 (1 condition per rule) |

---

## 4. Field/operator surface where `*` appears

**Empty.** Zero `*` occurrences across all operators. The surface table is included for the future run that DOES find wildcard rules (structure, not prediction):

| Operator / field | Rule count with value exactly `*` | Rule count with `*` substring |
|---|---|---|
| `description_contains` / legacy `contains` | 0 (BRE-011's definition) | 0 |
| `description_starts_with` | 0 | 0 |
| `description_ends_with` | 0 | 0 |
| `description_eq` | 0 | 0 |
| `description_matches` (regex) | 0 | 0 |
| `amount_*` (gt/gte/lt/lte/eq/range) | 0 | 0 |
| `date_*` / `entity_eq` | 0 | 0 |

---

## 5. Intentional-wildcard vs literal `*` analysis

Rule-level buckets over description-family condition values (highest-priority star pattern wins). All zero in the current dataset; the buckets are defined for the measurement contract:

| Bucket | Pattern | Count |
|---|---|---|
| exact | `*` | 0 |
| both | `*...*` | 0 |
| leading | `*foo` | 0 |
| trailing | `foo*` | 0 |
| embedded only | `foo*bar` (no edge star) | 0 |
| any star | any of the above | 0 |

---

## 6. Engine behavior comparison (file:line evidence)

### 6.1 Legacy (V1) — **`*` IS a wildcard**

- `src/lib/services/rule-matching-engine.ts:48-49` — inside `evaluateCondition`, before any operator switch:
  ```ts
  // Wildcard '*' matches any non-empty value
  if (strCondVal === '*') return strTxVal.length > 0;
  ```
  The check is **field-agnostic** (fires for both `description` and `amount` conditions) and **operator-agnostic** (fires before `contains`/`starts_with`/`equals`/`greater_than`/…).
- Value normalization preserves `*`: `normalizeText('*')` → `'*'` (`src/lib/rule-engine/conditions/normalize.ts:1-3`); asserted in `src/lib/rule-engine/__tests__/normalize.test.ts:25`.
- Consumption paths: the `conditions` array path (`rule-matching-engine.ts:163-165`) and the legacy-columns path (`:167-178`, field mapped to `amount` only for `amount_greater`/`amount_less`, everything else `description`). Both funnel through `evaluateCondition`, so both honor the wildcard branch.
- Existing tests confirm intent: `tests/services/rule-matching-engine.test.ts:162-166` ("wildcard * matches any non-empty value") and `:247-260`.

### 6.2 V2 — **`*` is a literal character**

- `src/lib/rule-engine/conditions/description.ts:15-27` (`evaluateDescriptionContains`): `desc.includes(value)` with `value = '*'` — matches only descriptions that literally contain an asterisk. No wildcard branch anywhere in the description evaluators (`:5-59`).
- `src/lib/rule-engine/conditions/amount.ts:4-9`: `Number('*')` → `NaN` → throws `InvalidNumericValue` (`errors.ts:55-59`). An amount condition with value `*` therefore raises `engine_execution_error`, mapped by `runRuleEngineV2Shadow` (`src/lib/services/rule-engine-adapter/index.ts:116-121`).
- V2 entry: `buildEngineRule` calls `normalize(rule.conditions)` (`rule-engine-adapter/index.ts:6-7`); `normalize` passes V2 conditions through unchanged (`conditions-normalizer.ts:90-95`), so the literal `*` reaches the evaluator untouched.

### 6.3 Precedence — **`*` is a literal character (silent)**

- Precedence reuses the V2 evaluators via `evaluateCondition` (`src/lib/services/rule-precedence-engine.ts:1,50-61`), and `evaluateSingleCondition` **catches** any throw (`:56-60`) returning `{ match: false }`. So Precedence never errors on `*` but also never matches it (silent no-match).
- Condition normalization before evaluation: `normalizeInputsForCompatibility` (`rule-precedence-compat.ts:44-81`) — still literal.

### 6.4 The measured divergence (BRE-009 W-1, already pinned)

BRE-009's parity harness already asserts the exact wildcard divergence this exploration explains:

| Vector | Expected axis A | Expected axis B |
|---|---|---|
| W-1 (`*` rule vs any non-empty description) | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `SAME` |

(`tests/measure-rule-parity.test.ts:227-234`.) Axis A = Legacy-vs-Precedence: Legacy matches (wildcard), Precedence does not (literal) → `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`. Axis B = V2-vs-Precedence: both fail to match a literal-`*` description → `SAME`. This confirms the wildcard divergence is **axis-A-only**, exactly as BRE-010 §6.2 states for BRE-011.

### 6.5 Summary table

| Engine | `description_contains='*'` | `amount_*='*'` | Error on `*`? |
|---|---|---|---|
| Legacy (V1) | **wildcard — matches any non-empty** | **wildcard — matches any non-empty** | No |
| Precedence | literal — no match (silent) | literal — no match (silent, exception swallowed) | No |
| V2 | literal — no match | throws → `engine_execution_error` | Yes (amount only) |

---

## 7. Productive-rule dependency analysis

- **The productive classification path today is the Legacy engine.** `src/app/api/reconciliation/auto/route.ts:92-103` filters by `transactionMatchesRule` and picks the winner with `evaluateWinningRule`. V2/Precedence run as shadow/resolver paths (`import.service.ts:88`, `rule-precedence-import-resolver.ts:54,80`).
- **Therefore a rule with value `*` is productive in production today** — it matches any non-empty description. The same rule in V2/Precedence matches only descriptions literally containing an asterisk (effectively dead) and, if `*` sits on an amount condition, V2 errors.
- **In the current dev dataset, NO productive rule depends on wildcard behavior** — zero rules carry `*`. The dependency is code-level and latent: it activates the moment any tenant creates a rule with value `*`.
- **Decision consequence for `sdd-propose` (stated, not decided):** if BRE-011 resolves `*` = literal, the production Legacy path would change behavior (such rules become dead) without any real-data precedent in the dev DB; if `*` = wildcard, the change is a formalization of behavior Legacy already ships, but V2/Precedence would need matching semantics to close the axis-A divergence. Neither direction is validated by real data in this dataset.

---

## 8. Abort conditions (BRE-011 must stop and re-scope before `sdd-propose`)

Mirrors BRE-010 §7.4 fail-closed style. The trigger column records whether the condition **FIRED** in this measurement.

| # | Condition | Triggered? | Evidence / rationale |
|---|---|---|---|
| 1 | **Zero wildcard rules in the whole active rule set** — `wildcardRuleCount == 0`, so `wildcardVectorCount == 0` and `wildcardAxisADivergenceRate` is undefined | **YES (FIRED)** | Measured 2 active rules, 0 with `*`. BRE-011 has no real evidence base from BRE-010's protocol over this dataset. This is BRE-010 §7.4 #8's "zero-prevalence evidence that gates the downstream BRE". |
| 2 | **Degenerate engine comparison** — the only wildcard patterns present are ones V2 cannot evaluate (e.g. `amount_*='*'` → `InvalidNumericValue`, or invalid-regex `*`), so axis B collapses to error-only and no divergence rate is informative | NO (no wildcard rules at all) | Would fire only on a dataset with wildcard rules that are all amount/regex-type. |
| 3 | **Harness/extractor reuse impossible without BRE-010 modification** — re-running BRE-010 as-is over this dataset yields zero wildcard vectors; BRE-011 would need to modify the extractor (synthetic wildcard controls or dataset extension), which violates BRE-010's "reused, not modified" boundary | **YES (design gate)** | The integration approach must be re-scoped (static basis, synthetic corpus, or larger dataset) before proposing. |
| 4 | **Productive-data leak risk in the measurement path** — any BRE-011 measurement that runs real rules through the Legacy engine (to observe wildcard matching) must keep the BRE-010 Point-A scrub + canary gate; a leak in the wildcard path aborts (mirror BRE-010 §4) | NO | The temp scripts emitted only aggregate counts; no productive value was selected. |
| 5 | **Zero active rules in the target company** (BRE-010 §7.4 #7 inherited) | NO | 2 active rules exist; inherited as a hard abort for any future per-company run. |

---

## 9. Open questions for `sdd-propose`

1. **Decision basis:** with zero real wildcard rules, should BRE-011 open/close on (a) a **static/code-level basis** (the Legacy wildcard branch is the product's shipped behavior — formalize it), (b) a **synthetic wildcard control corpus** measured through the BRE-010 harness, or (c) a **dataset extension** (other dev/QA tenants or a seeded wildcard fixture) before measuring? This is the single blocking question.
2. **Semantics scope:** if `*` = wildcard, which operators carry it? Only `description_contains` (BRE-011's current definition), or also starts_with/ends_with/eq and amount operators (Legacy's `evaluateCondition` applies the branch to all)?
3. **Empty-description edge:** Legacy wildcard matches any **non-empty** value (`strTxVal.length > 0`). Should BRE-011 preserve the non-empty guard, and how should an empty-description probe be classified on axis A?
4. **V2/Precedence alignment:** if `*` = wildcard, must BRE-011 also normalize V2/Precedence to match (closing the axis-A divergence), or is BRE-011 purely a semantics specification with engine work deferred to a later BRE?
5. **Regex collision:** `description_matches` with `*` is (a) a regex quantifier, (b) invalid as a bare pattern (`new RegExp('*')` throws), and (c) **not** the wildcard marker in Legacy (Legacy `description_matches` returns `false` via `default`, `rule-matching-engine.ts:71-72`). Confirm BRE-011 excludes `description_matches` from the wildcard surface.
6. **Amount `*` behavior:** Legacy's field-agnostic wildcard branch makes `amount_*='*'` match everything (normalized `"0"` is non-empty). Is this intended, or should BRE-011 define amount `*` as a no-match / error to match V2's `InvalidNumericValue`?
7. **Evidence threshold:** what constitutes a sufficient real-data evidence base for BRE-011 to close? (This dataset: 0 wildcard rules; proposal should state the floor.)

---

## 10. Measurement method & reproducibility

### 10.1 Scripts (temp only, not in the repo)

| Script | Location | Purpose |
|---|---|---|
| `bre011-wildcard-measure.mjs` | `C:\Users\PC Omar\AppData\Local\Temp\opencode\` | Canonicalize every active rule (reusing `canonicalizeRule` from `scripts/bre010-scrub-policy.mjs` via the extractor module), classify wildcard/star/buckets/operators, count aggregate transaction fill rate. |
| `bre011-raw-scan.mjs` | same temp dir | Raw recursive string sweep of all `BankRule` string fields for `*`, plus structural context (origin, direction, priority, condition types). |

### 10.2 Guard discipline

- `NODE_ENV != test` and `DATABASE_URL` → dev `accountexpress` (not test/prod), else hard exit (mirrors `bre010-extract.mjs:801-815`).
- SELECT-only: `findMany`/`count` on `bankRule`; `count` (2 aggregates) on `bankTransaction`.
- No productive value ever emitted: outputs are counts, rates, distributions, and operator/type names only.
- Reuses BRE-010's own canonicalization (`canonicalizeRule`) and wildcard detection (`classifyConditions`, `scripts/bre010-extract.mjs:100-115`) so the prevalence definition matches BRE-010 exactly.

### 10.3 Reproducibility

- Command: `node C:\Users\PC Omar\AppData\Local\Temp\opencode\bre011-wildcard-measure.mjs` (cwd = repo root) and the raw-scan variant.
- Deterministic given the same DB contents; DB changes (rule add/remove) legitimately change the counts — expected, not a failure.
- The artifact records run date and dataset scope (2 active rules, 1 company) so a later run is comparable.

---

## Checklist (reviewer confirmation)

- [ ] Measured the full active rule set + the known dev company; prevalence = 0.00% wildcard.
- [ ] Raw-scan cross-check confirms zero `*` in any rule string field (not a canonicalization artifact).
- [ ] Engine behavior evidenced with file:line: Legacy wildcard (`rule-matching-engine.ts:48-49`), V2 literal (`conditions/description.ts:15-27`), Precedence literal-silent (`rule-precedence-engine.ts:50-61`).
- [ ] BRE-009 W-1 assertion (`measure-rule-parity.test.ts:227-234`) confirms the axis-A-only divergence.
- [ ] No decision on wildcard-vs-literal taken (deferred to `sdd-propose`).
- [ ] Abort condition #1 fired (zero wildcard rules) and is framed as BRE-010 §7.4 #8 negative evidence.
- [ ] No BRE-010 file, `src/`, `tests/`, or productive file modified; no commit; temp scripts outside the repo.
- [ ] Outputs contain only anonymized counts/rates/type names.

---

## Next step

`sdd-propose` for BRE-011 must first resolve the blocking decision (Section 9 Q1: static/code-level vs synthetic corpus vs dataset extension) and the semantics-scope questions (Q2–Q7). Given the zero-prevalence evidence, proposing an implementation without a re-scope decision would be unsupported by real data.

---

## 11. Conclusion and agreed re-scope (review outcome)

**Date:** 2026-08-02. **Outcome:** exploration closes as VALID and documented; no `sdd-propose` yet.

### 11.1 The decisive evidence

- Real database `accountexpress` holds exactly **2 active rules, zero wildcard rules** (`wildcardRuleCount = 0`, prevalence 0.00%). Raw-scan cross-check confirms zero `*` in any rule string field.
- **There is no observable productive behavior on which to design BRE-011.** Specifying wildcard semantics now would rest on opinion or historical compatibility, not evidence.

### 11.2 Agreed direction (chosen option)

Proceed with the **synthetic wildcard corpus measured through the BRE-010 harness infrastructure**:

- Keeps the BRE-010 protocol: synthetic rules, synthetic transactions, reproducible measurement.
- Builds a complete case matrix (`*` in description, amount, regex, equals, contains, …) measured independently of dev DB contents.
- Does not pollute the dev database with fictitious rules.
- Does not depend on sourcing a productive dataset with wildcards.

**Rejected alternatives:**
- *Dataset extension* — introduces artificial data into the database for a problem better solved with a harness.
- *Formalizing Legacy behavior directly* — first we must measure exactly where Legacy, Precedence, and V2 diverge on every relevant case; only then decide whether to preserve or change the semantics.

### 11.3 Re-scope: Work Unit 0

Open a dedicated **Work Unit 0** that generates the synthetic wildcard corpus by reusing BRE-010 infrastructure, then measures the minimal matrix:

| Case | Legacy | Precedence | V2 |
|---|---|---|---|
| `description = "*"` | measure | measure | measure |
| `contains "*"` | measure | measure | measure |
| `equals "*"` | measure | measure | measure |
| `amount = "*"` | measure | measure | measure |
| `description_matches "*"` | measure | measure | measure |
| `description_matches ".*"` | measure | measure | measure |
| `description = literal "*"` | measure | measure | measure |

Only with that evidence does BRE-011 proceed to `sdd-propose`.

### 11.4 Artifact state

- `01-explore.md` — closed, valid, documented. Real-data measurement remains the baseline (Section 3).
- Work Unit 0 will be tracked separately (corpus generation + matrix measurement), not inside this exploration file.

---

## 12. Work Unit 0 — observed wildcard matrix (measured, not asserted)

**Date:** 2026-08-02 (rev. 2). **Method:** `tests/bre011-wildcard-corpus.test.ts` (new, hermetic — no DB, no BRE-010 modification). Reuses the exact engines the BRE-010 harness consumes (`transactionMatchesRule`/`evaluateWinningRule`, `evaluateTransactionAgainstRules`, `runRuleEngineV2Shadow`, `compareRuleDecisions`, `classifyDivergence`) and the scrub-policy view builders. **No parity expectations were hardcoded**: the test only asserts structural invariants and JSON round-trip integrity — it never asserts a semantic outcome. 8/8 cases measured; 7/7 tests PASS; `tsc --noEmit` exit 0.

### 12.1 Observed matrix (evidence — baseline for `sdd-propose`)

| # | Case | Input representation | Probe | Legacy | Precedence | V2 | V2 error | Axis A | Axis B |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `wild-1-contains-no-star` | canonical `description_contains("*")` | desc without `*` | WINNER | NO_MATCH | pending | — | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `SAME` |
| 2 | `wild-2-contains-literal-star` | canonical `description_contains("*")` | desc WITH literal `*` | WINNER | WINNER | matched | — | `SAME_WINNER` | `SAME` |
| 3 | `wild-3-eq-no-star` | canonical `description_eq("*")` | desc without `*` | WINNER | NO_MATCH | pending | — | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `SAME` |
| 4 | `wild-4-legacy-column-equals` | legacy-column `equals / "*"` (passthrough, v2 stored null) | desc without `*` | WINNER | NO_MATCH | pending | `conditions_normalization_failed` | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `V2_ERROR` |
| 5 | `wild-5-amount-star` | canonical `amount_gt("*")` | amount 100 | WINNER | NO_MATCH | pending | `engine_execution_error` | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `V2_ERROR` |
| 6 | `wild-6-matches-star` | canonical `description_matches("*")` | desc without `*` | WINNER | NO_MATCH | pending | `engine_execution_error` | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | `V2_ERROR` |
| 7 | `wild-7-matches-dot-star` | canonical `description_matches(".*")` | desc without `*` | NO_MATCH | WINNER | matched | — | `PRODUCTIVE_NO_MATCH_CANONICAL_MATCH` | `SAME` |
| 8 | `wild-8-contains-empty-description` | canonical `description_contains("*")` | desc EMPTY `""` | NO_MATCH | NO_MATCH | pending | — | `BOTH_NO_MATCH` | `SAME` |

### 12.2 Verified execution path (evidence — what the corpus actually measured)

The corpus exercised the following code path for every case. This is the measured path, not a design intent.

```
transactionMatchesRule(tx, rule, [], false)                     rule-matching-engine.ts:128
│
├─ direction validation                                          :159-160   (rule.transactionDirection 'any' → passes)
│
├─ V2 branch: rule.conditions.every(evaluateCondition)           :163-165
│     │
│     └─ evaluateCondition(tx, cond)                             :30
│           │  field exists?                                      :36-39
│           │  normalizeText(value) = '*'                        :42-43
│           │  empty cond guard                                  :46        ('*' is truthy → passes)
│           │  WILDCARD GUARD                                    :48-49     if (strCondVal === '*') return strTxVal.length > 0
│           │        ↑ branch fires BEFORE the operator switch   :51
│           └─ operator switch (equals/contains/gt/matches…)     :51-73     (NOT REACHED when value is '*')
│
└─ Legacy V1 fallback (passthrough rules, no conditions array)   :167-178   maps conditionType/conditionValue into evaluateCondition — SAME wildcard guard applies
```

Key verified facts (each backed by the file:line above and reproducible by `npx vitest run tests/bre011-wildcard-corpus.test.ts`):

1. **The wildcard check is a single guard** at `rule-matching-engine.ts:48-49`, shared by V2-style condition arrays and Legacy V1 passthrough. It runs **before** the operator switch (`:51`). It returns `strTxVal.length > 0` — i.e. any **non-empty** normalized value matches, regardless of operator.
2. Because the guard precedes the switch, `*` wins for `equals` (cases 3, 4), `contains` (1, 2, 8), `amount_gt` (5) and `description_matches` (6) alike. The operator is irrelevant once `strCondVal === '*'`.
3. **Empty description (case 8):** normalizeText(`""`) → `""`, so `strTxVal.length > 0` is `false` → Legacy `NO_MATCH`. The wildcard is a *non-empty* matcher, not a match-everything matcher.
4. `.*` is NOT intercepted: `strCondVal === '.*'` fails the `'*'` guard, so execution falls through to the operator switch (case 7). Legacy has no regex support → `default`/no-op → `NO_MATCH`.

### 12.3 Deep dive: `description_matches("*")` (case 6)

Why the regex operator never evaluates the pattern — the single most load-bearing case for the design decision:

- **Entry:** `description_matches("*")` is built as a canonical condition array (`jsonOriginRule`), so `transactionMatchesRule` routes to the V2 branch and calls `evaluateCondition` (`rule-matching-engine.ts:163-165` → `:30`).
- **Normalization:** `normalizeText('*')` → `'*'` (a single star is not altered by lowercasing/trimming/collapsing) — `:42-43`.
- **Empty-cond guard passes:** `strCondVal` is `'*'`, truthy — `:46`.
- **Interception:** the wildcard guard `strCondVal === '*'` is `true` → returns `strTxVal.length > 0` immediately — `:48-49`. **The `description_matches` operator is never dispatched**; the switch at `:51` is unreachable for this value.
- **Consequence measured:** Legacy reports WINNER on any non-empty description. Precedence/V2 treat the value literally as regex → in V2 `'*'` is an invalid pattern (bare quantifier) → `engine_execution_error`; Precedence silently no-matches. Result: `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` + `V2_ERROR` (case 6 row).
- **Contrast:** `".*"` (case 7) fails the `'*'` guard (value is `.*`, not `*`) → reaches the operator switch → Legacy has no regex branch → `NO_MATCH`. Same operator, opposite Legacy outcome, purely because of the exact string `*`.

This single case demonstrates that in Legacy the string `*` is **never** interpreted as regex — it is a control value consumed by an earlier guard. That is the fact `sdd-propose` must decide on: preserve the guard (wildcard semantics), or stop intercepting regex values.

### 12.4 Structural invariants verified (Work Unit 0)

- 8/8 matrix cases executed; all outcomes classifiable (axisA ∈ ShadowComparison, axisB ∈ DivergenceType).
- No dead label `V2_PENDING_PRECEDENCE_MATCH` produced.
- Every case ran all three engines to a definite state.
- Canary-free: no BRE-010 sentinel, no `gl-synthetic-001` in probes/outputs.
- The corpus only records; it never asserts a semantic outcome (all `expect` calls are structural or round-trip).

### 12.5 Reproducibility — JSON round-trip (Work Unit 0)

`os.tmpdir()/bre011-corpus-*/observed-matrix.json` is written by the test, then **re-read, re-parsed, schema-validated, and deep-compared** against the in-memory payload (the test asserts `parsed.cases` equals the in-memory matrix, valid ISO `generatedAt`, protocol marker, and 8 rows). This guarantees the recorded artifact is byte-faithful to what was measured.

### 12.6 Deliverables

- `tests/bre011-wildcard-corpus.test.ts` — new, hermetic, no DB, no BRE-010 modification, no commits.
- Observed matrix + verified execution path recorded in this section (§12).
- Observed matrix round-tripped to temp JSON (`os.tmpdir()/bre011-corpus-*/observed-matrix.json`).
- This section (§12) is the baseline that feeds `sdd-propose`.

### 12.7 Pending interpretations (NOT evidence — deferred to `sdd-propose`)

The following readings are deliberately excluded from §12.1–12.5 because they are *interpretation*, not measurement. They are collected here so the proposal phase starts from explicit open questions, each traceable to evidence rows above:

- **"Legacy treats `*` as a wildcard for every operator."** Evidence supports it (cases 1,3,4,5,6,8 all hit the guard before the switch), but the *design reading* — should that behavior be preserved, removed, or made explicit? — belongs to `sdd-propose`.
- **"Precedence/V2 are literal-only."** Evidence: only case 2 (literal `*` in probe) matched; V2 errored on `*` in amount/regex. Whether this is a correctness gap or intended literalism is a proposal question.
- **"`*` in amount is a cross-engine error/behavior gap."** Evidence: Legacy WINNER (guard, non-empty), V2 `engine_execution_error`. The *decision* on amount wildcards is open.
- **"Empty description exposes a legacy/productivity boundary."** Evidence: case 8 `BOTH_NO_MATCH` — Legacy's non-empty guard means `*` does not catch empty descriptions. Whether empty-description handling is in scope for BRE-011 is a proposal question (§9 Q3).
- **"Regex divergence (`.*`) is a separate family from wildcard-marker divergence."** Evidence: case 7 (`PRODUCTIVE_NO_MATCH_CANONICAL_MATCH`) vs cases 1,3,4,5,6 (`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`). Whether BRE-011's surface includes `description_matches` at all is a proposal question (§9 Q5).

### 12.8 Stop point

Work Unit 0 is complete. **Stop before `sdd-propose`** as instructed. The proposal phase must decide on §9 Q1–Q7 informed by §12.1 (observed matrix), §12.2 (verified path), §12.3 (regex interception), and §12.7 (open interpretations) — without re-deriving facts already measured here.
