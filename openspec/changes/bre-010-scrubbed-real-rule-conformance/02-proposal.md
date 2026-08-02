# BRE-010: Scrubbed Real-Rule Conformance Measurement — Proposal

- **ID:** BRE-010
- **Status:** Proposal (review gate for `sdd-spec`)
- **Base:** BRE-009 (hermetic measurement protocol — reused, NOT modified)
- **Artifact store:** openspec (file-based). This document is static design. No code, no commits, no DB access, no changes under `src/`, `tests/`, `docs/`, or the BRE-009 protocol.

---

## What this proposes

BRE-010 is a **safe measurement protocol** that runs the three-engine parity harness (Legacy, Precedence, V2) against **real bank rules** and **synthetic transactions**, with a **provable scrubbing mechanism** that guarantees no real identifier ever reaches any output. It reuses the BRE-009 pure-function harness (`compareRuleDecisions`, `classifyDivergence`, `runRuleEngineV2Shadow`, `evaluateRulesPure`) **without modifying the BRE-009 protocol**.

It produces the evidence that lets BRE-011 (wildcard), BRE-012 (ranking), and BRE-013 (error semantics) **open and close** on real rules.

**The single most important design fact:** BRE-010 does **not** assert a pre-designed outcome per vector the way BRE-009 does. Real rules are unknown at design time, so the harness **classifies** every synthetic vector on both axes and **aggregates** the result into rates. Soundness comes from (a) synthetic **control rules** with pre-designed outcomes, (b) the **canary negative-leak gate**, and (c) **accounting invariants** — not from per-vector expectations.

---

## Review path

1. Read **Section 1 (decisions)** — what is decided, what is deferred.
2. Read **Section 2 (architecture)** — where the extractor runs, where the harness runs, why the split is mandatory.
3. Read **Section 3 (anonymization contract)** — the exact real→synthetic mapping and the provenance hash.
4. Read **Section 4 (canary negative-leak test)** — the verifiable scrubbing mechanism.
5. Read **Section 6 (metrics contract)** — what downstream BREs open and close with.
6. Read **Section 7 (fail-closed rules)** and **Section 8 (run validity)** — the hard gates.
7. Decide the **open questions** in Section 11 before `sdd-spec`.

---

## 1. Decision summary

| Topic | Decision |
|---|---|
| Measurement object | Real `BankRule` rows from the dev DB `accountexpress`, **one company per run** (locked decision #2). Single tenant: `companyId` selected explicitly. The contract is per-company; N companies = N independent runs (extensible without changing the BRE-010 contract). |
| Data read | **Only** `BankRule`. `GlAccount`, `EntityContext`, `Company`, `BankTransaction` are never read. |
| Fixture lifecycle | **Fresh every run.** Scrubbed fixture exists only in a temp location (never committed). Extractor is an explicit pre-step. (locked decision #1) |
| Scrubbing point | **DB-read boundary** — the extractor scrubs before anything leaves its process. Only the anonymized fixture reaches the harness. |
| Legacy columns | **In scope.** Both `conditions` JSON (V1/V2) and `conditionType`/`conditionValue` are canonicalized to the same model before measurement. Origin is reported only as anonymized metadata. (locked decision #3) |
| Canary gate | Mandatory **negative-leak test**. Any sentinel in any output ⇒ `runValid=false`, no verdict. (locked decision #1) |
| Engine reuse | BRE-009 pure functions only. No `runShadowComparison` (it logs real ids), no `evaluateRules` (it audits). |
| Reproducibility | Not from a static fixture. From `scrubberVersion` + `fixtureHash` (deterministic hash of the anonymized fixture) + `gitCommit` + documented transformation rules. |
| Expected-outcome model | Controls assert expected codes; **real-rule vectors are classified and aggregated**, never asserted per-vector. |
| Extractor runtime | Existing repo tooling, **no new dependencies**, no `package.json` changes. Exact runner deferred to spec (see Section 11 Q4). |

---

## 2. Architecture

### 2.1 Components and data flow

```
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 0 — Pre-flight (manual / review gate)                            │
│  • Verify extractor is read-only (SELECT-only)                         │
│  • Verify target DB = accountexpress (dev), NODE_ENV != test           │
│  • Verify harness import graph contains no DB-querying module path     │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────────┐
│ PHASE 1 — EXTRACTOR  (outside vitest, NODE_ENV != test, SELECT-only)   │
│                                                                        │
│  1. read-only Prisma client on accountexpress                          │
│  2. bankRule.findMany({ where: { companyId: <tenant> } })              │
│     → count active/inactive (metadata only)                            │
│  3. inject CANARY TRAP rule into the raw set (Section 4.2)             │
│  4. for each rule: canonicalize → validate → scrub (Section 3)         │
│       ✗ any unmappable rule ⇒ FAIL CLOSED, abort run                  │
│  5. generate synthetic transactions + vectors (Section 5, seeded)      │
│  6. stamp provenance: scrubberVersion + fixtureHash + gitCommit        │
│  7. write ONLY the anonymized fixture to os.tmpdir()/bre010-<runId>/    │
│     • NEVER writes raw rules anywhere                                  │
│  8. print the fixture path (consumed via env BRE010_FIXTURE_PATH)      │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ anonymized fixture (JSON, temp only)
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PHASE 2 — HERMETIC HARNESS  (inside vitest, NODE_ENV=test)             │
│  new test: tests/measure-real-rule-parity.test.ts                      │
│                                                                        │
│  1. read fixture from BRE010_FIXTURE_PATH; validate shape;             │
│     assert canary-free (Section 4.3)                                   │
│  2. derive three engine views per rule: Legacy (V1), Precedence, V2    │
│     (pure adapters, Section 3.3)                                       │
│  3. run BRE-009 pure functions per vector; classify both axes          │
│  4. compute controls + metrics + categories (Section 6)                │
│  5. emit ephemeral report: console + temp JSON + vitest                │
│  6. CANARY NEGATIVE-LEAK GATE over all outputs (Section 4)             │
│  7. runValid = controls pass AND no canary leak AND invariants hold    │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Where each component runs, and why the split is mandatory

| Component | Runs | Why |
|---|---|---|
| Extractor | **Outside vitest** (`NODE_ENV != test`) | `src/lib/db.ts:18-30` refuses to create a PrismaClient in `NODE_ENV=test` unless `DATABASE_URL` points to `accountexpress_test`. A vitest run **cannot** read the real rules DB. The extractor is the only component allowed to touch real data, and it emits only the anonymized fixture. |
| Scrubber | Inside the extractor process (or a function it imports) | Scrubbing at the DB-read boundary means **no real value ever exists in a file the test touches** — the strongest hermeticity point (exploration §3, Point A). |
| Hermetic harness | **Inside vitest**, reusing BRE-009 pure functions | The measurement must be a reproducible, hermetic, reviewable run. It imports only pure engine functions; it never imports `@/lib/db` at call-time and executes **zero DB queries**. |

### 2.3 Reused BRE-009 surface (read-only, unmodified)

| Piece | Source | Role |
|---|---|---|
| `transactionMatchesRule`, `evaluateWinningRule` | `src/lib/services/rule-matching-engine.ts` | Legacy engine (pure when called with `contexts=[]`, `entityFirstMode=false`, empty role priorities) |
| `evaluateTransactionAgainstRules` | `src/lib/services/rule-precedence-engine.ts` | Precedence engine |
| `compareRuleDecisions` | `src/lib/services/rule-precedence-shadow.ts:141-172` | Axis A classifier (**not** `runShadowComparison`, which logs real winner ids) |
| `classifyDivergence` | `src/lib/rule-engine/events.ts:30-53` | Axis B classifier |
| `runRuleEngineV2Shadow` | `src/lib/services/rule-engine-adapter/index.ts:107-122` | V2 engine (catches errors, maps to `errorCode`, **no logging**) |
| `evaluateRulesPure` | `src/lib/rule-engine/index.ts:20-74` | V2 pipeline (no audit, no console) |
| `collectStringValues` pattern | `tests/measure-rule-parity.test.ts:731-743` | Recursive string sweep for the canary gate |
| Temp-JSON lifecycle | `tests/measure-rule-parity.test.ts:705-725` | Write during run, read before deletion, delete in `afterAll` |

**Import-graph caveat (verified):** `rule-matching-engine.ts` imports `@/lib/db` at module top. This is identical to BRE-009 (which already imports it) and is safe because (a) `tests/setup.ts` forces `DATABASE_URL=accountexpress_test`, so the `db.ts:18-30` guard passes, and (b) the harness executes **zero queries** — the lazy client is never used. The canary gate covers any incidental stdout.

### 2.4 File footprint (implementation, later — NOT created here)

New files only; nothing existing is modified.

| File | Role |
|---|---|
| `scripts/bre010-extract.mjs` (or `.ts`, see Q4) | Phase 1 extractor + scrubber + fixture stamp (repo convention: existing `scripts/*.mjs`) |
| `scripts/bre010-scrub-policy.mjs` (or embedded) | Scrub transform rules + `scrubberVersion` constant (single source of truth) |
| `tests/measure-real-rule-parity.test.ts` | Phase 2 hermetic harness + canary gate (new file; BRE-009's test is untouched) |
| `docs/specs/BRE-010-scrubbed-real-rule-conformance.md` | The BRE-010 spec (written in `sdd-spec`) |

No changes to `package.json`, `vitest` config, `src/`, or the BRE-009 protocol.

---

## 3. Anonymization contract

### 3.1 Field mapping (real `BankRule` → scrubbed)

| Field (schema) | Class | Scrub rule |
|---|---|---|
| `id` | Identity-bearing | → `scrubbed-rule-<n>` (index, deterministic) |
| `companyId` | Identity-bearing | → `company-scrubbed-1` (single tenant per run) |
| `name` | Identity-bearing | → `rule-<n>` |
| `conditions` (JSON) | Mixed | Types/operators preserved; every string/numeric **value** and **range** replaced (Section 3.2) |
| `conditionType` | Structural | Preserved (operator name only; not sensitive) |
| `conditionValue` | Identity-bearing | Replaced by the same token assigned to the canonical condition value (Section 3.2) |
| `transactionDirection` | Structural | Preserved (`debit`/`credit`/`any`) |
| `glAccountId`, `debitGlAccountId`, `creditGlAccountId` | Identity-bearing | **Dropped** (null) — parity does not use them (BRE-009 passes a synthetic GL) |
| `priority` | Structural | Preserved |
| `isActive` | Structural | Preserved; fixture keeps only `isActive=true` rules (matching all three engines) |
| `entityContextId` | Identity-bearing | **Dropped** — engines run with `entityContexts: []` |
| `isManuallyEdited`, `intent`, `createdAt`, `updatedAt` | Metadata | **Dropped** |

**Structural fields must survive exactly:** condition `type`/`operator`/`field`, condition **count** per rule, `transactionDirection`, `priority`, `isActive`. The measurement is structural — divergence depends on condition types, counts, direction and priority, not on literal text or thresholds.

### 3.2 Scrub transforms (deterministic, applied at the DB-read boundary)

| Value class | Transform |
|---|---|
| String condition value (e.g. description fragment) | → `token-<sha256(value).slice(0,8)>` (deterministic, non-reversible, non-colliding for the run) |
| `*` wildcard value | **Preserved verbatim** — the wildcard marker is structural and needed for BRE-011 |
| Numeric threshold / `range` | **Order-preserving magnitude remap:** sort the run's distinct threshold magnitudes, assign synthetic magnitudes in `[100, 10000]` preserving order **and equality** (equal originals → equal synthetic). Preserves every magnitude comparison the engines make (`Math.abs` semantics). |
| Regex pattern (`description_matches`) | Valid pattern → fixed synthetic valid pattern (from a small safe corpus). **Invalid pattern → canonical `[`** (the BRE-009 X-1 invalid pattern). Invalid-pattern **status** is preserved so BRE-013 can still observe `V2_ERROR`. |
| Date value (`date_before`/`date_after`) | → fixed offset dates relative to the run's `FIXED_DATE` |
| Entity id (`entity_eq`) | → `entity-scrubbed-1` (harness runs with `entityResolution: not_run`, so these never match — a measured fact, same as BRE-009) |
| Rule `id`, `companyId`, `name` | → `scrubbed-rule-<n>`, `company-scrubbed-1`, `rule-<n>` |

### 3.3 Canonical model, origin handling, and the three engine views

**Canonical model = `RuleCondition[]`** (`src/lib/rule-engine/types.ts:19-23`): `{ type, value, range? }`. The scrubber canonicalizes each rule to this model **first**, scrubs values **inside the canonical form**, then derives the three engine views. This guarantees the scrubbed conditions are in exactly the shape the production normalizer produces.

| Rule representation (raw) | Canonicalization |
|---|---|
| `conditions` JSON non-empty, `detectFormat` = `v1` | `normalize()` → `RuleCondition[]` (V1→V2 map, `conditions-normalizer.ts:69-81`) |
| `conditions` JSON non-empty, `detectFormat` = `v2` | pass-through `normalize()` → `RuleCondition[]` |
| `conditions` empty/null, legacy columns populated | build one V1 condition `{field: amount if conditionType ∈ AMOUNT_OPERATORS else description, operator: conditionType, value: conditionValue}` → `normalize()` — mirrors `normalizeRuleForPrecedence` (`rule-precedence-compat.ts:20-37`) |
| `conditions` JSON present **and** legacy columns present | `conditions` wins (all three engines prioritize it: V2 `buildEngineRule`, Precedence `normalizeRuleForPrecedence`, Legacy `transactionMatchesRule`). Both are scrubbed; origin recorded as `both`. |
| `conditions` present but `detectFormat` = `corrupt` | **FAIL CLOSED** (Section 7 #2) |
| Canonical condition whose `type` ∉ `RuleConditionType` or whose `value` is not string/number | **FAIL CLOSED** (Section 7 #1) |

**Reverse map (canonical → Legacy V1 view).** The Legacy engine consumes V1 `{field, operator, value}` (`rule-matching-engine.ts:30-74`). Mapping is deterministic; canonical types with **no** V1 operator (e.g. `description_matches`, `amount_range`, `amount_gte/lte`, `entity_eq`, `date_before/after`) are emitted with their canonical operator and the Legacy engine's `default: return false` makes them non-matching — the exact production behavior (BRE-009 X-1 proves the pattern for `description_matches`). **These are not scrub failures**; only failure to canonicalize aborts.

| Canonical type | Legacy view |
|---|---|
| `description_contains` / `description_starts_with` / `description_ends_with` / `description_eq` | `{field:'description', operator: contains/starts_with/ends_with/equals, value}` |
| `amount_gt` / `amount_gte` | `{field:'amount', operator:'greater_than', value}` (Legacy only has strict `>`) |
| `amount_lt` / `amount_lte` | `{field:'amount', operator:'less_than', value}` (Legacy only has strict `<`) |
| `amount_eq` | `{field:'amount', operator:'equals', value}` |
| `amount_range`, `description_matches`, `entity_eq`, `date_before`, `date_after` | Emit as-is (operator casts to `RuleCondition['operator']`); Legacy returns `false` for them |

Precedence and V2 views consume the canonical `RuleCondition[]` directly (both pass it through `normalize()`), with `id`/`companyId`/GL ids scrubbed.

**Origin metadata (anonymized only):** the fixture and report record, per rule, `representationOrigin: 'json' | 'legacy' | 'both'` — a count of how each rule entered the model. No productive value is ever emitted; origin is technical metadata only.

### 3.4 Provenance hash design (reproducibility without a static fixture)

Reproducibility comes from four recorded values, not from a committed fixture:

| Value | Definition |
|---|---|
| `scrubberVersion` | Constant (e.g. `bre010-scrub-1.0.0`) in the scrub policy. **Bumped only when a transform rule changes.** |
| `fixtureHash` | `fnv1a-<sha256(canonicalJson).slice(0,12)>`, where `canonicalJson` = deterministic JSON (sorted keys) of the **anonymized** fixture: scrubbed rules + generated vectors + control rules. Follows BRE-009's `fixtureVersion` naming. |
| `gitCommit` | `git rev-parse HEAD` at run time (fallback `unknown`, recorded as such). |
| `transformationRules` | Pointer to this document + the scrub policy module. |

**Determinism statement:** given identical raw input and the same `scrubberVersion`, the anonymized output (and therefore `fixtureHash`) is byte-identical. Two runs reproduce the same measurement if they share `scrubberVersion` + `fixtureHash` + `gitCommit` + transform rules. The fixture is regenerated every run, so `fixtureHash` legitimately changes when real data changes — that is expected, not a failure.

---

## 4. Canary negative-leak test (the verifiable scrubbing mechanism)

### 4.1 Sentinel tokens

| Token | Type | Injected into |
|---|---|---|
| `BRE010_CANARY_STR_9f1c2d3e` | String | Trap rule `id`, `companyId`, `name`, `conditionValue`, and one `description_contains` value |
| `424242.42` | Numeric | Trap rule amount threshold (string scan still detects it) |

Both sentinels are **known to exist in the un-scrubbed input** and must be **absent from every output** — the test cannot pass by accident.

### 4.2 Trap rule

The extractor appends a fabricated rule (id `trap-rule`, company `trap-company`) to the raw set **before scrubbing**. It carries canaries in **every identity-bearing field class**, so a leak in any class is caught. It exercises the **same scrub path** as real rules (canonicalize → validate → scrub → engine views), and it participates in the measurement like a normal rule.

### 4.3 Assertion surfaces and mechanism

The gate is a final `it()` after the measurement and the temp-JSON read (before `afterAll` cleanup). Surfaces:

| # | Surface | How asserted |
|---|---|---|
| 1 | Scrubbed fixture | `collectStringValues(fixture)` recursively; neither sentinel present |
| 2 | In-memory report JSON | `collectStringValues(report)`; neither sentinel present |
| 3 | Temp report JSON | read **before** deletion; same sweep |
| 4 | stdout | `vi.spyOn(process.stdout, 'write')`; concatenated output swept |
| 5 | stderr / console | `vi.spyOn(console, 'error'/'warn'/'log')`; swept |
| 6 | Error paths | any error thrown during the run is caught, `String(error)` inspected and asserted sentinel-free before rethrowing |
| 7 | Vitest failure diffs | only `caseId`/category/codes are ever asserted (never real fields), so a diff cannot render a real value |

Mechanism (mirrors exploration §5.4):

```text
combined := fixtureText + reportJsonText + tempJsonText + capturedStdout + capturedStderr + (runError ? String(runError) : '')
expect(combined).not.toContain('BRE010_CANARY_STR_9f1c2d3e')
expect(combined).not.toContain('424242.42')
```

### 4.4 Failure semantics

**Any** `expect(...).not.toContain(sentinel)` violation fails the test ⇒ the whole run is **INVALID** (hard fail, `runValid=false`) and **no parity verdict is emitted**. This mirrors the BRE-009 control-failure semantics. The canary gate is defense-in-depth on top of the Point-A scrub: it proves the scrub was lossless over the identity-bearing fields.

---

## 5. Synthetic transactions and vector synthesis

Real rules are unknown at design time, so vectors are **generated deterministically from the scrubbed rule set** — this is what replaces BRE-009's fixed 12-vector matrix.

- **Seed:** `fixtureHash` — identical anonymized fixtures produce identical vectors.
- **Per-rule probes:** for each active scrubbed rule, generate transactions that exercise each canonical condition:
  - description conditions: description = `"TX synthetique <scrubbed-token>"`, plus non-matching and empty descriptions;
  - amount conditions: magnitudes **below / equal / above** the scrubbed threshold, in both debit and credit direction (exercising the direction pre-filter and the magnitude semantics);
  - regex: a valid-pattern probe and an arbitrary string;
  - wildcard (`*` preserved): any non-empty description.
- **Multi-rule ranking vectors:** deterministically pair rules whose canonical condition families could co-match on the same synthetic description/amount, to expose priority-tie and specificity disagreements.
- **Hermetic scoping:** every vector is evaluated against only the rules it is designed to exercise (BRE-009 hermetic-category rule) — a wildcard rule is never co-fed into a monto vector.
- **Category assignment:** each vector is tagged by the condition families of the rules it exercises (`monto`, `wildcard`, `regex`, `ranking`, `direccion`) plus `control` for injected control vectors.

**Controls:** the harness injects a small set of fully-synthetic control rules (a direction control, a monto control with a known threshold, a ranking control) with **pre-designed expected codes**, run in isolated hermetic scenarios — the BRE-010 analogue of BRE-009's C-pos/C-neg/D/M/R-2 controls.

---

## 6. Metrics contract for downstream BREs

All metrics are **exact** (no sampling). Real-rule vectors are classified and aggregated; nothing is asserted per-vector except controls.

### 6.1 Cross-cutting (both axes)

| Metric | Formula |
|---|---|
| `totalVectors`, `realRuleVectors`, `controlVectors` | counts |
| Axis A (Legacy vs Precedence) | `axisAAgree`, `axisADivergence`, `axisAAgreementRate = axisAAgree / totalVectors` |
| Axis B (V2 vs Precedence) | `axisBAgree`, `axisBDivergence`, `axisBErrorCount`, `axisBAgreementRate = axisBAgree / totalVectors`, `v2ErrorRate = axisBErrorCount / totalVectors` |
| Per-category (6 categories) | `vectors`, `agree`, `diverge`, `error`, per-axis rates |
| Accounting | Axis A `agree + diverge = total`. Axis B `agree + diverge + error = total`. No double counting. `V2_ERROR` counted **only** as error. `V2_PENDING_PRECEDENCE_MATCH` is a dead label and is never used as a signal. |

### 6.2 Per downstream BRE (shape + divergence, with axis)

| BRE | Metrics the protocol MUST produce | Axis | Decision supported |
|---|---|---|---|
| **BRE-011 (wildcard)** | `wildcardRuleCount` (active rules with `description_contains`/legacy-`contains` value `*`), `wildcardPrevalence = wildcardRuleCount / activeRuleCount`, `wildcardVectorCount`, `wildcardAxisADivergenceRate = count(vectors exercising a wildcard rule with axisACode == PRODUCTIVE_MATCH_CANONICAL_NO_MATCH) / wildcardVectorCount` | Legacy-vs-Precedence (the wildcard divergence is axis-A-only, BRE-009 W-1) | Open/close with measured wildcard prevalence + real divergence rate |
| **BRE-012 (ranking)** | `multiConditionRuleCount` (≥2 canonical conditions), `overlappingRuleCount` (rules in the same condition family that can co-match), `priorityBandDistribution`, `rankingVectorCount` (≥2 co-matching rules), `axisBDifferentWinnerCount` + `axisBDifferentWinnerRate`, `axisADifferentWinnerCount` + `axisADifferentWinnerRate`, disagreement breakdown by priority band | **V2-vs-Precedence** (primary, BRE-009 R-1) and Legacy-vs-Precedence (secondary) | Open/close with measured ranking divergence on real rules |
| **BRE-013 (error semantics)** | `regexRuleCount` (`description_matches`), `invalidRegexRuleCount` (pattern fails `new RegExp`, canonical `[`), `axisBErrorCount`, `v2ErrorRate`, `errorCodeDistribution = { conditions_normalization_failed, engine_execution_error }` (from `MatchResult.errorCode`), normalization-failure count | V2-vs-Precedence | Open/close with measured error rates + errorCode distribution on real rules |

### 6.3 Data-quality metrics

`totalRulesRead`, `activeRuleCount`, `inactiveRuleCount`, `conditionTypeDistribution`, `representationOriginCounts` (`json`/`legacy`/`both`), `corruptConditionCount` (must be 0 or the run aborted), `scrubAbortReasons`, `fixtureHash`, `scrubberVersion`, `gitCommit`.

---

## 7. Fail-closed rules (every abort case)

| # | Condition | Evidence to trigger |
|---|---|---|
| 1 | **Unmappable rule** — canonical condition `type` ∉ `RuleConditionType`, or `value` is not string/number, or a V1 `field`/`operator` not in `FIELD_OPERATOR_MAP` (`NormalizationError`) | Scrubber **throws**; the run aborts. A skip is an abort. Never skip silently. |
| 2 | **Corrupt `conditions` JSON** — `detectFormat` = `corrupt` (not array / empty array / mixed V1+V2) | Scrubber throws; run aborted. |
| 3 | **Scrubber version mismatch** — fixture stamp `scrubberVersion` ≠ current policy constant (stale fixture replay) | Run aborts before any measurement. |
| 4 | **Canary leak** — any sentinel in fixture, report, temp JSON, stdout, stderr, or error string | `runValid=false`, hard fail, no verdict. |
| 5 | **Non-read-only extractor evidence** — any write path for raw data, or `findMany` not on `accountexpress` | Code-review gate + extractor `--dry-run` self-check; abort if found. |
| 6 | **In-test DB access** — harness transitively executes any DB query (imports that instantiate/query Prisma) | Review gate; harness calls zero async DB functions. `db.ts:18-30` guard is the backstop. |
| 7 | **Dataset floor** — `activeRuleCount == 0` (nothing to measure) | Run aborts; return to proposal with re-scoped expectations. |
| 8 | **Metrics contract not producible** — engines yield no signal on every vector (structural failure), or the report cannot be built | Run aborts. Coverage gaps for a specific BRE (e.g. zero wildcard rules) are **reported as zero-prevalence evidence**, not an abort — they gate the downstream BRE, not this run. |

---

## 8. Run validity (`runValid`)

`runValid = true` **iff** all of:

1. All control vectors produced their pre-designed axis codes (control-failure semantics identical to BRE-009);
2. The canary negative-leak gate passed (no sentinel in any output);
3. Accounting invariants hold (Section 6.1);
4. All fail-closed conditions were false (Section 7).

If `runValid=false`, the run emits **no parity verdict** and its evidence cannot be used by BRE-011/012/013.

---

## 9. Definition of Done (draft — for `sdd-apply`)

- [ ] `scripts/bre010-extract.mjs` exists, is SELECT-only, and writes **only** the anonymized fixture to `os.tmpdir()/bre010-<runId>/` (never to the repo).
- [ ] `scripts/bre010-scrub-policy.mjs` defines `scrubberVersion` and the transform table (single source of truth).
- [ ] The scrubber's canonical mapping is proven equivalent to the production `normalize()`/`detectFormat` by a dedicated vitest test over representative condition shapes (drift guard).
- [ ] Legacy-column rules (`conditionType`/`conditionValue`) are canonicalized and measured; origin is reported only as anonymized metadata.
- [ ] `tests/measure-real-rule-parity.test.ts` runs the three pure engines on the scrubbed fixture + synthetic transactions, reusing BRE-009 pure functions.
- [ ] **The canary negative-leak test is present and mandatory:** any sentinel in fixture/report/temp JSON/stdout/stderr/error ⇒ `runValid=false` and no verdict.
- [ ] **Zero production identifiers invariant:** the report/stdout/temp JSON contain no real rule id, company id, name, condition value, threshold, GL id, or entity-context id. Verified by the canary gate plus a report-content sweep (report carries only `caseId` + category + condition **types** + codes).
- [ ] `runValid` semantics match Section 8; a control failure or canary leak hard-fails the run.
- [ ] The metrics contract (Section 6) is emitted per run — BRE-011/012/013 can open and close with evidence.
- [ ] Reproducibility metadata recorded: `scrubberVersion` + `fixtureHash` + `gitCommit` + transform-rules pointer.
- [ ] Exactly one company per run; the protocol is per-company and extensible to N companies without changing the contract.
- [ ] Report is ephemeral (console + temp JSON + vitest); temp JSON deleted in `afterAll`; nothing committed under the repo tree.
- [ ] Zero changes to BRE-009 (`tests/measure-rule-parity.test.ts`, `docs/specs/BRE-009-*.md`), `src/`, `package.json`, or vitest config.
- [ ] `npx tsc --noEmit` passes · `npm run lint` has no new errors · existing suite has no regressions.
- [ ] `git status` clean except the new BRE-010 files + this spec.

---

## 10. Design alternatives considered

### Alt A — Two-phase extractor/scrubber + hermetic harness (recommended)

Phase 1 (outside vitest) extracts + scrubs at the DB-read boundary and writes only the anonymized fixture; Phase 2 (vitest) reuses the BRE-009 pure functions and runs the canary gate.

- **Pros:** strongest hermeticity — no real value ever exists in a file the test touches; leak vectors inside engine internals (trace `ruleId`s, `EvaluatedCondition.detail`) are neutralized before any engine sees a rule; fully static, reviewable, no changes to existing files.
- **Cons:** extractor is a manual pre-step; fixture is fresh each run (mitigated by the deterministic-transform provenance hash).
- **Effort:** M.

### Alt B — Raw fixture + in-test materialization scrub (rejected)

Export raw rules to a fixture; the test scrubs when materializing engine inputs.

- **Pros:** no separate extractor.
- **Cons:** the raw dump exists on disk/committed (leak risk by construction); scrub logic lives in the test (harder to prove); any throw before the scrub leaks. Rejected — violates locked decision #1 (fresh, never-committed fixture) and the zero-identifier invariant.

### Alt C — Report-serialization-only scrub (rejected as primary)

Engines run on real rules; only the emitted report is scrubbed.

- **Pros:** simplest to build.
- **Cons:** trace `ruleId`s and `detail` values already flow into memory, console and logs before the report is built (`rule-engine/types.ts:132-141`, `conditions/description.ts`, `conditions/amount.ts`); a throw or vitest diff leaks real data. **Rejected as the scrubbing mechanism**; retained only as the final assertion sweep (the canary gate).

### Why Alt A wins

Scrubbing before any engine sees a rule neutralizes all HIGH-risk leak vectors at once (leak-risk matrix #1–#3), keeps real data out of the test process entirely, and reuses the exact pure functions BRE-009 already validated — with zero changes to existing files.

---

## 11. Open questions / decisions for `sdd-spec`

1. **Extractor runtime:** `.mjs` (repo convention, mirrors `scripts/*.mjs`) with the canonical mapping re-implemented + an equivalence test against the production normalizer — vs a `.ts` extractor run via Node's native type-stripping (requires `file:` imports, no `@/` aliases at runtime). Recommendation: `.mjs` + equivalence test.
2. **Dataset floor value:** Section 7 #7 defines the abort as `activeRuleCount == 0`. Should the floor be higher (e.g. < 5) for statistical informativeness? Recommendation: keep 0 as the hard abort; report counts as-is.
3. **Coverage-gap semantics:** confirm that a zero-prevalence category (e.g. zero wildcard rules) is valid negative evidence that gates the downstream BRE, and does **not** abort the BRE-010 run (a refinement of exploration §6 abort #7).
4. **Which company:** the tenant `companyId` is an explicit CLI argument — confirm there is no product concern with selecting the dev-tenant by name/cuid in `accountexpress`.
5. **Synthetic token corpus for `description_contains` probes:** confirm the seeded synthetic corpus (from `fixtureHash`) needs no manual curation, or whether a small curated corpus should be part of the scrub policy.
6. **Amount remap interval `[100, 10000]`:** confirm the synthetic magnitude range and the equality/order-preservation rule are acceptable to the downstream BRE consumers (the exact magnitudes are structurally irrelevant).
7. **Numeric canary `424242.42` vs the amount remap:** the remap must never produce the numeric canary; confirm the remap's deterministic seed can guarantee that (practically certain, but state it in the spec).

---

## Checklist (reviewer confirmation)

- [ ] Real-rules source is `BankRule` only; `GlAccount`/`EntityContext`/`Company`/`BankTransaction` are never read.
- [ ] Single company per run; extensible to N companies without changing the contract.
- [ ] Both `conditions` JSON and legacy columns are canonicalized to the same model; unmappable ⇒ fail closed.
- [ ] Point A (DB-read boundary) is the scrubbing point; the canary gate is a final assertion sweep, not the scrub mechanism.
- [ ] Canary negative-leak test is a hard gate (any sentinel ⇒ `runValid=false`, no verdict).
- [ ] All eight fail-closed rules are enforceable (esp. fail-closed scrubber, scrubber-version check, no in-test DB access).
- [ ] Metrics contract lets BRE-011/012/013 open and close with evidence (with axis and formula per metric).
- [ ] Reproducibility comes from `scrubberVersion` + `fixtureHash` + `gitCommit` + documented transforms, not a static fixture.
- [ ] Alt A recommended; Alt B and Alt C explicitly rejected as primary; no changes to BRE-009, `src/`, `tests/`, `docs/`, `package.json`.

---

## Next step

If a senior reviewer approves this proposal, run `sdd-spec` for BRE-010. The spec must resolve Section 11's open questions and pin the exact fixture/vector schema, the `runValid` implementation, and the DoD into `docs/specs/BRE-010-scrubbed-real-rule-conformance.md`.
