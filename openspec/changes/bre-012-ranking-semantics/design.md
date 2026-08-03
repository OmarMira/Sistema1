# Design — BRE-012 Ranking Semantics

**Change:** `bre-012-ranking-semantics`
**Inputs:** `01-explore.md` (measurement) · `02-proposal.md` (closed contract P1–P5 + canonical algorithm §2) · `specs/rule-ranking-contract/spec.md` (normative requirements)
**Status:** Design → (gate) `sdd-tasks`
**Design principle:** the canonical comparator is a **single, pure, shared module**. The three engines keep their *collection/normalization* responsibilities (which differ legitimately) and converge on the same *scoring + ranking + decision* logic. No ordering, `AMBIGUOUS`, or specificity semantic lives inside any individual engine anymore.

---

## 1. Components that must change

| Layer | Current state | Target |
|---|---|---|
| **Shared comparator** | none — sort/classify logic exists duplicated in `v2` (`ranking.ts`, `decision.ts`, `specificity.ts`) and partially in Precedence (`rule-precedence-engine.ts`) | one pure shared module with canonical specificity, comparator keys, and `AMBIGUOUS` resolution |
| **V2 scoring/ranking** | `specificity.ts` (tier/weight) + `scoring.ts` (matchQuality) + `ranking.ts` (5-key) + `decision.ts` (classify + `AMBIGUOUS`) | V2 **delegates** ranking + decision to the shared module; keeps its pipeline/collection/eval |
| **Precedence engine** | own summed `CONDITION_SPECIFICITY` + `directionSpecificity` + own sort + own `AMBIGUOUS` | adopt shared specificity (`tier-first, weight-second`) + shared comparator + shared `AMBIGUOUS`; drop its own scoring maps/sort |
| **Legacy engine** | `evaluateWinningRule` sorts by `rolePriority → dbPriority → input order` (no specificity/quality) | adopt shared comparator for the winner; **remove** the `rolePriority/dbPriority/input-order` sort from the decision path |
| **Normalization** | `conditions-normalizer.ts`, wildcard (BRE-011) | **No change** — normalization divergences stay out of scope (P3 norm). Legacy `transactionMatchesRule` stays the collection filter. |

The engines keep their distinct *front-end* (how a candidate is collected/evaluated) and must now share the *back-end* (scoring, ranking, decision) — the exact split the contract requires.

---

## 2. Logic extracted into the shared comparator

New module `src/lib/rule-engine/canonical-ranking.ts` (pure, no I/O, no DB, no flags):

| Export | Responsibility | Source of truth |
|---|---|---|
| `CanonicalCandidate` | smallest candidate shape needed to rank/classify: `{ ruleId, specificityScore: {highestTier, weightWithinTier}, matchQuality, priority, action }` | `types.ts` `ScoredCandidate` |
| `AMBIGUITY_DELTA_THRESHOLD = 0.10` | shared, contract-level threshold | `decision.ts:4` (rehomed) |
| `comparator()` : `(a,b) => number` | the canonical total order: tier DESC → weight DESC → quality DESC → priority ASC → `ruleId.localeCompare` ASC | `ranking.ts:8-20` |
| `rankCanonical(candidates)` | stable sort orders to `ruleId ASC` | `ranking.ts`, `rule-matching-engine` order removed |
| `classifyCanonical(ranked)` → `{ winner, ambiguous, reason, delta }` | shared decision incl. `AMBIGUOUS` delta rule | `decision.ts:6-41` condensed into one shared implementation |

Scoring inputs are the **existing shared sources**, untouched: `computeSpecificity` (`specificity.ts:24-33`) and `computeMatchQuality` (`scoring.ts:8-13`). The comparator reads only precomputed `CanonicalCandidate`s, so it never depends on engine internals (V2 `BankRule`/`EvaluatedCondition` vs Precedence `RankedCandidate` vs Legacy `MatchingRule`).

---

## 3. Which engines consume the shared comparator

| Engine | Consumption of shared module | Removed local logic |
|---|---|---|
| **V2** | `index.ts` pipeline already produces `ScoredCandidate[]` → replace `rankCandidates` internals to delegate to `rankCanonical`; `makeDecision/classify` delegate to `classifyCanonical` | async removed duplicate keys + delta CLI in `decision.ts:23-40` |
| **Precedence** | in `evaluateTransactionAgainstRules`, after building candidates, map to `CanonicalCandidate` → `rankCanonical` + `classifyCanonical`; drop `conditionSpecitivity` sort & own `AMBIGUOUS` block | shared `CONDITION_SPECIFICITY` map, `directionSpecificity`, `computeSpecificityScore` sum, inline sort `:170-175`, `AMBIGUOUS` `:178-192` |
| **Legacy** | in `evaluateWinningRule`, collect matched rules → build `CanonicalCandidate` (tier/weight/quality/priority) → `rankCanonical` + `classifyCanonical` for the winner | `rolePriority` loop `:295-322`, `dbPriority` fallback, `scored.sort` `:324-327` |

---

## 4. Engine-specific responsibilities that REMAIN (NOT extracted)

| Engine | Keeps (front-end) | Loses (back-end) |
|---|---|---|
| **V2** | `pipeline.ts` candidate collection+eval, only canonical conditions (`BankRule`), `evaluateConditions`, trace/audit, flag gating | own rank keys + own delta classify |
| **Precedence** | `normalizeRuleForPrecedence`, direction pre-filter, `evaluateSingleCondition` (reuses V2 SSOT), per-rule masking | own specificity model + sort + `AMBIGUOUS` |
| **Legacy** | `transactionMatchesRule` (boolean collection, entity-first, wildcard via BRE-011), `loadRoles` (but **no longer decides ranking**) | role/db/input ordering as a ranking signal |

**Role/frequency**: Legacy still *loads* `entity-roles.json` (`loadRolePriorities`) but it is **not consumed to rank**. Decision to select `winner.id` reads the canonical comparator's output only.

---

## 5. Full evaluation flow (both named)

The pipeline across environments becomes:

1. **Normalization/validation** (per engine): `RuleInput` -> normalize `BankRule.conditions` (adapter/legacy), discard invalid-active rules.
2. **Candidate generation** (per engine): evaluate each rule's conditions against transaction (V2 `evaluateCondition`; Precedence `evaluateSingleCondition`; Legacy `transactionMatchesRule`) → unmatched candidates discarded (`every(match)`).
3. **Scoring** (SHARED): for each surviving candidate compute `specificity = {highestTier, weightWithinTier}` (`specificity.ts`) and `matchQuality = min+0.25*(avg-min)` (`scoring.ts`).
4. **Comparator** (SHARED `rankCanonical`): tier DESC → weight DESC → quality DESC → priority ASC → `ruleId.localeCompare` ASC (stable total order, reproducible, order-insensitive).
5. **`AMBIGUOUS` resolution** (SHARED `classifyCanonical`): inspect top-2; if differ in keys 1–2 (tier/weight) or priority → winner; else `delta = top.quality − second.quality`; `delta + EPSILON >= 0.10` → winner, else `AMBIGUOUS`. Full tie distinguishable only by `ruleId` → `AMBIGUOUS` (ruleId never fabricates a winner).
6. **Result**: V2 adapter maps decision → `MatchResult` (`matched`/`pending`). Precedence `RuleMatchOutput {winner, candidates, ambiguous, reason}`. Legacy `findMatchingRule` returns `{matchedRuleId, glAccountId}` from the `WINNER`.

---

## 6. Migration strategy (no-regression)

1. **Add the shared module with unit tests first** (pure, no callers changed). This is the contract executable — the parity tests pin it.
2. **Re-point V2** to the shared comparator/classifier. Run existing V2 tests (adapter, decision, wildcard BOLD) → expect green; only behavior change is de-dup fixed keys (no semantic change).
3. **Re-point Precedence** to shared comparator + delete summed map. Existing Precedence + BRE-009/010 harnesses capture any flips; the **R-1 vector** is added as a hard closure.
4. **Re-point Legacy** `evaluateWinningRule` to shared scoring+classify; keep `transactionMatchesRule` for collection. Remove role/db ordering from the decision path. Gate the Legacy behavior change (auto route) behind the existing `BANK_RULE_ENGINE`/`RULE_ENGINE_V2_ENABLED` flag path so production can compare before cutover.
5. Flag-phased: comparator runs everywhere but Legacy winner selection only switches when the engine flag/enabled gate flips. Document the removed `rolePriority`/input-order behavior (a deliberate contract change).
6. Parity harness sweep: `npx vitest run` — BRE-009 `measure-rule-parity`, BRE-010 `measure-real-rule-parity`, BRE-011 wildcard corpus, and the new adversarial parity suite must all be green. `tsc` clean.
7. **DoD**: no NEW lint issues introduced; pre-existing count unchanged.

---

## 7. Technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| Legacy no longer wins on `rolePriority`/input order, a tenant relied on old arrival order | winner change | Flagged cutover; parity+document; real dataset shows 0 real ranking divergence (BRE-010) |
| Precedence summing (R-1 winner `R-A`) flips to V2 tier-first (`R-B`) — changes Precedence winner on R-1 | Precedence behavior change | Adversarial parity matrix pins R-1 closure as required |
| Full semantic tie (2 rules identical except `ruleId`) now resolves `AMBIGUOUS` for old engines that picked a winner | previously deterministic winner now pending | requirement `top-two ambiguous`; documented contract change; parity vector |
| `localeCompare` semantics of `ruleId` (cuid) vary across engines | inconsistent order | one shared comparator uses a single `localeCompare` — identical in all engines (`open` decision confirmed in design) |
| Legacy scoring needs `matchQuality`/`specificity` computed over `GenericRule`-typed conditions | refactor of `evaluateWinningRule` internals | Reuse shared `evaluateCondition` (V2 SSM) for scoring; collection stays boolean-ordered. |
| Threshold (`0.10`) contract change gets reworded in code | contract drift | normative rationale in spec §3 + single constant, versioned |

---

## 8. Validation plan

1. **Unit (shared module)**: comparator total-order stability, `AMBIGUOUS` delta boundary (below vs at-or-above), full semantic tie, single candidate.
2. **Engine parity (adversarial)**: for every vector run V2, Precedence and Legacy over R-1, tier-vs-sum, quality delta, priority, `ruleId`, and reordered inputs. All produce the same `{winner|ambiguous}` `ruleId`.
3. **Atomic regression**: existing unit sets for V2 adapter, Precedence, Legacy updated accordingly; `npx vitest run` keeps BRE-009/010/011 green.
4. **Clean && typecheck**: `npx tsc --noEmit` and lint clean.
5. **Manual**: none required — tests come first (tdd-first parity). 

---

## File map (Create / Modify / No change)

### Create
- `src/lib/rule-engine/canonical-ranking.ts` — the shared comparator + `AMBIGUITY_DELTA_THRESHOLD` + `classifyCanonical`. Source of the entire back-end contract.
- `tests/adversarial-ranking-parity.test.ts` *(new)* — cross-engine parity over R-1 + ties + order-insensitivity.
- `tests/unit/canonical-ranking.test.ts` — unit tests for the comparator/tool.

### Modify
- `src/lib/rule-engine/ranking.ts` — delegate to `rankCanonical` (remove duplicate keys).
- `src/lib/rule-engine/decision.ts` — delegate to `classifyCanonical`; import threshold (single source).
- `src/lib/services/rule-precedence-engine.ts` — delete summed maps/local sort/`computeSpecificityScore`; consume shared `CanonicalCandidate` and shared classify.
- `src/lib/services/rule-matching-engine.ts` — in `evaluateWinningRule`, build `CanonicalCandidate` from matched rules + shared classifier to choose `winner.id`; remove `rolePriority→dbPriority→input` ordering; keep `transactionMatchesRule` collection.
- *(possibly)* `src/lib/services/rule-engine-adapter/index.ts` — only if adapter maps a new `AMBIGUOUS` outcome (already `pending`; likely no change-verify during apply; listed as tentative).

### No change
- `src/lib/rule-engine/specificity.ts`, `scoring.ts` — scoring sources already shared.
- `src/lib/rule-engine/pipeline.ts` — V2 collection-legacy unchanged.
- `src/lib/rule-engine/conditions/**` (+ wildcard `BRE-011`) — normalization unchanged (P2).
- `src/lib/services/rule-engine-adapter/conditions-normalizer.ts` — unchanged.
- `src/lib/services/entity-detector.ts`, entity-* — unchanged.
- `tests/measure-rule-parity.test.ts` / `measure-real-rule-parity.test.ts` — **not modified**; used as green gates (only expectations not changed; the R-1 order test at `:954-960` may need its intent restated in the new adversarial suite but the BRE-009 file itself is untouched).

### Delete
- none. (Old `CONDITION_SPECIFICITY`/`directionSpecificity`/`computeSpecificityScore` code in `rule-precedence-engine.ts` is removed inline, not a file deletion.)

---

## Design decisions (closed — implement, do not re-open)

These are binding for `sdd-apply`:

- **D1 — Legacy MUST reuse the shared scoring pipeline.** Legacy MUST NOT implement its own `matchQuality`/specificity logic. Scoring is the single Source of Truth from `evaluateCondition`/`computeMatchQuality`/`computeSpecificity` (V2 SSOM). `evaluateWinningRule` builds a `CanonicalCandidate` from those shared inputs only. A separate Legacy scoring implementation is **not permitted** — it would create two algorithms that can diverge.
- **D2 — No new flag for BRE-012.** The Legacy cutover MUST reuse an existing feature flag (`BANK_RULE_ENGINE` or `RULE_ENGINE_V2_ENABLED`). A third, comparator-specific flag is **not introduced**. `sdd-tasks`/`sdd-apply` define which existing flag gates the Legacy winner-selection switch and how it is read (no production behavior change until enabled); the choice between the two existing flags is an implementation detail, but the mechanism MUST NOT add a new flag.

## Open technical decisions (→ `sdd-tasks`)

1. **Flag gate for Legacy cutover** *(allows D2)*: which existing flag (`BANK_RULE_ENGINE` vs `RULE_ENGINE_V2_ENABLED`) flips Legacy's winner selection; must NOT change production behavior until enabled. Tasks pick the existing flag read per D2.
2. **`ruleId` lexical order**: confirm `localeCompare` with an `en`-style collator identical in all 3 (they now share the comparator, so single definition).
3. **`AMBIGUOUS` mapping in Legacy output**: Legacy `MatchResult` currently has no `ambiguous`; decide whether to surface `AMBIGUOUS` (return `glAccountId=null`, `matchedRuleId=null` like pending) — tasks decide output shape.