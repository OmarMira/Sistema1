# BRE-012: Ranking Semantics — Exploration

**Status:** Exploration (review-readiness gate for `sdd-propose`)
**Change:** `bre-012-ranking-semantics`
**Base:** BRE-009 (measure-rule-parity synthetic harness) + BRE-010 (scrubbed real-rule conformance) + BRE-011 (wildcard, archived).
**Artifact store:** openspec (file-based)
**Head:** `main` @ `351d050` (working tree clean at exploration start)
**Scope of this document:** read-only static analysis + measurement of existing harnesses. No production code modified, no commits, no push, no ranking contract decided. Only this artifact is created.

---

## Executive summary

- **BRE-012 measures, does not fix.** The priority is not to correct ranking; it is to prove — with `file:line` evidence — exactly **which signal** changes the winner and **in which engine** (Legacy, Precedence, V2), so `sdd-propose` can later decide the ranking contract from evidence.
- **Rule ranking divergence is REAL and reproducible on the synthetic corpus.** BRE-009's R-1 case (V2 vs Precedence → `DIFFERENT_WINNER`) **still reproduces** on the current code at `main` @ `351d050`: verified by running `tests/measure-rule-parity.test.ts` (26/26 tests pass, R-1 axis A `SAME_WINNER` / axis B `DIFFERENT_WINNER`).
- **The divergence is a genuine RANKING divergence (category 1)**: two engines pick different winners in order of merit — V2 picks `R-B` (`description_starts_with`, specificity **tier 2**) over `R-A` (two `description_contains`, tier 1), while Precedence and Legacy (input-order stable) pick `R-A`. The signal that changes the winner is **specificity**: V2 ranks by **highest matched tier**, Precedence ranks by **summed specificity score**, Legacy ranks by **rolePriority → dbPriority then input order**.
- **BRE-010's real-rule baseline WAS generated and measured.** Resolving blocking question Q1 by the approved option (b), a **real fixture was generated** using `scripts/bre010-extract.mjs` against the dev DB `accountexpress` (company `cmsb5l3gu0002c7toxi368y5i`, "LQ & OM LLC", 2 active rules). Running `tests/measure-real-rule-parity.test.ts` with `BRE010_FIXTURE_PATH` set now passes **17/17**. BRE-012 real metrics: **overlapping rules = 2, ranking vectors = 1, axisB DIFFERENT_WINNER = 0 (0.0%), axisA DIFFERENT_WINNER = 0 (0.0%)**, and **no multi-condition real rules**. The dev tenant is small (2 real active rules, single-condition), so real-data confirms: **no ranking divergence was observed in the analyzed dataset (development tenant)**, while the **synthetic** R-1 divergence (Section 6/11) still reproduces and remains the primary evidence that the ranking *signal differs* between engines.
- **V2 ignores signals Precedence/Legacy use.** V2 has no manual-priority tiebreak until after specificity tiers/weights and match quality; Precedence ranks fixed `priority` as the **3rd** key; Legacy ranks rolePriority→dbPriority. V2's `classify` (decision.ts) does **not** consult db priority at all when tiers/weights/quality differ — priority only surfaces after specificity ties, exactly as `ranking.ts:17-18`.
- **Abort assessment for `sdd-propose`:** from a *code+measurement* basis (BRE-009 + synthetic matrix) the ranking divergence is **demonstrably beyond ranking**, and the **real-rule fixture** was generated (option b) to resolve the earlier impact-data gap. **No ranking divergence was observed in the analyzed dataset (development tenant)** (2 active single-condition rules); the synthetic divergence (R-1) still reproduces and remains the evidence used to decide the ranking contract. This removes the blocking-data gap for the analyzed dataset; the next decision is the ranking contract itself (Section 12).

---

## 1. Objective, scope, and non-goals

### 1.1 Objective

- Confirm the productive code path that produces the **winner** (ranking) in each of the three engines, with `file:line` evidence.
- Enumerate which **ranking signals** each engine uses today and where.
- Classify any divergence into **ranking / normalization / error**, with explicit definitions.
- Define normalized tiebreaker states `DIFFERENT_WINNER / SAME_WINNER / AMBIGUOUS / NO_MATCH / ERROR`.
- Reuse BRE-009 / BRE-010 evidence; verify BRE-009 R-1 still reproduces.
- Quantify potential impact where possible (synthetic corpus here; real-rule gap documented).
- State abort conditions (criteria to NOT proceed to `sdd-propose`).

### 1.2 Scope

- Static analysis of `src/lib/rule-engine/**`, `src/lib/services/rule-{matching,precedence*,engine-adapter}*`, `src/lib/services/rule-precedence-shadow.ts`, `src/lib/services/rule-matching-engine.ts`.
- Execution of existing hermetic harnesses (`tests/measure-rule-parity.test.ts`, BRE-011 corpus) and a **temporary** synthetic ranking matrix (temp file, removed).
- Read-only understanding of BRE-010 extractor/scrubber to document fixture generation for reuse.

### 1.3 Non-goals (binding)

| # | Non-goal |
|---|---|
| 1 | **No ranking contract decided.** This exploration only measures; does not decide which signal should win or the fallback order. |
| 2 | **No production code change** under `src/`, `tests/`, `docs/`. |
| 3 | **No commit / push.** |
| 4 | **No modification of BRE-009/010/011 files.** Reused, not modified (BRE-011 §0 mandated this). |
| 5 | **No real-data extraction** is run in this exploration (no DB access; no fixture exists to wire). Fixture generation *procedure* is documented only. |
| 6 | **No deployment / config change** (flags `RULE_ENGINE_V2_ENABLED`, `BANK_RULE_ENGINE`, etc. left untouched). |

---

## 2. Productive path of each engine (evidence `file:line`)

### 2.1 Legacy (V1) engine — `src/lib/services/rule-matching-engine.ts`

Sequence that produces the winner:

| Step | Location | Behavior |
|---|---|---|
| Filter predicates | `rule-matching-engine.ts:266-268` (`findMatchingRule`) and `:92-99` (auto route), `:90-91` (`transactionMatchesRule` direction guard `:174-175`) | `rules.filter(r => transactionMatchesRule(tx, r, …))` |
| Single-rule short-circuit | `evaluateWinningRule:290` | `if (matchingRules.length <= 1) return matchingRules[0]!` |
| Per-rule role priority | `:292-322` | computes `highestRolePriority` (default `999`, `:296`) by matching condition values to `contexts` role patterns and `rolePrios` map (`:308-318`); falls back to `dbPriority = rule.priority ?? 99` (`:321`). |
| Sort | `:324-327` | `scored.sort((a,b)=> a.rolePriority-b.rolePriority || a.dbPriority-b.dbPriority)` — **ascending rolePriority, then ascending dbPriority** |
| Winner | `:329` | `return scored[0]!.rule` — the **first** after a **stable** sort. |

**productive winner call sites:** `src/app/api/reconciliation/auto/route.ts:102-108` (winner = `evaluateWinningRule`, stored `winner.id`), `rule-matching-engine.ts:274` (inside `findMatchingRule`). Also `rule-precedence-apply-all-resolver.ts:91`.

Key fact: the Legacy winner is the **first element after a stable sort keyed on rolePriority then dbPriority**. Because the comparator is **stable** and returns first on ties, **input order is the final tiebreaker** (this is the load-bearing fact BRE-009 R-1 pins).

### 2.2 Precedence engine — `src/lib/services/rule-precedence-engine.ts`

Sequence that produces the winner:

1. Per-rule normalization: `normalizeRuleForPrecedence` (rule-precedence-compat.ts:21-38) -> `normalize` (conditions-normalizer.ts:90-101).
2. Evaluate each condition via V2 evaluators: `evaluateSingleCondition` (rule-precedence-engine.ts:50-61) -> `evaluateCondition` (conditions/index.ts:23).
3. Discard non-matching: `:148` `if (!evaluated.every(e=>e.match)) continue`.
4. Score candidate: `:150-151` `computeSpecificityScore(normalized,direction)`, `computeMatchQuality(evaluated)`.
5. Rank: `:170-175` **sort by specificityScore DESC, matchQuality DESC, priority ASC (lower wins), ruleId ASC**.
6. Ambiguity: `:178-192` `ABBIGUOUS` when top-2 equal specificityScore, matchQuality delta `<0.10`, and equal priority.
7. Winner: `:196` `candidates[0]`.

Call sites: `rule-precedence-import-resolver.ts:54` (via adapter), `apply-all-use-case.ts:369`, `apply-all-engine`, `rule-precedence-apply-all-resolver.ts:45`.

- Specificity is a **sum** over conditions using `CONDITION_SPECIFICITY` (rule-precedence-engine.ts:65-77), plus `directionSpecificity` (+20 for debit/credit, `:79-81`). So `'2x contains' = 40+40 = 80` beats `'1x starts_with' = 60`.
- Priority is the 3rd key, not dominant unless specificity & quality tie.
- Match quality = `min + 0.25*(avg-min)` (`:94-100`).

### 2.3 V2 engine — adapter + pure engine

**Adapter** `src/lib/services/rule-engine-adapter/index.ts`:
- `buildRuleInput` (`:78-102`) filters `isActive` (`:84`), maps each rule with `buildEngineRule` (`:6-40`), building `BankRule[]`, runs `evaluateRulesPure` (Shadow) or `evaluateRules` (async).
- Winner mapping: `mapDecisionToResult` (`:42-72`): `outcome: 'matched'` iff `decision.result === 'winner'` AND `decision.classification?.glAccountId` AND `decision.ruleId` set (`:49-59`).

**Engine** `src/lib/rule-engine/**`:
| Stage | Function | Location | Signal it produces |
|---|---|---|---|
| pip | `runPipeline` | pipeline.ts:49-83 | candidates: ruleId, conditionScores, priority, action |
| specificity | `computeSpecificity` | specificity.ts:24-33 | `highestTier` + `weightWithinTier` (per matched) |
| score | `computeMatchQuality` | scoring.ts:8-12 | min+0.25*(avg-min) |
| rank | `rankCandidates` | ranking.ts:4-21 | **sort: highestTier DESC → weightWithinTier DESC → matchQuality DESC → priority ASC → ruleId ASC** |
| classify | `classify` | decision.ts:6-41 | winner/ambiguous by tier, then delta threshold 0.10 |
| winner decision | `makeDecision` | decision.ts:59-106 | `EngineDecision` |

The V2 ranking comparator (`ranking.ts:7-21`) uses **specificity tier/weight first**, then match quality, then **priority** (ASC), then ruleId. So V2's pivotal signal is **matched-condition tier** (a `starts_with` = tier 2 beats any tier-1 contains regardless of count), then **weight within tier** (a `description_eq` = weight 400 etc.).

Shadow async entry: `runRuleEngineV2Shadow` (rule-engine-adapter/index.ts:123-138) uses `evaluateRulesPure`; productive/async `runRuleEngineV2` (`:105-111`) uses `evaluateRules` (incl. audit persistence when persistAudit). Call sites: `import.service.ts:88`, `rule-precedence-import-resolver.ts:80`.

---

## 3. Ranking signals per engine (table)

signals considered when choosing a **winner** (not merely whether a rule matches):

| Signal | Legacy (`rule-matching-engine.ts`) | Precedence (`rule-precedence-engine.ts`) | V2 (`rule-engine/ranking.ts`) |
|---|---|---|---|
| **Specificity (number/longem/coverage of conditions)** | Used only via `rolePriority` fallback `?? 99` on `rule.priority`; does NOT count conditions. Influence: none explicit (only if col `role` drives). | **Primary.** `specificityScore` sum over `CONDITION_SPECIFICITY` + `directionSpecificity` (`:65-76`, `:150`). | **Primary.** `highestTier` then `weightWithinTier` per matched condition (`specificity.ts:24-39`, `scoring.ts:27-36`, `ranking.ts:8-13`). |
| **Manual priority (`priority`, 0-20)** | Tiebreaker # 2nd, ascending, stable (`:325-327`). Default `?? 99` when absent (`:321`). | Tiebreaker #3 overall (after spec & quality) (`:170-177`). | Tiebreaker after spec tier/weight & matchQuality: `a.priority-b.priority` (`ranking.ts:17-18`). |
| **match quality (exact vs partial/contains)** | Not scored explicitly (only `transactionMatchesRule` boolean filter; no quality weight). | `matchQuality = min+0.25*(avg-min)` over condition scores (`precedence-engine.ts:94-99`); confidence label `high/medium/low` (`:105-109`). | `computeMatchQuality` (`scoring.ts:8-12`), used as 3rd key (`ranking.ts:14-15`). |
| **DB order (Prisma rows, `findMany`, `take/orderBy`, input order)** | **INPUT order is the load-bearing tiebreaker** for equal rolePriority+dbPriority, because the sort is stable. (BRE-009 R-A/R-B forward/reversed test at `measure-rule-parity.test.ts:954-960`.) | Input order irrelevant for winner modulo `ruleId` final tiebreak (re: `:174`). | Input order irrelevant; last tiebreak is `ruleId` lexical (`ranking.ts:20`). |
| **frequency / legacy role** | `rolePriority` from `entity-roles.json` map loaded via `loadRolePriorities` (`:211-227`), default 999; role contexts (`:308-315`). | Not used. | Not used. |
| **tiebreaker / winner selection** | **first candidate after stable sort** (`:324-329`). | specificity → quality → priority → `ruleId`; ambiguity detection (`:178-193`). | tier → weight → quality → priority → `ruleId`; `classify` handles ambiguous via delta<0.10 (`decision.ts:30-33`). |

**Summary table:**

| Engine | Specificity | Manual priority | Match quality | DB/input order | legacy role/frequency |
|---|---|---|---|---|---|
| Legacy | ✗ (only `rule.priority` used) | ✅ (2nd, asc, stable) | ✗ | ✅ (stable tiebreak) | ✅ `rolePriority` (1st) |
| Precedence | ✅ sum | ✅ (3rd) | ✅ (2nd) | ✗ | ✗ |
| V2 | ✅ tier/weight (1st) | ✅ (4th) | ✅ (3rd) | ✗ | ✗ |

---

## 4. Divergence classification (definitions + criterion)

This section separates the **cause** of a divergence. Given any two engines, a divergence (`DIFFERENT_WINNER`, a polarization, an error) is classified by *why the two engines produced different outputs on the same input*, NOT by which engine is "right".

### 4.1 RANKING divergence
**Definition:** both engines match (candidate sets non-empty) and pick **different winner candidates** (or a different ORDER of merit), *from rules that both engines interpret identically*, but the ranking **key** (specificity vs quality vs priority vs tiebreak) yields a different top.

**Criterion:** during measurement, the same normalizer/evaluator saw the same `conditions`, both engines matched ≥1 candidate, and `winnerA !== winnerB`. E.g. our R-1: V2 `highestTier` (starts_with=2) vs Precedence `specificitySum` (1x starts_with 60 < 2x contains 80) — purely a **ranking** divergence. **This is BRE-012's core signal** and the primary reason to open a ranking contract change.

### 4.2 NORMALIZATION divergence
**Definition:** one and the same rule was **interpreted differently** (normalizer mapped it to a different result) before/during ranking — e.g. legacy columns vs `conditions` array, V1 `{field,operator,value}` vs V2 `{type,value,range?}`.

**Example:** `description_matches` vs `'*'`; a `legacy`-origin rule's `conditionType` mapping. These were the exactly BRE-011 Decision #2 (adapter legacy-column fallback, `rule-engine-adapter/index.ts:6-23`) and BRE-002 (conditions-normalizer). The winner may be a consequence of normalization, not ranking.

**Criterion (how to tell it apart from ranking):** run both engines on an input that is **canonically normalized** (e.g. pre-normalize all conditions to V2 `RuleCondition[]`) and re-convert; if the winner becomes `SAME_WINNER`, the divergence was normalization (not ordering). If the winner still diverges under identical canonical conditions, it's **RANKING**.

### 4.3 ERROR divergence
**Definition:** one engine throws / fails closed (`SAME` not emitted), or returns an error code while the other produces a winner/no-match.

**Examples:** V2 `V2_ERROR` with codes `conditions_normalization_failed` or `engine_execution_error` (rule-engine-adapter/index.ts:116-120); Precedence silently swallows evaluator exceptions → `{ match:false }` (`rule-precedence-engine.ts:56-60`); Legacy `transactionMatchesRule` returns `false`/no filter.

**Criterion:** when measuring, record `v2ErrorCode`, `precedenceState`, `legacyState`; a `legacyState`/`precedenceState` of `NO_MATCH` that equals the endpoint after a failed V2 (or the reverse) makes it ERROR divergence, not ranking.

### 4.4 Normalized tiebreaker state (schema we recommend for the measurement)

When comparing **any two engines** (engine A vs engine B) on a vector:

| State | Meaning | When emitted |
|---|---|---|
| `SAME_WINNER` | both pick the same winning candidate | both matched, winnerA === winnerB |
| `DIFFERENT_WINNER` | both match, but pick different winners | both matched, winnerA !== winnerB (a **ranking** divergence by §4.1, unless traced to normalization) |
| `AMBIGUOUS` | engine A reports ambiguous (≥2 candidates no clear winner) — or engine B | per-engine ambiguity logic (Precedence `:177-194`, V2 `classify`) |
| `NO_MATCH` | neither candidate matched | both engines returned `NO_MATCH` |
| `ERROR` | at least one engine errored/failed closed instead of producing a candidate | engine threw / `V2_ERROR` etc. |

> These mirror BRE-009/010's existing `ShadowComparison` (axis A) and `DivergenceType` (axis B) but are **generalized to any-pair** so BRE-012 can measure any engine pair without referencing the production "legacy vs canonical" asymmetry. Fields already in the production harness: `events.ts` `DivergenceType`, `rule-precedence-shadow.ts` `ShadowComparison`.

---

## 5. Reuse of BRE-009 / BRE-010

### 5.1 Fixtures / harnesses / datasets used

| Asset | Kind | Reused by BRE-012 (this exploration) |
|---|---|---|
| `tests/measure-rule-parity.test.ts` (BRE-009) | synthetic parity harness | Executed **as-is** (Section 6) to confirm R-1; provides `R-A/R-B` definitions (`:114-133`), `compareRuleDecisions`, `classifyDivergence`. |
| `tests/measure-real-rule-parity.test.ts` (BRE-010) | real-rule harness | **Executed** with a real fixture generated for this exploration (Section 8.2). Result **17/17 pass**; BRE-012 block yields real overlap/ranking metrics. |
| `tests/bre011-wildcard-corpus.test.ts` | synthetic wildcard corpus | Not ranking-focused; referenced as context for wildcard/op surface. |
| BRE-010 extractor `scripts/bre010-extract.mjs` + `scripts/bre010-scrub-policy.mjs` | fixture generator | **Analyzed for reuse** — see §5.2. Recommended for real-data measurement of BRE-012 impact (priority bands, condition families). |

### 5.2 BRE-010 real-rule fixture generator — how it works (for reuse)

- **Extractor** `scripts/bre010-extract.mjs` (`runExtract` at `:712-788`):
  - Guards: `NODE_ENV != test` (`:801-804`), `DATABASE_URL` must point to dev `accountexpress` not `*_test`/prod (`:808-815`).
  - Reads active `BankRule` rows for a company via Prisma `findMany` (SELECT-only, `:713-728`); appends synthetic **trap + control** rules (`buildTrapRule`, `buildControlRules` `:176-249`).
  - Scrub each raw rule: `scrubRule` (`scrub-policy.mjs:340-363`) producing `{id,name,companyId,legacyView,v2View,conditions,representationOrigin}`. Remap magnitude/date (a `buildMagnitudeRemap`, `buildDateRemap`).
  - Deterministic RNG (mulberry32 seed = fnv1a of rules) for vectors (`:760-767`); generates single-rule probes `generateProbes` + **multi-rule ranking vectors** `generateRankingVectors` (`:465-490`), controls `buildControlVectors` (`:494-565`).
  - Writes `fixture.json` (`:783-789`).
- **Run invocation:** `node scripts/bre010-extract.mjs --companyId <cuid> [--out <dir>] [--dry-run]`.
- **Measurement:** set `BRE010_FIXTURE_PATH` to the fixture path and run `measure-real-rule-parity.test.ts`. It validates `scrubberVersion === 'bre010-scrub-1.0.0'` (`:32`) and computes per-BRE012 metrics: `bre012.multiConditionRuleCount`, `overlappingRuleCount`, `priorityBandDistribution`, `axisA/axisB DIFFERENT_WINNER` rates, `disagreementByPriorityBand` (`measure-real-rule-parity.test.ts:469-479`, computed at `:551-636`).

**Observation for BRE-012:** BRE-012 real-data impact numbers (how many red / affected transactions) live in BRE-010's `perBre.bre012` block. A real fixture **was generated** in this exploration (Section 8.2) and the harness run returned `DIFFERENT_WINNER = 0` on both axes for the measured tenant. Re-running on another tenant requires regenerating a fixture from the dev DB (manual pre-step via `scripts/bre010-extract.mjs`).

---

## 6. Reproducibility of BRE-009 R-1 (verified)

**Result:** **YES** — R-1 is **reproducible** on the current code at `main` @ `351d050`.

**Evidence:** Run `npx vitest run tests/measure-rule-parity.test.ts` (BRE-009). Output (abridged):

```
R-1  ranking  WINNER  WINNER  SAME_WINNER      (axis A — Legacy vs Precedence)    PASS
R-1  V2       matched WINNER  DIFFERENT_WINNER   (axis B — V2 vs Precedence)        PASS
```

- Definitions: `R-A` = two `description_contains('mercado','pago')`, priority 10, both apply to tx `'mercado pago sa'`; `R-B` = one `description_starts_with('mercado')`, priority 10 (`measure-rule-parity.test.ts:114-121`).
- **Legacy vs Precedence (axis A) = `SAME_WINNER`:** Legacy stable-sort picks `R-A` (tie rolePriority 999, dbPriority 10, input order `[R-A, R-B]` → `R-A`); Precedence picks `R-A` (specificity 80 > 60). Coincidence: both pick `R-A`.
- **V2 vs Precedence (axis B) = `DIFFERENT_WINNER`:** V2 ranks by tier: `R-B` starts_with = tier 2; `R-A` contains = tier 1 → V2 picks `R-B`. Precedence picks `R-A`. The **specificity semantics differ** (tier vs sum).

Additionally the BRE-009 "R-1: input order [R-A,R-B] is load-bearing for Legacy" test (`measure-rule-parity.test.ts:954-960`) **still passes**, proving Legacy's order-sensitivity persists.

**Meaning:** the exact R-1 ranking divergence has **not** been fixed across BRE-009/010/011 — it remains live on main. This is the strongest justification for BRE-012.

---

## 7. Findings — divergence of the winner (synthetic measured)

I measured an **additional synthetic matrix** (temporary harness, since removed) to produce several divergence outcomes beyond R-1. Summary (all produced by the unchanged production code):

| # | Case (rules) | Legacy (rolePrio→prio→order) | Precedence (spec→qual→prio→id) | V2 (tier→weight→qual→prio→id) | Measured axis | Classification |
|---|---|---|---|---|---|---|
| 1 | `R-1-replay` — R-A 2× contains p10 vs R-B 1× starts_with p10 | `R-A` (order) | `R-A` (spec sum 80 > 60) | `R-B` (tier 2) | A SAME_WINNER / B **DIFFERENT_WINNER** | **RANKING** (§4.1) |
| 2 | `priority-5-vs-20` — 1× contains p5 vs 1× contains p20 (equal spec) | `R-L` (p5, lower prio) | `R-L` | V2 **pending** (`V2_NO_MATCH_PRECEDENCE_MATCH`) | A SAME_WINNER / B divergence-by-v2-no-match | **MATCH** (V2 scoping) (§4.3) |
| 3 | `spec-vs-priority` — 1× contains p5 vs 1× starts_with p20 | `R-low` (priority p5) | `R-hi` (starts_with tier/spec) | `R-hi` | A **DIFFERENT_WINNER** / B SAME | **RANKING** (Legacy vs canonical) + note |

(Full measured matrix with exact winner ids in Section 11.)

Key takeaways:
1. **Legacy vs Precedence/V2 diverge** where Legacy weights **lower priority first** (better = smaller `priority`) and canonical engines weight **specificity / tier** above priority. In case C3 Legacy picks `R-low` (p5, `contains`) while Precedence/V2 pick `R-hi` (p20, `starts_with`).
2. **Precedence vs V2 diverge** because Precedence's specificity is a **sum** (2x contains beats 1x starts_with) but V2's is **max-tier-first** (`starts_with` beats any contains), and even when both use the same winner they rank by different 2nd keys.
3. **The winner can change without any normalization/error** — prove RANKING divergence is a first-class cause, exactly what BRE-012 must define.

---

## 8. Potential impact quantified (per engine / type)

### 8.1 Synthetic (executable now, on main)

From BRE-009 harness (12 vectors): `legacyPrecedenceAgreementRate = 12/12 (100%)`; `v2PrecedenceAgreementRate = 10/12 (83.3%)`; **divergence = 1 (`DIFFERENT_WINNER`, the R-1)**; `v2ErrorRate = 1/12 (8.3%)`. (Measured this session.)

Additional synthetic matrix (temp harness, C1-C3 above): **2 of 3 synthesized overlapping-rule vectors produce a ranking divergence** that changes the winner. So synthetic multi-rule overlap has a **high divergence rate**.

### 8.2 Real-rule dataset (BRE-010) — MEASURED

**Generated a real fixture** (option b): `node scripts/bre010-extract.mjs --companyId cmsb5l3gu0002c7toxi368y5i --out <tmp>/bre012-fixture` (read-only SELECTs against dev DB `accountexpress`). Fixture: `scrubberVersion=bre010-scrub-1.0.0`, **9 rules** (`real`=2, `control`=6, `trap`=1) and **16 vectors**. Ran `tests/measure-real-rule-parity.test.ts` with `BRE010_FIXTURE_PATH` set → **17/17 PASS**.

**Real-rule impact table (BRE-012 block):**

| Metric | Value | Evidence |
|---|---|---|
| Real active rules (scrubbed) | **2** | fixture `ruleKind=real`; both `representationOrigin=both`, single-condition, priority 10, debit/any |
| Multi-condition real rules (`bre012.multiCond`) | **0** | harness `bre012.multiConditionRuleCount=0` |
| Overlapping rules (`bre012.overlapping`) | **2** | harness `bre012.overlapping=2` |
| BRE-012 ranking vectors | **1** | harness `bre012.rankingVectors=1` |
| Real ranking divergence (axisA diffWinner) | **0 (0.0%)** | harness `axisA-diffWinner=0` |
| Real rare divergence (axisB diffWinner) | **0 (0.0%)** | harness `axisB-diffWinner=0` |

**Interpretation (scoped to analyzed dataset):** In the analyzed dataset (development tenant, 2 single-condition real rules, priority 10), **no ranking divergence was observed**: both axis A and axis B report `DIFFERENT_WINNER = 0`, and there are no multi-condition real rules. This applies only to the analyzed dataset, not to the system in general. The **synthetic** R-1 divergence (Section 6/11, which still reproduces) is the evidence that the ranking *signal ordering differs* between engines; a larger tenant (multi-condition / overlapping rules) would be needed to observe real ranking divergence. On that basis, **gate A3 is resolved for the current dataset** (Section 10): real divergence is not observed, but the synthetic signal difference remains the decision basis.

### 8.3 Type split (generic estimate from code)

| Signal differing between engine A / B | Forensics whether ranking vs normalization |
|---|---|
| Both engines match; different winner | candidate divergence (ranking) → §4.1 |
| One engine `NO_MATCH` while other picks a candidate | normalization/error divergence (and/or condition normalizer) → §4.2 |
| One engine returns `pending`/`V2_ERROR` | error divergence → §4.3 |
| Both `NO_MATCH` | agreement (`SAME_WINNER`/`BOTH_ no`) — not divergence |

---

## 9. Which signals V2 IGNORES (what the architecture allows)

Refined from Section 3, focusing on V2:

- **V2 ignores `rolePriority` / frequency / legacy role** entirely — the engine never loads `entity-roles.json`, never computes role-within-condition; `ranking.ts` never sees it. **Production implication:** any row that Legacy would rank by a HIGHER role wins would stay lower/no-winner in V2. So if a tenant relies on role-signal to pick the winner, V2 will ignore it.
- **V2 ignores raw DB row order / Prisma default** by design: candidates are built from `availableRules` array; ordering only influences nothing except the final `ruleId` tiebreak in `ranking.ts:20` (lexicographic). So DB ordering is NOT a ranking signal in V2 (it is in Legacy).
- **V2 exposes priority only after spec-tier/weight/quality** (ranking.ts:17-18); Legacy uses priority as the immediate tiebreaker after role; Precedence uses it as 3rd. This is a **ranking intentional difference**, and whether V2 should move priority earlier (or keep a parity guarantee) is a `sdd-propose` contract question.

Does the architecture currently **allow** V2 to use these signals? 
- Priority: **yes** — `BankRule.priority` flows to ranking (`ranking.ts:17`), it's just order-position different.
- Role priority: **no** — role data is not in `BankRule`/`RuleInput` shape; would require extending the input/context (architecture change), gated by `sdd-propose`.

---

## 10. Abort conditions (for NOT advancing to `sdd-propose`)

Mirror BRE-010/011 fail-closed style. Trigger column records whether **fired in this exploration**.

| # | Condition | Fired? | Evidence / rationale |
|---|---|---|---|
| A1 | **No divergence measured** (all engines always pick the same winner) | NO | R‑1 and C3 both produce `DIFFERENT_WINNER`/cross-engine divergence — divergence is real. |
| A2 | **Divergence 100% explainable by normalization and/or error (never by ranking)** | NO (filtered) | Both R‑1/C3 are ranking (see §4.1). Some vectors (C2) are normalization/error-ish but NOT 100%; ranking divergences exist independently. |
| A3 | **Dataset insufficient** (no real-rule fixture; synthetic too small / not representative) | NO (resolved for analyzed dataset) | A real fixture WAS generated and measured (Section 8.2): tenant `cmsb5l3gu0002c7toxi368y5i`, 2 active single-condition rules → 0 real ranking divergence, no multi-condition rules. Impact limited to the measured dataset; a larger tenant would still be needed to observe real divergence. Synthetic R-1 divergence (Section 6) remains the contract-decision basis. |
| A4 | **Ranking contract cannot be evidenced from current code** (single known output keyed to order) | NO | ranking.ts / precedence-engine.ts comparator explicitly enumerable. |
| A5 | **No reusable measurement entry point** (harness not loadable) | NO | Both harnesses load (axis A/B functions), reproducible. |
| A6 | **Real-data extraction requires live DB with productive data in read path** (privacy/hermeticity) | PARTIAL | The real-rule harness is hermetic (Point-A scrub + canary) by design; but generation needs `accountexpress` dev DB. Only the generation is gated, not the measurement. |
| A7 | **The change would fix a phantom that doesn't affect production NOTE** | NO evidence | production path today is Legacy `evaluateWinningRule` (auto route) and canonical engines in import/sharp; legacy will change winner only if tenant uses role/ order — need real rules (A3) to confirm real exposure. |

**Recommendation:** do NOT hold `sdd-propose` on synthetic evidence **alone**; require either (a) an explicit REPRODUCED synthetic contract with the definitions in §4–§6, or (b) a BRE-010 fixture-generated real-rule dataset, before committing to an implementation of a specific ranking signal ordering.

---

## 11. Measurement pre-change (baseline)

Run date: **2026-08-02**, `main` @ `351d050`, working tree clean. Commands: `npx vitest run tests/measure-rule-parity.test.ts` (BRE-009), plus a **temporary** synthetic overlapping matrix (removed; matrix reproduced below).

### 11.1 BRE-009 harness (source of canonical numbers)

From the test report (§6 of output):
- `legacyPrecedenceAgreementRate = 12/12 (100.0%)` — Legacy vs Precedence agree on all 12 vectors.
- `v2PrecedenceAgreementRate = 10/12 (83.3%)` — V2 vs Precedence diverge on 1 + 1 error.
- `v2DivergenceCount = 1` (`DIFFERENT_WINNER`, R-1).
- `v2ErrorCount = 1` (`V2_ERROR`, X-1 — regex; out of scope for ranking).
- `precedenceErrorRate = 0` (Precedence never errors).

### 11.2 Additional synthetic measured matrix (temp, removed)

| # | Input | Legacy winner | v2 winner | Precedence winner | A | B | classification |
|---|---|---|---|---|---|---|---|
| C1 | R-1-replay (2× contains p10 / 1× starts_with p10) | R-A | R-B | R-A | SAME_WINNER | **DIFFERENT_WINNER** | RANKING |
| C2 | priority-5-vs-20 (1× contains p5 / 1× contains p20) | R-L(p5) | pending (V2_NO_MATCH) | R-L | SAME_WINNER | V2 pending | normalization/error boundary — v2 not RANKING |
| C3 | spec-vs-priority (1× contains p5 / 1× starts_with p20) | R-low | R-hi | R-hi | **DIFFERENT_WINNER** | SAME | RANKING (Legacy vs canonical) |

(Full ids: R-A/R-B from BRE-009; the synthetic p5/p20 rules are fabricated for the matrix.)

This quantifies a **≥ 2/3 divergence rate** among synthetic-but-overlapping rules with different specificity family, and models the primary naming: **priority-vs-specificity and sum-vs-tier disagreements**.

---

## 12. Blocking questions for `sdd-propose`

1. **Evidence base for impact:** the real-rule fixture was generated and measured (Section 8.2): the analyzed dev tenant shows 0 real ranking divergence and no multi-condition rules. Given the dataset is small (2 active rules), `sdd-propose` should establish **explicitly** that the contract decision is driven by the synthetic evidence (R-1 signal difference, which still reproduces), not by the real dataset's absence of divergence. If real-rule impact on larger tenants is required, generating additional fixtures is a manual pre-step. This was the single blocking decision; the fixture resolves the availability gap for the current tenant.
2. **What is the target ranking contract?** Must `sdd-propose` define an **explicit, cross-engine order** of eval (e.g. `specificity → quality → priority → tiebreak`), or only surface a ranking *fallback order* for the shadow? — define the exact ordering adversarial (V2 vs Precedence priority position etc.).
3. **Legacy behaviour — order vs priority:** the Legacy engine has a component that is INPUT-ORDER dependent for ties (stable sort). Should BRE-012 define Legacy as "order = explicit required tiebreak", or unify to the canonical engines that ignore DB order? This maps directly to R-1.
4. **Role/frequency signal:** should a future V2 config gate role-priority parity (add role input) or explicitly drop it? Architecture currently excludes it.
5. **Ambiguity contract:** define how `AMBIGUOUS` should behave given `classify` (V2, delta<0.10) vs Precedence (its own 0.10 / equal). Which one is the canonical.
6. **Scope of the ranking change:** only the comparator order in engines, or also the adapter/normalizer (to close normalization-a three-in-the-bucket), or both (each measured separately)?
7. **Impact floor:** what counts as "must fix"—any `DIFFERENT_WINNER` rule, or a per-company/role threshold? Real-data gap makes this easier to state qualitatively now.

---

## 13. Measurement method & reproducibility

- BRE-009: `npx vitest run tests/measure-rule-parity.test.ts` — hermetic, no DB, no env.
- BRE-010: `tests/measure-real-rule-parity.test.ts` — hermetic but aborts in `beforeAll` when `BRE010_FIXTURE_PATH` empty (fail-closed, preexisting, line 957-963). Requires a fixture (generated as Section 5.2).
- Additional synthetic ranking matrix: a **temporary** vitest file placed in `tests/` to enable the `@/` alias, run, then **removed** (git tree clean, verified `git status`). Matrix in Section 11.2.
- Reuse `compareRuleDecisions` (`rule-precedence-shadow.ts:141-172`) and `classifyDivergence` (`events.ts:30`) for axis A / axis B.

---

## Checklist (reviewer confirmation)

- [ ] Productive winner paths evidenced with `file:line` for Legacy (§2.1), Precedence (§2.2), V2 (§2.3).
- [ ] R-1 reproduced on main @ `351d050` (§6) — YES, `npx vitest run tests/measure-rule-parity.test.ts` passed with axis-B `DIFFERENT_WINNER`.
- [ ] Divergence classification (ranking / normalization / error) defined with examples (§4.1–§4.3), and states (`DIFFERENT_WINNER`/`SAME_WINNER`/`AMBIGUOUS`/`NO_MATCH`/`ERROR`) normalized (§4.4).
- [ ] Signals-per-engine table with `file:line` (§3).
- [ ] V2-ignored signals and whether architecture allows them (§9).
- [ ] Abort conditions enumerated (§10) with the real-data gate flagged (A3).
- [ ] Baseline numeric values recorded (§11) and real-data gap documented.
- [ ] No production code change; no commit; no BRE-009/010/011 file modified; temp file removed; tree clean.