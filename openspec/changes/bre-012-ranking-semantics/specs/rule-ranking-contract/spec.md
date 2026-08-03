# Delta for rule-ranking-contract

Delta for BRE-012 (`bre-012-ranking-semantics`). Adds the cross-engine canonical ranking contract that Legacy, Precedence and V2 MUST all implement for the matching candidate set. It terminates `DIFFERENT_WINNER` from pure ranking and removes order-of-arrival/DB-row-order as a ranking signal.

Provenance: `bre-012-ranking-semantics` `01-explore.md` §6/§7/§11 (measurement), `02-proposal.md` §2 (canonical algorithm, normative), §4 P1–P5 and §5 (closed decisions). Existing `rule-engine-integration` requirements are unchanged.

## ADDED Requirements

### Requirement: Canonical comparator is shared by all engines

Legacy, Precedence and V2 MUST rank their matching candidate set with the SAME deterministic canonical comparator, in this order, so the winner is the same regardless of which engine evaluates:

1. **Specificity — tier-first** (`specificityScore.highestTier`, DESC): a candidate whose highest matched condition tier is strictly greater MUST beat any candidate whose tiers are all lower, regardless of count.
2. **Specificity — sum-second within the tied tier** (`specificityScore.weightWithinTier`, DESC): when two candidates share the same highest tier, the summed weight of the conditions matched in that tier decides.
3. **Match quality** (DESC) `min + 0.25*(avg−min)` — the shared `computeMatchQuality` formula.
4. **Manual priority** (ASC, lower wins).
5. **`ruleId` ASC** — deterministic, shared, total final sort key.

The comparator MUST list candidates in a complete stable total order, so the ranked list is reproducible for identical inputs independent of DB row order, `findMany` defaults, or load/build order. (Provenance: proposal §2, §4.1/4.2; V2 `ranking.ts:8-20`, `specificity.ts:24-33`; Precedence `rule-precedence-engine.ts:170-175`.)

**Direction is a pre-filter, NOT a ranking key.** `transactionDirection` is evaluated as a binary match filter when the candidate set is built: a rule whose declared direction does not match the transaction's direction is excluded from the candidate set entirely. Once a candidate is in the set, direction contributes NOTHING to any canonical key — it is absent from specificity (tier/weight), match quality, priority, and `ruleId` ordering. Therefore two rules that match the same transaction and differ ONLY by their declared direction are a full semantic tie and classify `AMBIGUOUS` (they never differ on a canonical key). This removes the previous Precedence-only `directionSpecificity` (+20) summed bonus; that behavior is intentionally deleted, not migrated. (Provenance: proposal §2; V2 pipeline direction filter; Precedence `rule-precedence-engine.ts` legacy `directionSpecificity` removed under BRE-012.)

#### Scenario: R-1 closure — one more specific tier beats many lower-tier conditions
- GIVEN V2 evaluators match `R-B` (`description_starts_with`, tier 2) and `R-A` (two `description_contains`, tier 1) on the same transaction, and `R-A` has higher summed weight
- WHEN each engine ranks the candidate set with the canonical comparator
- THEN all three engines pick `R-B` (tier 2 > tier 1) and NO engine emits `DIFFERENT_WINNER`
- AND the measured V2-vs-Precedence `DIFFERENT_WINNER` from `02-proposal.md` §1 is gone

#### Scenario: Sum decides only within an equal tier
- **GIVEN** two candidates with the same highest matched tier, one matching two weighted conditions and one matching one, and no priority difference
- **WHEN** the canonical comparator orders them
- **THEN** the candidate with the larger summed weight within that tier ranks first, and a candidate from a strictly lower tier can never overtake it by its own weight

#### Scenario: direction is a filter, not a ranking signal
- **GIVEN** two rules that both match a debit transaction, one declaring `transactionDirection: 'debit'` and the other `transactionDirection: 'any'`, identical in every condition, quality and priority
- **WHEN** each engine builds the candidate set and ranks it with the canonical comparator
- **THEN** both rules are candidates (the `'any'` rule passes the direction filter), they tie on every canonical key, and each engine emits `AMBIGUOUS` — the declared direction never breaks the tie
- AND no engine applies a direction-based specificity bonus (the deleted Precedence `directionSpecificity` is not restored)

### Requirement: no order-of-entry or DB-row-order signal

No engine MUST read physical DB row order, `findMany` default ordering, or candidate build/input order as a ranking key. The only final discriminator is `ruleId ASC`. Legacy's stable-sort-on-input-order tiebreak is removed and REPLACED by `ruleId ASC`. (Provenance: proposal §2.5, P2.)

#### Scenario: Reproducible winner independent of rule array order
- **GIVEN** the same matching rule set presented to an engine in a different array order (same rule `id`s)
- **WHEN** each engine runs the canonical comparator and selects the winner
- **THEN** all engines select the identical `ruleId` and the difference in input order never changes the winner

#### Scenario: Fully deterministic tie
- **GIVEN** two candidates sharing the same tier, same weight, same quality, same priority
- **WHEN** the canonical comparator orders them and no ambiguity is declared
- **THEN** the candidate with the lexicographically smaller `ruleId` is selected as the winner, deterministically and reproducibly

### Requirement: unified AMBIGUOUS criterion

All three engines MUST decide `AMBIGUOUS` from the SAME canonical computation. Ambiguity is decided as follows, in order:

1. If the top-two candidates differ in specificity tier OR summed weight (keys 1–2) OR priority (key 4) — a winner is selected, not ambiguous.
2. Else the canonical **delta** on match quality is their difference (`top.matchQuality − second.matchQuality`).
3. If the delta is **strictly below** the shared threshold → emit `AMBIGUOUS` (no winner). If `delta + EPSILON >= threshold` → the top candidate wins.

The shared threshold is `AMBIGUITY_DELTA_THRESHOLD`. Its **default is `0.10`**, justified by evidence: both canonical engines already ship exactly `0.10` as a production cap with agreed parity tests green (BRE-009 `measure-rule-parity` 26/26, BRE-010 `measure-real-rule-parity` 17/17; Precedence `rule-precedence-engine.ts:183`, V2 `decision.ts:4`/`:31`). It MUST be referenced through one shared constant and be **parameterizable without changing the comparator**; it MUST NOT be re-hard-coded separately in each engine.

The comparison form is **delta**, fixed by the proposal; the threshold value is its only spec-level latitude, resolved here to default `0.10` with evidence.

**Normative rationale:** `0.10` is adopted because it is the existing convergent value implemented by both canonical engines and validated by the parity harnesses (BRE-009 `measure-rule-parity` 26/26, BRE-010 `measure-real-rule-parity` 17/17). The comparator contract is independent of the numeric value; the value itself is contract-level, not an implementation constant. Any future change to the threshold (e.g. `0.08` or `0.15`) is a contract change requiring a versioned specification update and parity re-validation — it is never an implementation-only constant tweak.

The same input MUST produce the same `AMBIGUOUS` decision in all three engines.

#### Scenario: Ambiguous when the exactly equal match quality falls below threshold
- **GIVEN** two candidates equal on tier, weight and priority, whose top-two match-quality delta is `0.04` (below `0.10`)
- **WHEN** each engine classifies the top two
- **THEN** each engine emits `AMBIGUOUS` (no winner) and no engine emits a `DIFFERENT_WINNER`

#### Scenario: Delta at-or-above threshold decides a winner
- **GIVEN** two candidates equal on tier, weight, and priority, whose match-quality delta is `0.15` (at-or-above `0.10`)
- **WHEN** each engine classifies the top two
- **THEN** each engine selects the candidate with the higher quality as `WINNER` and none emits `AMBIGUOUS`

#### Scenario: Structural difference never reaches ambiguity
- **GIVEN** two candidates that differ only in specificity tier, weight, or priority (keys 1–2 or 4)
- **WHEN** each engine classifies the top two
- **THEN** the top candidate is the `WINNER`; the ambiguity computation is not reached

### Requirement: top-two ambiguous satisfies partial ordering of SEMANTIC keys

When the top-two candidates tie on **all semantic keys (specificity tier, specificity weight, match quality, priority) and are distinguishable only by `ruleId`**, they are treated as semantically indistinguishable. The canonical comparator emits `AMBIGUOUS`; `ruleId` is NOT used to create a business winner that the ordering would otherwise call a dead tie. `ruleId` serves as the deterministic total-order sort key needed to make the candidate list reproducible, and as the WINNER mechanism ONLY in cases that fall back to it deterministically; it never fabricates a business winner on a full semantic tie. (Provenance: proposal §2/§4.5, P2/P5; user open point 3.)

#### Scenario: Identical rules under canonical keys emit AMBIGUOUS, not an arbitrary winner
- **GIVEN** two matching rules identical in tier, weight, quality, and priority, differing only by `ruleId`
- **WHEN** each engine classifies them
- **THEN** each engine emits `AMBIGUOUS`; the smaller `ruleId` is NOT auto-selected as the winner

#### Scenario: single top semantic tier still yields a deterministic winner
- **GIVEN** a candidate set whose top two differ in specificity or priority, OR a single candidate
- **WHEN** each engine classifies
- **THEN** a `WINNER` is selected deterministically (by the canonical comparator, `ruleId` as final key when needed)

### Requirement: Legacy adopts the canonical comparator (role/frequency stays out of the canonical path)

Legacy's `evaluateWinningRule` and the auto route must select their winner with the canonical comparator (keys described in the shared canonical comparator requirement) instead of `rolePriority → dbPriority → stable input order`. `role/frequency`, `entityRoles`, and legacy response priority are documented as legacy-only, non-canonical, and MUST NOT be consumed as a canonical ranking key — they do not flow through `RuleInput`/`BankRule`. Land the change behind the existing rule-engine gate/deployment flags; the comparator is applied before `winner.id` is read downstream, and no tenant depends on `rolePriority` order that the parity gates cover. (Provenance: proposal P2/P3, §4.4/§4.6, §5, §10; BRE-010 real dataset shows 0 real ranking divergence.)

#### Scenario: Legacy selects by canonical keys instead of input order
- **GIVEN** Legacy evaluates a matching set where two rules differ by canonical keys
- **WHEN** Legacy selects its winner on the canonical comparator
- **THEN** the winner is the candidate that the canonical comparator places first, independent of the original stable input order, and `rolePriority` does not decide the winner

#### Scenario: role/frequency is not consumed on the canonical path
- **GIVEN** any engine (Legacy, Precedence, V2) running the canonical comparator
- **WHEN** it ranks the matching candidate set
- **THEN** `rolePriority`/role-frequency is NOT read as a ranking key; any value is ignored on the canonical path

### Requirement: adversarial parity tests close R-1 and are mandatory

BRE-012 MUST add adversarial ranking-parity tests that exercise all three engines over a vector matrix that includes the R-1 case (tier conflict) as a hard closure, ties (quality-delta ambiguity boundary), and order-insensitivity (same set reordered). These tests MUST be green as part of the change's DoD, and MUST remain green while `tsc` stays clean. (Provenance: P5, proposal §8.)

#### Scenario: R-1 parity closure is a hard test target
- **GIVEN** a parity vector that reproduces the R-1 case (V2 `starts_with` tier-2 vs two `contains` tier-1)
- **WHEN** the adversarial parity suite runs
- **THEN** all three engines agree on the same winner; `v2PrecedenceAgreementRate` reaches 12/12 (100%) and `DIFFERENT_WINNER` for `R-1` is absent

#### Scenario: No-regression on BRE-009/010/011 gates
- **GIVEN** the existing harnesses `tests/measure-rule-parity.test.ts` (BRE-009), `tests/measure-real-rule-parity.test.ts` (BRE-010), and the archived BRE-011 wildcard corpus
- **WHEN** the canonical comparator change is applied and the suite is run
- **THEN** those harnesses remain green (or their expectations are updated only where the ordering change is documented as intentional), and `tsc` passes

---

## Open decisions

The following remain OPEN and are carried to `sdd-design` (they are integration choices, not contract re-openings):

1. **Where the shared comparator lives** — a single shared ranking module imported by all three engines (recommended) vs. three wrappers that delegate to one internal implementation.
2. **`ruleId` ASC vs localeCompare semantics across engines** — Precedence already uses `localeCompare` (`rule-precedence-engine.ts:174`); `ruleId` values are `cuid`-like ids; confirm a single lexical rule is defined identically everywhere.
3. **Gate/flag plan** — which flag (`RULE_ENGINE_V2_ENABLED`/`BANK_RULE_ENGINE`) and whether the Legacy path lands behind the same gate or its own; correlates with the no-regression gate in `design`.
4. **Config surface for the `0.10` threshold** — whether it remains a constant (default) per package or is exposed via `config;` design decides the injection point; the default value `0.10` is fixed by this spec.