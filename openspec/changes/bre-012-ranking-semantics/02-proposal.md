# Proposal: BRE-012 — Ranking Semantics

**Change:** `bre-012-ranking-semantics`
**Base:** `01-explore.md` (ranking divergence measurement, R-1 reproduction, real-rule fixture, `file:line` engine paths) · BRE-009 (measure-rule-parity synthetic harness) · BRE-010 (scrubbed real-rule conformance) · BRE-011 (wildcard, archived).
**Artifact store:** openspec
**Status:** Proposal (gate → `sdd-spec`)

---

## 1. Observed evidence (closed — facts are NOT reopened here)

Measured, not asserted (`01-explore.md` §6, §7, §8, §11; `npx vitest run tests/measure-rule-parity.test.ts` 26/26 PASS; `measure-real-rule-parity.test.ts` 17/17 PASS; working tree clean at `main` @ `351d050`).

| Evidence | Value | Source |
|---|---|---|
| **R-1 reproduction** — axis B (V2 vs Precedence) `DIFFERENT_WINNER` | reproduces on `main` @ `351d050` | `01-explore.md` §6; `tests/measure-rule-parity.test.ts` (`R-A/R-B` at `:114-121`, order-sensitivity at `:954-960`): run `npx vitest run tests/measure-rule-parity.test.ts` |
| R-1 axis A (Legacy vs Precedence) | `SAME_WINNER` (both pick `R-A`, coincidence) | §6 |
| BRE-009 baseline — `legacyPrecedenceAgreementRate` | **12/12 (100.0%)** | §8.1 / §11.1 |
| BRE-009 baseline — `v2PrecedenceAgreementRate` | **10/12 (83.3%)** | §8.1 / §11.1 |
| BRE-009 divergence — `DIFFERENT_WINNER` | **1** (R-1) | §8.1 / §11.1 |
| BRE-009 error — `v2ErrorCount` | **1** (`V2_ERROR`, X-1 regex — out of ranking scope) | §11.1 |
| Additional synthetic matrix (C1–C3) | 2/3 vectors change winner (**RANKING**) | §7 / §11.2 (temp harness removed) |
| Real-rule fixture (dev tenant `cmsb5l3gu0002c7toxi368y5i`, "LQ & OM LLC") | 2 real active single-condition rules; real overlap 2; ranking vectors 1 | §8.2 — generated via `scripts/bre010-extract.mjs` (option b) |
| Real ranking divergence (analyzed dataset only) | **0 (0.0%)** axis A and axis B `DIFFERENT_WINNER` | §8.2 — `bre012.multiConditionRuleCount=0`, gate A3 resolved for the analyzed dataset |

### Divergence classes & normalized states (the taxonomy this contract closes)

Classified by *why* two engines differ, not *which* engine is "right" (`01-explore.md` §4):

| Class | Definition | Criterion |
|---|---|---|
| **RANKING** | both engines match, interpret rules identically, but a different ranking **key** changes the top | same canonical conditions, both matched, `winnerA !== winnerB` → the order of merit differs |
| **NORMALIZATION** | the *same rule* was interpreted differently before ranking | re-run on canonically normalized input; if winner becomes `SAME_WINNER`, it was normalization, not ranking |
| **ERROR** | one engine errors / fails closed instead of emitting a candidate | any `V2_ERROR` code / silent `{match:false}` swallow → ERROR, not ranking |

Normalized states (`01-explore.md` §4.4): `SAME_WINNER` · `DIFFERENT_WINNER` (a ranking divergence unless traced to normalization) · `AMBIGUOUS` · `NO_MATCH` · `ERROR`.

### Execution path per engine (evidence `file:line`)

| Engine | File | Winner path |
|---|---|---|
| **Legacy** | `src/lib/services/rule-matching-engine.ts` | filter `:266-268` → single short-circuit `evaluateWinningRule:290` → role priority `:292-322` (fallback `rule.priority ?? 99` `:321`) → sort **rolePriority ASC, dbPriority ASC stable** `:324-327` → winner = first `scored[0].rule` `:329`. **Input order is the load-bearing final tiebreak.** |
| **Precedence** | `src/lib/services/rule-precedence-engine.ts` | normalize `:21-38` → evaluate `:50-61` → discard non-matching `:148` → `computeSpecificityScore`/`computeMatchQuality` `:150-151` → sort **specificity DESC, quality DESC, priority ASC, ruleId ASC** `:170-175` → `AMBIGUOUS` when top-2 tie spec/quality/priority `:178-192` → winner `candidates[0]` `:196`. Specificity = **sum** over `CONDITION_SPECIFICITY` + `directionSpecificity` `:65-81` (2× contains = 80 beats 1× starts_with = 60). |
| **V2** | `src/lib/services/rule-engine/` + `rule-engine-adapter/index.ts` | adapter builds `BankRule[]` `buildRuleInput:78-102` / `buildEngineRule:6-40` → engine sort **highestTier DESC → weightWithinTier DESC → matchQuality DESC → priority ASC → ruleId ASC** (`ranking.ts:4-21`, keys at `:8-20`) → `classify` `decision.ts:6-41` resolves winner/`AMBIGUOUS` (delta `<0.10` `:30-33`) → `mapDecisionToResult` `:42-72`. Specificity = **highest matched tier** then weight within tier (`specificity.ts:24-39`). Role/frequency not loaded anywhere. |

---

## 2. Problem framing — why a single ranking contract is required

- **Three engines, three comparators, inconsistent winner.** Legacy ranks `rolePriority → dbPriority → stable input order`; Precedence ranks `specificity(sum) → quality → priority → ruleId`; V2 ranks `tier → weight → quality → priority → ruleId`. They are three different definitions of "most specific / most deserving rule".
- **`DIFFERENT_WINNER` is possible purely from ranking.** The R-1 replay (`01-explore.md` §6, §7 C1, §11.2) shows V2 picking `R-B` (`starts_with`, tier 2) over `R-A` (two `contains`, tier 1) while Precedence and Legacy pick `R-A`. Cause: **specificity semantics differ** — V2 max-tier-first vs Precedence summed score. This is a first-class, reproducible ranking divergence, **not** normalization and **not** error.
- **`DIFFERENT_WINNER` as a structural class hides the real decision.** As long as each engine defines its own comparator, any gap in signal ordering produces a `DIFFERENT_WINNER` that requires per-case arbitration. The contract's goal is to make `DIFFERENT_WINNER` *impossible from ordering* by giving all three engines one canonical comparator; then **irreducible divergence** can only come from normalization or error (a narrower, auditable set).
- **Real data confirms the decision must be driven by the contract, not by current tenants.** The analyzed dev dataset (2 single-condition rules, priority 10) shows **0 real ranking divergence**; the *signal difference* is proven by the synthetic R-1, which still reproduces on main. The fix is preventive/structural: eliminate order-of-arrival sensitivity (Legacy input order) and unify the specificity semantics *before* real multi-condition tenants appear.

### Canonical algorithm (the contract, defined here — not deferred)

This proposal does NOT stop at "one comparator". It defines a concrete, implementable canonical algorithm so `sdd-spec` writes it down rather than re-deciding it:

**Canonical score per matching candidate (applies to Legacy, Precedence and V2):**
1. **Specificity** (dominant, DESC): highest matched specificity class between **max-condition-tier** (V2's `highestTier`, `specificity.ts:24-39`) and **summed orientation-specific scores** (Precedence `CONDITION_SPECIFICITY` + `directionSpecificity`, `rule-precedence-engine.ts:65-81`). **Tier-first, sum-second**: a candidate with a strictly higher matched tier beats any candidate with only lower tiers, regardless of count; only when tiers tie does the summed specificity break the tie.
2. **Match quality** (DESC): `min + 0.25*(avg−min)` — the same `computeMatchQuality` formula both canonical engines already share (`scoring.ts:8-12`, `rule-precedence-engine.ts:94-99`).
3. **Manual priority** (ASC, lower wins): after tier/weight and quality — never dominant, only a tiebreaker (`ranking.ts:17-18` aligns Precedence to V2 here).
4. **`ruleId ASC`**: the shared **deterministic final tiebreak** (`ranking.ts:20`, `rule-precedence-engine.ts:174`).

**`AMBIGUOUS` (shared computation):** when the top-2 candidates tie on keys 1–3 (same tier, same specificity/weight, same quality, same priority) and their canonical score delta is below the threshold — emit `AMBIGUOUS` rather than a winner. The comparison is **score-delta between first and second** using the canonical score above (not per-engine divergent spaces). The literal **`0.10` threshold is NOT adopted here**: `sdd-spec` must derive or parameterize it with evidence (P4), and the form of comparison (delta vs ratio) is fixed in the canonical comparator as **delta** unless spec re-evaluates with data.

**Order carries NO signal**: no engine reads DB row order, `findMany` defaults, or input/build order as a ranking key. Legacy's input-order tiebreak is removed; `ruleId ASC` is its replacement.

### Normative justification of the canonical order

This section states **why** each level of the comparator is where it is. The order is not incidental nor a copy of V2; each level protects a specific property of the desired ranking. Any future proposal that re-orders these levels must explain how it preserves the property each one protects.

**1. `specificity` first (tier-first) — protects "precise beats generic".**
- This is the only property allowed to override everything else: a rule that matches on a structurally stronger condition must beat a weaker one regardless of how that weaker rule is otherwise configured.
- Concretely, it prevents a manually-prioritized but *generic* rule from beating a clearly more *specific* rule. Without it, an operator could set a high `priority` on a broad `contains` and have it shadow a narrow `starts_with` — inverting the ranking for reasons unrelated to how well the rule discriminates.
- It conserves the dominant property of the V2 engine (`ranking.ts:8-13`, `highestTier` first), so the canonical contract does not regress the specificity semantics already shipped.
- It resolves **R-1 deterministically**: under tier-first, the `starts_with` condition (tier 2) beats two `contains` conditions (tier 1), so V2's `R-B` wins and there is no `DIFFERENT_WINNER` across engines. This is exactly the reproducible ranking change the exploration measured (`01-explore.md` §6/§7), so the primary key is chosen to close that case.

**2. `sum-second` within a tied tier — protects "accumulated evidence matters within the same tier".**
- Once two candidates are in the **same** matched tier, specificity has decided they are *structurally comparable*; the summed signal (`CONDITION_SPECIFICITY` + `directionSpecificity`, `rule-precedence-engine.ts:65-81`) then distinguishes a rule with **multiple relevant conditions** from one with **a single condition** in that tier.
- It deliberately does **not** flatten the whole comparison into one additive score across all tiers: tier-first keeps a *structural gap* superior, so a candidate can never overtake a strictly more specific one by sheer number of weak matches.

**3. `match quality` next — discriminates only equally-specific candidates.**
- Quality is placed **after** specificity: it must not outweigh a structural specificity difference. Its role is to break ties among candidates that are *equally specific* by how well each matched (exact vs partial/contains), using the already-shared `min + 0.25*(avg−min)` formula (`scoring.ts:8-12`, `rule-precedence-engine.ts:94-99`).

**4. `priority` after that — manual intent as a tiebreak, never a dominating signal.**
- `priority` represents the user's explicit intent, but only to *decide among otherwise equal candidates*. Placing it after specificity and quality ensures an admin cannot turn a generic rule into a winner against a more specific one by raising `priority`.
- It keeps user control (ascending, lower wins) without destroying the semantic contract: the comparator stays deterministic and specificity-led.

**5. `ruleId ASC` last — deterministic, reproducible, no fabricated business signal.**
- It removes any dependence on physical DB row order or load/build order (the Legacy input-order tiebreak, `rule-matching-engine.ts:324-329`).
- It guarantees a **stable, reproducible** result for identical inputs regardless of query plan or row ordering.
- It does not introduce a *fictitious business signal*: `ruleId` is only a stable tiebreak, never a ranking reason on its own — it exists solely to make "tied" fully deterministic.

### Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **`priority-first`** | Makes manual intent dominant, so a generic high-priority rule would beat a more specific one — inverting the "precise beats generic" property the contract protects. It also changes the R-1 outcome rather than closing it deterministically, and removes the specificity-first parity V2 already ships. |
| **Single weighted score** | Collapses tier and sum into one flat additive score, so a candidate can overtake a structurally weaker one by accumulation. This recreates the tier-vs-sum conflict that causes R-1 (`01-explore.md` §6), destroying the irreducibility the contract seeks. |
| **Preserve Legacy input order** | Leaves the *only* non-deterministic source of divergence in the set (stable sort on arrival order, `rule-matching-engine.ts:324-329`), so parity cannot be guaranteed and the winner depends on DB row order. It is a regression trap (P2 explicitly removes it). |

---

## 3. Contract alternatives (the decision)

| Option | Contract | Consequence |
|---|---|---|
| **A — Shared canonical ranking** | All three engines (Legacy, Precedence, V2) run the **same deterministic comparator** on a shared ordered decision on **specificity → match quality → manual priority → deterministic final tiebreak (`ruleId ASC`)**; DB/input order carries **no** signal. `DIFFERENT_WINNER` is eliminated as a structural divergence class; it can only remain as a normalization/error remnant (auditable). Final tiebreak deterministic, shared. | **RECOMMENDED** — one source of truth; adversarial parity tests prove closure; no engine dependent on physical row order. |
| **B — Align V2 to Precedence, keep Legacy** | Keep per-engine comparators (Legacy keeps role→db→order); guarantee parity by aligning ONLY V2 to Precedence's comparator. | **Partial** — closes V2-vs-Precedence but **keeps Legacy's input-order divergence**; `DIFFERENT_WINNER`-as-ranking survives Legacy; R-1 axis A/Same only by coincidence; does not close the order-sensitivity class. |
| **C — Keep per-engine comparators, no unified contract** | Do not unify; document divergence as by-design; no code parity work. | **Rejected** — leaves R-1 live, leaves order-sensitivity untouched, and re-labels `DIFFERENT_WINNER` as permanent rather than structural; contradicts the change objective. |

---

## 4. Recommended decision — **Option A** (justified by evidence, not preference)

Each evidence point is split into **Observation** (measured fact), **Implication** (what the fact entails), and **Recommendation** (contract decision) so `sdd-spec` can adopt closed decisions. The canonical algorithm itself is **normative and defined in §2**; the items below justify each signal and are closed. What `sdd-spec` may still do is **justify/refine the `0.10` threshold value** and confirm the engine integration — not re-open the signal order.

**1. Specificity (tier vs sum is the R-1 crux) — RESOLVED: tier-first, sum-second**

- **Observation:** R-1/C1 — V2 ranks `R-B` (starts_with, tier 2) over `R-A` (2× contains, tier 1); Precedence ranks `R-A` (sum 80 > 60). Signal `ranking.ts:8-13`/`specificity.ts:24-33` = max tier + weight; `rule-precedence-engine.ts:150`/`:65-81` = sum over `CONDITION_SPECIFICITY`.
- **Implication:** two different meanings of "most specific"; R-1 proves they conflict. Tier-first encodes "one strongly-typed matcher beats many loosely-typed ones"; sum-first encodes "many conditions beat fewer". Both are defensible; the contract must pick one so all three engines agree.
- **Recommendation (CLOSED):** canonical specificity is **highest matched tier first, summed specificity/weight second** (§2.1). Under it, V2's R-B (`starts_with`, tier 2) wins R-1; Precedence and Legacy are re-aligned to that. This changes Precedence/Legacy on R-1, which is the point: parity is achieved by converging to one semantics, not by documenting two.

**2. Manual priority (0-20)**

- **Observation:** Legacy uses priority as 2nd key (`:325-327`); Precedence as 3rd (`:170-177`); V2 as 4th, after tier/weight/quality (`ranking.ts:17-18`). All flow `BankRule.priority`.
- **Implication:** priority position differs across engines; kept as a **tiebreaker** (never dominant) in canonical engines, dominant in Legacy behind role.
- **Recommendation (CLOSED):** within the canonical comparator, manual priority is the **3rd key, ascending (lower wins)**, after specificity and match quality and before `ruleId` (§2.3). It is never a dominant key in any engine.

**3. Match quality**

- **Observation:** Precedence `matchQuality = min+0.25*(avg−min)` (`:94-99`); V2 same `computeMatchQuality` (`scoring.ts:8-12`); Legacy does not score quality (boolean filter only).
- **Implication:** quality is a discriminative ranking signal in both canonical engines; shared formula.
- **Recommendation (CLOSED):** match quality is the **2nd canonical key (`min+0.25*(avg−min)`, DESC)**, shared by all three engines (§2.2). Legacy adopts it on the canonical path instead of skipping it.

**4. Final tiebreak — `ruleId ASC` (deterministic, shared)**

- **Observation:** Precedence and V2 both end on `ruleId` (`:174`, `ranking.ts:20`); Legacy ends on **input order** via stable sort (`:324-329`, pinned by `measure-rule-parity.test.ts:954-960`).
- **Implication:** the ONLY source of non-deterministic divergence in the whole set is Legacy's input-order dependence.
- **Recommendation (CLOSED):** the canonical tiebreak is deterministic and shared — **`ruleId ASC`** as the final break (§2.4). Legacy's input-order tiebreak is **NOT preserved for compatibility** (perpetuates non-deterministic divergence). DB order and candidate *build* order carry **no** ranking signal in **all** engines (§2.5).

**5. `AMBIGUOUS` — a single criterion**

- **Observation:** Precedence `:178-192` and V2 `decision.ts:30-33` both declare ambiguous when top-2 tie with delta `<0.10`; but their underlying score spaces (tier/weight vs sum) and the way first vs second are compared differ → same input can produce different `AMBIGUOUS` output across engines.
- **Implication:** ambiguity must be a *shared* computation: same delta/umbral/scale and same first-vs-second comparison in all three engines.
- **Recommendation (CLOSED):** `AMBIGUOUS` uses one canonical computation — a **score-delta between the top (1st) and second candidate computed on the canonical score (§2)**, emitted when the top-2 tie on specificity and quality and the delta is below the threshold. Comparison form is pinned to **delta**. The literal **`0.10` value is NOT adopted**: `sdd-spec` must justify or parameterize it with evidence (P4) — but the canonical comparison form is not re-opened.

**6. `rolePriority` / legacy role-frequency — legacy-only, out of scope**

- **Observation:** V2/Precedence never load `entity-roles.json` or role-within-condition (`01-explore.md` §9); response priority does not flow. Only Legacy uses it (`:211-227`, `:308-315`).
- **Implication:** role is a Legacy-only input, not available in the canonical `RuleInput`/`BankRule` shape.
- **Recommendation:** document `role/frequency` as **legacy-only, non-canonical**, and **out of scope**. Any future incorporation requires a separate architectural change (extending `RuleInput`/`BankRule`), not BRE-012.

**7. Order (entry/DB row order) is NOT a signal**

- **Observation:** Legacy ties by input order; Precedence and V2 treat DB order as irrelevant final ruleId tie.
- **Implication:** order-of-arrival can change Legacy's winner while canonical engines disagree.
- **Recommendation:** in the canonical contract, **order carries no signal**; only the deterministic keys rank. This closes the R-1 order class.

**Consequence:** the proposal resolves to **Option A** — a single canonical comparator shared by all three engines that eliminates `DIFFERENT_WINNER` (as a structural ranking class), with the concrete canonical algorithm defined in §2: **specificity (tier-first, sum-second) → match quality → priority ASC → `ruleId ASC`**, a dropped Legacy input-order tie-break, and a unified `AMBIGUOUS` (delta comparison). Role/frequency stays legacy-only (out of scope). The only spec-level freedom retained is deriving/parameterizing the `0.10` threshold value and the engine integration plan — the signal order and comparison form are **closed here**.

### Closed decisions P1–P5 (binding)

- **P1 — Objective = strict parity:** ONE canonical ranking algorithm (defined in §2: specificity tier-first/sum-second → match quality → priority asc → `ruleId ASC`) is adopted by Legacy, Precedence and V2, eliminating `DIFFERENT_WINNER` as a structural divergence class. The algorithm and its signal order are decided here, not deferred.
- **P2 — No order-of-entry/DB dependency:** no engine may use physical DB order or load/build order as a ranking signal. Final deterministic tiebreak is **`ruleId ASC`**. **Legacy input-order tiebreak is NOT preserved for compatibility** (it perpetuates non-deterministic divergence).
- **P3 — role/frequency legacy-only, OUT of scope:** V2 does not consume them by design; documented as legacy-only, non-canonical. Future incorporation requires a separate architectural change (extend `RuleInput`/`BankRule`).
- **P4 — Unified `AMBIGUOUS`:** same delta/umbral/scale and same first-vs-second comparison (delta) in all three engines → same `AMBIGUOUS` result. The literal `0.10` value is NOT adopted; `sdd-spec` must justify or parameterize it with evidence.
- **P5 — Scope = comparator + adversarial parity tests:** BRE-012 implements and verifies closure of the ranking divergence (R-1 included as a closure), not merely documenting the contract.

---

## 5. Scope / non-goals

**In**
- A single shared canonical comparator (contract) that all three engines implement.
- Deterministic shared final tiebreak; removal of Legacy's input-order tiebreak.
- Unified `AMBIGUOUS` criterion.
- Adversarial ranking parity tests, including the R-1 case as a closure.

**Out (deferred / non-goals)**
- **No modification of BRE-009/010/011** artifacts (`tests/measure-rule-parity.test.ts`, real fixture harness, archived wildcard corpus) — reused, not modified.
- **No `role/frequency`/legacy-role analysis or implementation** (P3) — legacy-only, non-canonical, future architectural change.
- **No change to NORMALIZATION** (`conditions-normalizer`, adapter legacy-column mapping from BRE-011) — this change concerns the RANKING comparator only; normalization divergences stay tracked separately.
- **No hard-coding of the `0.10` threshold** without justification — spec must justify or parameterize it (P4).
- **No deployment/config change** (flags `RULE_ENGINE_V2_ENABLED`, `BANK_RULE_ENGINE`, etc.) unless the apply phase explicitly gates it.
- **No modification of productive engine code in this artifact** — `02-proposal.md` only; implementation is `sdd-apply`.

---

## 6. Open decisions deferred to `sdd-spec`

| # | Open decision (spec-level, narrow) | Note |
|---|---|---|
| 1 | **Threshold value for `AMBIGUOUS`** — the literal `0.10` (or a derived/configured value) with evidence/justification (P4) | comparison form (delta) and canonical score are **closed in §2/§4**; only the threshold value remains open |
| 2 | **`0.10` provenance** — justify via measurement or expose as a config parameter | required before hard-coding in apply |
| 3 | **Legacy production path integration** — Legacy's `evaluateWinningRule` (auto route, `route.ts:102-108`) must adopt the canonical comparator; the Re-Legacy/shadow path needs a conversion plan without changing productive behavior unexpectedly (phase the comparator behind an existing flag) | how to land the comparator in Legacy without a regression gate |
| 4 | **Adversarial parity matrix breadth** — which additional vectors (beyond R-1) become normative acceptance cases | spec expands R-1 into a full three-pair parity suite |

---

## 7. Risk / tradeoffs

| Risk | Likelihood | Mitigation |
|---|---|---|
| Changing Legacy's winner for ties (input-order tiebreak removed) breaks a tenant that relies on arrival order | Low–Medium (order dependence is inherently fragile; real dataset: 0 real ranking divergence) | Deterministic `ruleId ASC`; parity tests; document the removed behavior as a deliberate contract change; gate on real-data re-measure when a multi-condition tenant appears |
| Moving/renumbering V2/Precedence specificity semantics (tier vs sum) alters existing agreement (e.g. Legacy vs Precedence covering SAME_WINNER by coincidence on R-1) | Medium | Adversarial parity matrix covers all three pairs; BRE-009 R-1 closure is a hard test |
| `AMBIGUOUS` behavior change with new canonical formula | Medium | Unified formula enumerated in spec (P4); parity tests for ambiguous vectors |
| Wider scope creep into normalization/role/legacy | Low (explicitly non-goaled) | P3 + §5 fences; any role work tracked as a future architectural change |
| Hidden dependency on the old Legacy order in a downstream consumer (`auto` route reads `winner.id`) | Low | Adapter deviation; the comparator is applied before `winner.id` is read; keep a parity/regression gate |

---

## 8. Success criteria

- [ ] All three engines (Legacy, Precedence, V2) run the **same canonical ranking comparator for the same shared `ruleId ASC` final tiebreak**.
- [ ] **R-1 (axis B) no longer produces `DIFFERENT_WINNER`** — closes the primary ranking divergence on `main`.
- [ ] Input/DB order carries **no ranking signal**; the Legacy order-tiebreak test (`measure-rule-parity.test.ts:954-960`) reflects the new deterministic behavior (revamped or re-scoped adversarial).
- [ ] `AMBIGUOUS` yields the **same result across all three engines** on the adversarial parity matrix.
- [ ] `role/frequency` documented as legacy-only; no code consumes it in the canonical path.
- [ ] Adversarial ranking-parity tests added and green; `tsc` clean; BRE-009 harness stays green.

---

## 9. Rollback plan

- **Spec phase rollback:** revert `02-proposal.md` + any delta artifacts; no code involved.
- **Post-apply (engine) rollback:** move the engines back to their pre-change comparators; restore the Legacy stable input-order tie break; revert added parity tests to pre-alignment expectations. All behavior is confined to the ranking comparator and tiebreak, so rollback requires no data migration (cache/fee re-runs as needed).

---

## 10. Next → `sdd-spec`

`sdd-spec` must DROP the closed decisions as normative: P1–P5 plus the concrete canonical algorithm (§2) and its signal order (§4 §1–§5). It must NOT re-open the signal order or the `AMBIGUOUS` comparison form, and must not assume `0.10`. Its remaining narrow latitude is §6: derive/parameterize the `0.10` threshold (P4), define the Legacy/Re-Legacy integration plan, and expand R-1 into an adversarial parity acceptance suite (P5). No production code is touched in this proposal; the working tree remains clean and the artifact is the only new file.