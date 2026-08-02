# BRE-010: Scrubbed Real-Rule Conformance Measurement — Specification

- **ID:** BRE-010
- **Status:** Specification (review gate for `sdd-tasks`)
- **Base:** BRE-009 (hermetic measurement protocol — reused as-is, NOT modified)
- **Layers on top:** BRE-010 builds a measurement layer *on top of* BRE-009; it does not replace, fork, or modify the BRE-009 protocol.
- **Artifact store:** openspec (file-based). This document is static design. No code, no commits, no DB access, no changes under `src/`, `tests/`, `docs/`, `package.json`, or the BRE-009 protocol.

---

## What this spec defines

BRE-010 is the **contract** for a safe measurement protocol that runs the three-engine parity harness
(Legacy, Precedence, V2) against **real `BankRule` rows** with **synthetic transactions**, using a
**provably lossless scrubbing mechanism** so no real identifier ever reaches any output. It reuses the
BRE-009 pure functions (`compareRuleDecisions`, `classifyDivergence`, `runRuleEngineV2Shadow`,
`evaluateRulesPure`, `transactionMatchesRule`/`evaluateWinningRule`,
`evaluateTransactionAgainstRules`) without modifying any of them. Its purpose is to produce the
evidence that lets BRE-011 (wildcard), BRE-012 (ranking), and BRE-013 (error semantics) **open and
close** on real rules.

**The single most important design fact:** BRE-010 does **not** assert a pre-designed outcome per
vector the way BRE-009 does. Real rules are unknown at design time, so the harness **classifies**
every vector on both axes and **aggregates** the result into rates. Soundness comes from (a) synthetic
**control rules** with pre-designed outcomes, (b) the **canary negative-leak gate**, and (c)
**accounting invariants** — never from per-vector expectations on real rules.

---

## Quick path (review order)

1. Read **Section 1 (Scope & non-goals)** — what BRE-010 measures and what it explicitly refuses to do.
2. Read **Section 3 (Anonymization contract)** — the field-by-field real→synthetic mapping; the heart of the safety argument.
3. Read **Section 4 (Canary negative-leak test)** — the mechanism that makes scrubbing *verifiable*, not just asserted.
4. Read **Section 2 (Component contract)** — where each component runs and why the two-phase split is mandatory.
5. Read **Section 6 (Metrics contract)** — what BRE-011/012/013 open and close with.
6. Read **Section 7 (Run lifecycle)** and **Section 8 (Definition of Done)** — the hard gates and the acceptance criteria.
7. Note the **Reviewer-confirmation box** in Section 3.3 (canonicalization priority) and the **Deferred decisions** in Section 9.

---

## 1. Scope & non-goals

### 1.1 What BRE-010 measures

- Engine **conformance** between the three engines (Legacy, Precedence, V2) over the **structural
  shape** of a single company's real active `BankRule` rows, evaluated with synthetic transactions.
- **Wildcard prevalence and divergence** (feed for BRE-011), **ranking divergence** (BRE-012),
  **error semantics** (BRE-013) — all measured on real rule shapes, aggregated and reported as rates.
- **Provenance and reproducibility** of the measurement, so two runs are comparable.

### 1.2 What BRE-010 explicitly does NOT do

| # | Non-goal | Binding statement |
|---|---|---|
| 1 | **No engine changes** | BRE-010 modifies no evaluator, comparator, adapter, normalizer, or ranking logic under `src/`. |
| 2 | **No BRE-009 modification** | `tests/measure-rule-parity.test.ts` and `docs/specs/BRE-009-reproducible-shadow-measurement.md` are **untouched** and must keep passing unchanged. BRE-010 adds a new layer *on top*. |
| 3 | **No new product features** | No routes, no services, no schema, no migrations, no feature flags, no observability/telemetry, no audit persistence. |
| 4 | **No real transactions** | `BankTransaction` is never read. The measurement uses **synthetic transactions only**, generated deterministically. |
| 5 | **No persisted artifacts** | Report is ephemeral (console + temp JSON + vitest output). Temp JSON is deleted; nothing is committed under the repo tree. |
| 6 | **No per-vector assertion on real rules** | Real-rule vectors are classified and aggregated; only synthetic **controls** carry pre-designed expected codes. |
| 7 | **No multi-tenant run** | Exactly **one company per run** (Section 2.2). N companies = N independent runs; the contract is per-company and explicitly extensible to N without changing the contract. |
| 8 | **No changes to `package.json` or vitest config** | The harness runs with existing tooling; the extractor is an explicit pre-step executed manually. |

---

## 2. Component contract

Three components, each with a precise runtime home, read/write surface, and hard guarantees.

### 2.1 Where each component runs — and why the split is mandatory

| Component | Runs | Why |
|---|---|---|
| **Extractor** (Phase 1) | **Outside vitest**, `NODE_ENV != test` | `src/lib/db.ts:18-30` refuses to create a PrismaClient in `NODE_ENV=test` unless `DATABASE_URL` points to `accountexpress_test`. A vitest run **cannot** read the real rules DB. The extractor is the only component allowed to touch real data. |
| **Scrubber** (Phase 1) | Inside the extractor process | Scrubbing at the DB-read boundary (exploration §3 Point A) means **no real value ever exists in a file the test touches** — the strongest hermeticity point. |
| **Hermetic harness** (Phase 2) | **Inside vitest**, `NODE_ENV=test` | The measurement must be a reproducible, hermetic, reviewable run. It executes **zero DB queries** and imports only pure engine functions. |

**Import-graph caveat (verified):** `rule-matching-engine.ts` imports `@/lib/db` at module top — identical to
BRE-009, which already imports it and passes. Safe because (a) `tests/setup.ts` forces
`DATABASE_URL=accountexpress_test`, so the `db.ts:18-30` guard passes, and (b) the harness calls
**zero** DB functions; the lazy client is never used. The canary gate covers any incidental stdout.

### 2.2 Data source and tenant scope

| Item | Contract |
|---|---|
| Source table | **`BankRule` only.** `GlAccount`, `EntityContext`, `Company`, `BankTransaction` are **never read**. |
| Tenant | Exactly **one `companyId` per run**, passed explicitly to the extractor as `--companyId <cuid>`. |
| DB | Dev database `accountexpress` only. Never production. |
| Active filter | Measurement set = `isActive = true` rules only (all three engines filter on it). Inactive count is metadata. |

### 2.3 Reused BRE-009 surface (read-only, unmodified) — the ONLY engine entry points

| Piece | Source | Role in BRE-010 |
|---|---|---|
| `transactionMatchesRule` | `src/lib/services/rule-matching-engine.ts:128-181` | Legacy engine condition evaluation (pure: called with `contexts=[]`, `entityFirstMode=false`). |
| `evaluateWinningRule` | `src/lib/services/rule-matching-engine.ts:268-315` | Legacy winner selection (pure: `rolePriorities={}`, no contexts). |
| `evaluateTransactionAgainstRules` | `src/lib/services/rule-precedence-engine.ts:117-201` | Precedence engine. |
| `compareRuleDecisions` | `src/lib/services/rule-precedence-shadow.ts:141-172` | Axis A classifier. **`runShadowComparison` is FORBIDDEN** (it logs real winner ids). |
| `classifyDivergence` | `src/lib/rule-engine/events.ts:30-53` | Axis B classifier. |
| `runRuleEngineV2Shadow` | `src/lib/services/rule-engine-adapter/index.ts:107-122` | V2 engine (catches errors, maps to `errorCode`, **no logging**). |
| `evaluateRulesPure` | `src/lib/rule-engine/index.ts:20-74` | V2 pipeline (no audit, no console). **`evaluateRules` is FORBIDDEN** (it persists audit). |
| `collectStringValues` pattern | `tests/measure-rule-parity.test.ts:731-743` | Recursive string sweep for the canary gate (re-implemented in the new test file). |
| Temp-JSON lifecycle | `tests/measure-rule-parity.test.ts:705-725` | Write during run, read before deletion, delete in `afterAll`. |

**Forbidden entry points:** `runShadowComparison` (logs real winner ids — leak vector #2) and
`evaluateRules` (persists audit). The harness MUST use only the pure functions above.

### 2.4 Extractor contract

Artifact: `scripts/bre010-extract.mjs` (repo `.mjs` convention; verified `scripts/*.mjs` exist).

| Property | Contract |
|---|---|
| Runtime | `NODE_ENV != test`; executed manually as an explicit pre-step (never auto-run by the harness). |
| Read-only guarantee | **SELECT-only.** The client is constructed read-only; the script's only Prisma calls are `findMany`/`count` on `bankRule`. **No `create`/`update`/`delete`/`updateMany`/`$transaction` write path exists.** Enforced by code review gate + `--dry-run` self-check. |
| CLI | `--companyId <cuid>` (required). Optional `--out <dir>` (default `os.tmpdir()/bre010-<runId>/`). `--dry-run` performs the SELECTs and prints counts, then exits **without writing any fixture**. |
| Reads | `bankRule.findMany({ where: { companyId }, select: {...} })` for the measurement set (active only) plus an inactive count for metadata. |
| Transform | For each raw rule: **canonicalize → validate → scrub** (Section 3). Any unmappable rule ⇒ **throw, abort run**. Never skip silently. |
| Trap rule | Appends the canary trap rule (Section 4.2) to the raw set **before** scrubbing. |
| Vectors | Generates synthetic transactions + vectors deterministically (Section 3.5), embedded in the fixture. |
| Write surface | Writes **only** the anonymized fixture JSON to `--out` (default temp). **NEVER writes raw rules, raw SQL, or any productive value anywhere.** |
| Output | Prints the fixture path to stdout (the path only — the harness consumes it via `BRE010_FIXTURE_PATH`). |
| Abort conditions | Section 7 of this spec (fail-closed rules) — any trigger ⇒ non-zero exit, no fixture, run invalid. |

### 2.5 Scrubber contract

Artifact: `scripts/bre010-scrub-policy.mjs` — the **single source of truth** for:
`SCRUBBER_VERSION`, the transform table, the sentinel constants, the canonicalization rules, and the
Legacy-view construction rules (reverse map for `json`/`both` origin, passthrough for `legacy`
origin — Section 3.4). Imported by the extractor.

| Property | Contract |
|---|---|
| Canonical model | `RuleCondition[]` = `{ type, value, range? }` (`src/lib/rule-engine/types.ts:19-23`). Every rule is canonicalized to this model **first**, scrubbed **inside** the canonical form, then the three engine views are derived. |
| Determinism | Same raw input + same `scrubberVersion` ⇒ byte-identical anonymized output. |
| Fail-closed | Any non-canonizable field aborts the run (throws). A skip is an abort. **Never** skip silently. |
| Version | `SCRUBBER_VERSION` constant bumped **only** when a transform rule changes. |

### 2.6 Hermetic harness contract

Artifact: `tests/measure-real-rule-parity.test.ts` (new file; BRE-009's test is untouched).

| Property | Contract |
|---|---|
| Runtime | `NODE_ENV=test` (vitest). Reads fixture from `BRE010_FIXTURE_PATH`. |
| Entry | If `BRE010_FIXTURE_PATH` is unset/absent/empty ⇒ the run **aborts before any measurement** (no verdict). |
| Validation | Validates fixture shape; re-asserts the fixture is canary-free (Section 4). |
| Engine views | Derives three views per scrubbed rule: Legacy (V1 view — reverse map for `json`/`both` origin, **passthrough of `conditionType`/`conditionValue` for `legacy` origin**, Section 3.4), Precedence (canonical + precedence fields), V2 (`PrismaBankRule` shape — `conditions` passthrough: canonical for `json`/`both`, **`null` for `legacy` origin**, Section 3.4). |
| Execution | Runs the Section 2.3 pure functions per vector; classifies both axes; aggregates metrics (Section 6). |
| Controls | Synthetic control vectors with **pre-designed expected axis codes** are asserted exactly (BRE-009 control semantics). |
| Report | Console + temp JSON + vitest output; temp JSON in `os.tmpdir()/bre010-<runId>/`, **read before deletion**, deleted in `afterAll`. |
| Canary gate | Final `it()` before `afterAll` cleanup (Section 4). |
| `runValid` | Computed per Section 7.3. `false` ⇒ no parity verdict, evidence unusable. |

---

## 3. Anonymization contract

### 3.1 Field mapping (real `BankRule` → scrubbed fixture)

| Field (schema) | Class | Scrub rule |
|---|---|---|
| `id` | Identity-bearing | → `scrubbed-rule-<n>` (deterministic index) |
| `companyId` | Identity-bearing | → `company-scrubbed-1` (single tenant per run) |
| `name` | Identity-bearing | → `rule-<n>` |
| `conditions` (JSON) | Mixed | Types/operators preserved; every string/numeric **value** and `range` replaced (Section 3.2) |
| `conditionType` | Structural | Preserved (operator name only; not sensitive) |
| `conditionValue` | Identity-bearing | Replaced by the token assigned to the canonical condition value (Section 3.2) |
| `transactionDirection` | Structural | Preserved (`any`/`debit`/`credit`) |
| `glAccountId`, `debitGlAccountId`, `creditGlAccountId` | Identity-bearing | **Dropped** — parity passes a synthetic GL (`gl-synthetic-001`, as BRE-009) |
| `priority` | Structural | Preserved |
| `isActive` | Structural | Preserved; fixture keeps only `isActive=true` rules |
| `entityContextId` | Identity-bearing | **Dropped** — engines run with `entityContexts: []` |
| `isManuallyEdited`, `intent`, `createdAt`, `updatedAt` | Metadata | **Dropped** |

> **Structural fields must survive exactly:** condition `type`/`operator`/`field`, condition **count**
> per rule, `transactionDirection`, `priority`, `isActive`. The measurement is structural — divergence
> depends on condition types, counts, direction and priority, not on literal text or thresholds.

### 3.2 Scrub transforms (deterministic, applied at the DB-read boundary)

| Value class | Transform |
|---|---|
| String condition value (e.g. description fragment) | → `token-<sha256(value).slice(0,8)>` (deterministic, non-reversible, non-colliding for the run) |
| `*` wildcard value | **Preserved verbatim** — the wildcard marker is structural and needed for BRE-011 |
| Numeric threshold / `range` endpoint | **Order-preserving magnitude remap:** sort the run's distinct absolute magnitudes; assign synthetic magnitudes in `[100, 10000]` preserving order **and equality** (equal originals → equal synthetic; strictly increasing otherwise). Preserves every magnitude comparison the engines make (`Math.abs` semantics, BRE-006 contract). |
| Regex pattern (`description_matches`) | Valid pattern → fixed synthetic valid pattern from a small safe corpus (defined in the scrub policy). **Invalid pattern → canonical `[`** (the BRE-009 X-1 invalid pattern). Invalid-pattern **status** is preserved so BRE-013 can still observe `V2_ERROR`. |
| Date value (`date_before`/`date_after`) | → fixed offset dates relative to the run's `FIXED_DATE`, order-preserving, deterministic (structural only). |
| Entity id (`entity_eq`) | → `entity-scrubbed-1` (harness runs with `entityResolution: not_run`, so these never match — a measured fact, same as BRE-009). |
| Rule `id`, `companyId`, `name` | → `scrubbed-rule-<n>`, `company-scrubbed-1`, `rule-<n>` |

**Canary-exclusion guarantee (fixed now):** the numeric remap's output space is `[100, 10000]`; the
numeric canary `424242.42` is outside that interval by construction, so the remap can **never** produce
it. The string token form `token-<hex8>` can never equal the string canary `BRE010_CANARY_STR_9f1c2d3e`
(prefix + length + charset differ).

### 3.3 Canonicalization and origin handling

**Canonical model = `RuleCondition[]`.** The scrubber canonicalizes each rule first, scrubs values
inside the canonical form, then derives the three engine views. Canonical conditions are in exactly the
shape the production normalizer produces.

**Canonicalization priority (LOCKED DECISION): conditions-first, legacy fallback** — the scrubber
mirrors production exactly. Production consumes `conditions` when it exists **and has elements**, and
uses the legacy columns only as a fallback: `transactionMatchesRule` evaluates `rule.conditions` when
`Array.isArray(...) && length > 0` and falls back to `conditionType`/`conditionValue` only otherwise
(`rule-matching-engine.ts:163-178`); `normalizeRuleForPrecedence` normalizes `conditions` when present
and builds the legacy V1 condition only otherwise (`rule-precedence-compat.ts:20-37`). The scrubber
uses the same ordering:

| Raw representation | Canonicalization |
|---|---|
| `conditions` is a **non-empty array**, `detectFormat` = `v1` | `normalize()` → `RuleCondition[]` (V1→V2 map, `conditions-normalizer.ts:69-81`) |
| `conditions` is a **non-empty array**, `detectFormat` = `v2` | pass-through `normalize()` → `RuleCondition[]` |
| `conditions` is **not** a non-empty array (null / empty array / non-array JSON), legacy columns **populated** (non-empty `conditionValue`) | build one V1 condition `{ field: amount if conditionType ∈ AMOUNT_OPERATORS else description, operator: conditionType, value: conditionValue }` → `normalize()` (mirrors `normalizeRuleForPrecedence`, `rule-precedence-compat.ts:27-34`). **Legacy view is NOT reverse-mapped: it is a passthrough of the scrubbed `conditionType`/`conditionValue` columns** (Section 3.4), so the Legacy engine applies its own field mapping (`rule-matching-engine.ts:167-178`) exactly as production does. **V2 view is also NOT canonicalized: it preserves `conditions` as stored (null / empty / non-array), so V2 emits its real `V2_ERROR` (`conditions_normalization_failed`)** (Section 3.4) |
| **`conditions` is a non-empty array AND legacy columns populated** | **`conditions` takes canonicalization priority (LOCKED DECISION).** The canonical condition set is built from the `conditions` array — the representation production actually consumes (`rule-matching-engine.ts:163-165`; `rule-precedence-compat.ts:20-25`); the legacy-derived conditions are still canonicalized and validated for scrub coverage. Origin recorded as `both`. This sub-case MUST be asserted by an explicit canonical-model test (Section 8.2). |
| `conditions` is a non-empty array but `detectFormat` = `corrupt` (mixed V1+V2, or elements failing V1/V2 shape detection) | **FAIL CLOSED** (Section 7, #2) |
| `conditions` is **not** a non-empty array AND legacy columns **unpopulated** (empty `conditionValue`) | **FAIL CLOSED** — neither representation can be canonized deterministically (Section 7, #9) |
| Canonical condition whose `type` ∉ `RuleConditionType`, or whose `value` is not string/number | **FAIL CLOSED** (Section 7, #1) |

> **Schema note (verified):** `BankRule.conditionType` and `conditionValue` are **required non-null
> `String`** columns (`prisma/schema.prisma:249-250`), so legacy columns always exist. "Populated"
> means `conditionValue` is a **non-empty** string. Because `conditionValue` is a string, amount
> legacy values are stored as string literals and canonicalized to numbers by `normalize()`. An empty
> `conditions` array (or a `null`/non-array JSON value) is treated as **absent** — "has elements" is
> defined exactly as production's `Array.isArray(...) && length > 0` guards do — and routes to the
> legacy fallback, never to a corrupt abort.

> **Reviewer-confirmation box (resolved — do NOT reopen):** The canonicalization priority is
> **conditions-first with legacy fallback**, mirroring production exactly. Production consumes
> `conditions` first and falls back to legacy columns only when `conditions` has no elements
> (`transactionMatchesRule`, `rule-matching-engine.ts:163-178`; `normalizeRuleForPrecedence`,
> `rule-precedence-compat.ts:20-37`). Therefore a `both`-origin rule is measured in BRE-010 from its
> `conditions` canonicalization — the same representation production uses. An earlier draft recorded a
> legacy-priority "LOCKED DECISION"; that contradicted production and has been corrected to
> conditions-first in the `both` row above, with an explicit canonical-model test case in Section 8.2.

**Origin metadata (anonymized only):** the fixture and report record, per rule,
`representationOrigin: 'json' | 'legacy' | 'both'` — a technical count of how each rule entered the
model. No productive value is ever emitted.

### 3.4 Legacy view construction (reverse map vs passthrough)

The Legacy engine has **two consumption paths**, and BRE-010 must feed the view through the same path
production uses, so the engine's own field-mapping logic decides — never the scrubber.

| Rule origin | Legacy view | How the engine consumes it |
|---|---|---|
| `json` / `both` (canonical came from the `conditions` array) | **Reverse map** — canonical → V1 `{ field, operator, value }`, table below | Via the `conditions` array path (`rule-matching-engine.ts:163-164`), exactly as production does for JSON-backed rules |
| `legacy` (canonical came from the legacy columns) | **Passthrough** — the scrubbed `conditionType` and `conditionValue` columns, uninterpreted | Via the legacy-columns path (`rule-matching-engine.ts:167-178`); the engine maps `field = 'amount'` only when `conditionType ∈ { amount_greater, amount_less }`, everything else to `description` |

**Reverse map (applies to `json`/`both` origin only).** The Legacy engine consumes V1
`{ field, operator, value }` via the `conditions` array path (`rule-matching-engine.ts:163-164`). The
mapping is deterministic:

| Canonical type | Legacy view |
|---|---|
| `description_contains` / `description_starts_with` / `description_ends_with` / `description_eq` | `{ field: 'description', operator: contains/starts_with/ends_with/equals, value }` |
| `amount_gt` / `amount_gte` | `{ field: 'amount', operator: 'greater_than', value }` (Legacy only has strict `>`) |
| `amount_lt` / `amount_lte` | `{ field: 'amount', operator: 'less_than', value }` (Legacy only has strict `<`) |
| `amount_eq` | `{ field: 'amount', operator: 'equals', value }` |
| `amount_range`, `description_matches`, `entity_eq`, `date_before`, `date_after` | Emitted as-is (operator casts to `RuleCondition['operator']`); the Legacy engine's `default: return false` makes them non-matching (`rule-matching-engine.ts:71-72`) — the exact production behavior (BRE-009 X-1 proves the pattern for `description_matches`). |

> **These are NOT scrub failures.** Only failure to canonicalize aborts. A canonical type with no V1
> operator maps to a Legacy view that simply never matches — a measured fact, identical to BRE-009.

**Passthrough (applies to `legacy` origin only).** The scrubber does **not** reverse-map a
legacy-only rule. The scrubbed `conditionType` (structural, preserved) and the scrubbed
`conditionValue` (token / remapped magnitude, per Section 3.2) feed `transactionMatchesRule`
unchanged, so the engine applies its own field decision — the same one production makes
(`rule-matching-engine.ts:167-178`).

> **INTENTIONAL MEASUREMENT SIGNAL — do not normalize away.** Production Legacy maps only
> `amount_greater` / `amount_less` to the `amount` field; every other legacy operator — including
> `greater_than`, `less_than`, `greaterThan`, `lessThan` — is treated by Legacy as a `description`
> condition (`rule-matching-engine.ts:168-172`), which evaluates to a `NaN` magnitude comparison and
> never matches. Production Precedence, by contrast, treats those operators as amount conditions via
> its wider `AMOUNT_OPERATORS` set (`rule-precedence-compat.ts:8-11`). A legacy-only rule with
> `conditionType='greater_than'` is therefore a **real, production divergence** (Legacy `NO_MATCH`
> vs Precedence `amount_gt` match): BRE-010 reports it on Axis A as measured divergence. It is **not**
> a scrub defect and must **not** be collapsed or "fixed" by the reverse map.

**V2 view (observational — mirrors what production feeds V2).** Production's V2 adapter consumes
**only** `rule.conditions`; it **never reads the legacy columns**. `buildEngineRule` calls
`normalize(rule.conditions)` (`rule-engine-adapter/index.ts:6-7`) and the `PrismaBankRule` surface
does not even carry `conditionType`/`conditionValue` (`rule-engine-adapter/types.ts:23-33`). When
`conditions` is `null` / an empty array / a non-array JSON value, `detectFormat` returns `corrupt`
(`conditions-normalizer.ts:64-66`) and `normalize` throws `NormalizationError`
(`conditions-normalizer.ts:101`), which `runRuleEngineV2Shadow` maps to
`V2_ERROR` / `conditions_normalization_failed` (`rule-engine-adapter/index.ts:116-121`).

| Rule origin | V2 view | Production outcome reproduced |
|---|---|---|
| `json` / `both` (canonical came from the `conditions` array) | Canonical `RuleCondition[]` (normalized `conditions`) | Normal evaluation — matches BRE-009's V2 path |
| `legacy` (canonical came from the legacy columns) | **`conditions` as stored** — `null` / empty array / non-array JSON (never the synthesized canonical) | **`V2_ERROR` (`conditions_normalization_failed`)** — the exact production outcome for a rule V2 cannot consume |

> **INTENTIONAL MEASUREMENT SIGNAL — do not "help" V2.** A `legacy`-origin rule is **unconsumable
> by V2 in production**: the adapter has no legacy fallback (`buildEngineRule` reads only
> `conditions`). Feeding V2 the synthesized canonical model would fabricate matches that production
> never produces, inflate Axis-B agreement, and deflate `v2ErrorRate`/`errorCodeDistribution` — the
> exact evidence BRE-013 must measure. The scrubber must preserve `conditions` as stored; V2's
> `V2_ERROR` on legacy-only rules is **the measured datum**, not a defect.

**Precedence view** consumes the canonical `RuleCondition[]` directly (passed through `normalize()`
as V2), with `id`/`companyId` scrubbed and GL ids synthetic. The V2 view is defined by the table
above — per-origin, observational, never the synthesized canonical for `legacy` rules.

### 3.5 Synthetic transactions and vector synthesis

Real rules are unknown at design time, so vectors are **generated deterministically from the scrubbed
rule set** — this replaces BRE-009's fixed 12-vector matrix. Generation is a **Phase 1 (extractor)**
responsibility; vectors are embedded in the fixture.

| Property | Contract |
|---|---|
| Seed | `fixtureHash` — identical anonymized fixtures produce identical vectors. |
| Per-rule probes | For each active scrubbed rule, generate transactions exercising each canonical condition family: description conditions → matching `"TX synthetique <scrubbed-token>"`, non-matching, and empty descriptions; amount conditions → magnitudes **below / equal / above** the scrubbed threshold in both debit and credit signs (exercising the direction pre-filter and magnitude semantics); regex → a valid-pattern probe and an arbitrary string; wildcard (`*` preserved) → any non-empty description. |
| Multi-rule ranking vectors | Deterministically pair rules whose canonical condition families can co-match on the same synthetic description/amount, to expose priority/specificity disagreements. Rule input order for a vector is part of the fixture (BRE-009 `[R-A, R-B]` order is load-bearing for Legacy's stable sort — this order must be recorded per ranking vector). |
| Hermetic scoping | Each vector is evaluated against **only** the rules it is designed to exercise (BRE-009 hermetic-category rule) — a wildcard rule is never co-fed into a monto vector. |
| Category assignment | Each vector is tagged by the condition families of the rules it exercises: `monto`, `wildcard`, `regex`, `ranking`, `direccion`; `control` for injected control vectors. |
| Controls | The extractor injects a small set of fully-synthetic control rules (direction, monto with known threshold, ranking) with **pre-designed expected axis codes**, run in isolated hermetic scenarios — the BRE-010 analogue of BRE-009's C-pos/C-neg/D/M/R-2 controls. Controls live in the fixture with their expected codes. |

### 3.6 Fixture schema (pinned)

```jsonc
{
  "protocol": "BRE-010",
  "scrubberVersion": "bre010-scrub-1.0.0",
  "fixtureHash": "fnv1a-<12 hex chars>",
  "gitCommit": "<sha>",
  "runId": "<uuid>",
  "companyId": "company-scrubbed-1",
  "fixedDate": "2026-07-31T12:00:00.000Z",
  "rules": [
    {
      "id": "scrubbed-rule-1",
      "name": "rule-1",
      "companyId": "company-scrubbed-1",
      "priority": 10,
      "transactionDirection": "any",
      "representationOrigin": "json",
      "ruleKind": "real",
      "conditions": [ { "type": "description_contains", "value": "token-abc12345" } ],
      "legacyView": {
        "kind": "reverseMap",
        "items": [ { "field": "description", "operator": "contains", "value": "token-abc12345" } ]
      },
      "v2View": {
        "kind": "canonical",
        "conditions": [ { "type": "description_contains", "value": "token-abc12345" } ]
      }
    },
    {
      "id": "scrubbed-rule-2",
      "name": "rule-2",
      "companyId": "company-scrubbed-1",
      "priority": 20,
      "transactionDirection": "any",
      "representationOrigin": "legacy",
      "ruleKind": "real",
      "conditions": [ { "type": "amount_gt", "value": 150 } ],
      "legacyView": {
        "kind": "passthrough",
        "conditionType": "amount_greater",
        "conditionValue": "150"
      },
      "v2View": {
        "kind": "stored",
        "conditions": null
      }
    }
  ],
  "vectors": [
    {
      "caseId": "bre010-v-1",
      "category": "monto",
      "ruleIds": ["scrubbed-rule-1"],
      "description": "TX synthetique token-abc12345",
      "amount": -200
    }
  ],
  "controls": [
    { "caseId": "ctrl-pos", "ruleIds": ["..."], "description": "...", "amount": -100,
      "expectedAxisA": "SAME_WINNER", "expectedAxisB": "SAME" }
  ],
  "metadata": {
    "totalRulesRead": 0, "activeRuleCount": 0, "inactiveRuleCount": 0,
    "conditionTypeDistribution": {}, "representationOriginCounts": {},
    "corruptConditionCount": 0, "scrubAbortReasons": [],
    "wildcardRuleCount": 0, "regexRuleCount": 0, "invalidRegexRuleCount": 0,
    "multiConditionRuleCount": 0, "overlappingRuleCount": 0, "priorityBandDistribution": {}
  }
}
```

**`legacyView` discriminant (pinned):** each rule carries exactly one form, matching its origin
(Section 3.4):

| `kind` | Applies to | Shape | Harness consumption |
|---|---|---|---|
| `reverseMap` | origin `json` / `both` | `{ kind: 'reverseMap', items: V1Condition[] }` | feeds `transactionMatchesRule` via the `conditions` array path |
| `passthrough` | origin `legacy` | `{ kind: 'passthrough', conditionType: <scrubbed>, conditionValue: <scrubbed> }` | feeds `transactionMatchesRule` via the legacy-columns path, uninterpreted |

A `passthrough` view must **never** be converted through the reverse-map table; the engine decides
the field (`rule-matching-engine.ts:167-178`). The harness must reject a fixture where the
discriminant contradicts `representationOrigin` (shape-validation, Section 7.3).

**`v2View` discriminant (pinned):** each rule also carries exactly one V2 form, mirroring what
production feeds V2 (Section 3.4):

| `kind` | Applies to | Shape | Harness consumption |
|---|---|---|---|
| `canonical` | origin `json` / `both` | `{ kind: 'canonical', conditions: RuleCondition[] }` | `buildEngineRule` normalizes it — normal evaluation, matches BRE-009 |
| `stored` | origin `legacy` | `{ kind: 'stored', conditions: null }` | fed to V2 as-is; `normalize(null)` → `corrupt` → **`V2_ERROR` (`conditions_normalization_failed`)**, the exact production outcome |

A `stored` view must **never** be replaced by the canonical conditions — that would fabricate matches
production never produces. The harness must reject a fixture where `v2View.kind` contradicts
`representationOrigin` (shape-validation, Section 7.3).

---

## 4. Canary negative-leak test contract

### 4.1 Sentinel tokens

| Token | Type | Injected into |
|---|---|---|
| `BRE010_CANARY_STR_9f1c2d3e` | String | Trap rule `id`, `companyId`, `name`, `conditionValue`, and one `description_contains` value |
| `424242.42` | Numeric | Trap rule amount threshold (string scan still detects it) |

Both sentinels are **known to exist in the un-scrubbed input** and must be **absent from every
output** — the gate cannot pass by accident.

### 4.2 Trap rule

The extractor appends a fabricated rule (raw id `trap-rule`, raw company `trap-company`) to the raw
set **before scrubbing**. It carries canaries in **every identity-bearing field class** (id, company,
name, string condition value, numeric threshold), so a leak in any class is caught. It exercises the
**same scrub path** as real rules (canonicalize → validate → scrub → engine views) and participates in
the measurement like a normal rule.

### 4.3 Assertion surfaces and mechanism

The gate is a final `it()` after the measurement and the temp-JSON read (before `afterAll` cleanup).

| # | Surface | How asserted |
|---|---|---|
| 1 | Scrubbed fixture | `collectStringValues(fixture)` recursively; neither sentinel present |
| 2 | In-memory report JSON | `collectStringValues(report)`; neither sentinel present |
| 3 | Temp report JSON | read **before** deletion; same sweep |
| 4 | stdout | `vi.spyOn(process.stdout, 'write')`; concatenated output swept |
| 5 | stderr / console | `vi.spyOn(console, 'error'/'warn'/'log')`; swept |
| 6 | Error paths | any error thrown during the run is caught, `String(error)` inspected and asserted sentinel-free before rethrowing/failing |
| 7 | Vitest failure diffs | only `caseId`/category/codes are ever asserted (never real fields), so a diff cannot render a real value |

Mechanism (mirrors exploration §5.4):

```text
combined := fixtureText + reportJsonText + tempJsonText + capturedStdout + capturedStderr
            + (runError ? String(runError) : '')
expect(combined).not.toContain('BRE010_CANARY_STR_9f1c2d3e')
expect(combined).not.toContain('424242.42')
```

### 4.4 Failure semantics

**Any** `expect(...).not.toContain(sentinel)` violation fails the test ⇒ the whole run is **INVALID**
(`runValid=false`) and **no parity verdict is emitted**. This mirrors BRE-009 control-failure
semantics. The canary gate is **defense-in-depth on top of the Point-A scrub** — it proves the scrub
was lossless over the identity-bearing fields. Because the canaries are known to exist in the
un-scrubbed input, their absence in all outputs is the verifiable proof.

---

## 5. Provenance & reproducibility contract

Reproducibility comes from four recorded values, **not** from a committed fixture:

| Value | Definition |
|---|---|
| `scrubberVersion` | Constant (e.g. `bre010-scrub-1.0.0`) in the scrub policy. **Bumped only when a transform rule changes.** |
| `fixtureHash` | `fnv1a-<sha256(canonicalJson).slice(0,12)>`, where `canonicalJson` = deterministic JSON (sorted keys) of the **anonymized** fixture: scrubbed rules + generated vectors + control rules + metadata. Follows BRE-009's `fnv1a-` prefix convention. |
| `gitCommit` | `git rev-parse HEAD` at extract time (fallback `unknown`, recorded as such). |
| `transformationRules` | Pointer to this document + the scrub policy module. |

**Determinism statement:** given identical raw input and the same `scrubberVersion`, the anonymized
output (and therefore `fixtureHash`) is byte-identical. Two runs reproduce the same measurement if
they share `scrubberVersion` + `fixtureHash` + `gitCommit` + transform rules. The fixture is
regenerated every run, so `fixtureHash` legitimately changes when real data changes — that is
**expected, not a failure**.

**Comparable runs** (what makes two measurements comparable): same `scrubberVersion` + same
`fixtureHash` + same `gitCommit` ⇒ identical fixture ⇒ identical vectors ⇒ identical measurement.
Different `fixtureHash` means the underlying real data or vector generation changed; the runs are
reported side-by-side, never merged.

---

## 6. Metrics contract for downstream BREs

All metrics are **exact** (no sampling). Real-rule vectors are classified and aggregated; nothing is
asserted per-vector except controls.

### 6.1 Cross-cutting (both axes)

| Metric | Formula |
|---|---|
| `totalVectors`, `realRuleVectors`, `controlVectors` | counts |
| Axis A (Legacy vs Precedence) | `axisAAgree` (`SAME_WINNER` + `BOTH_NO_MATCH`), `axisADivergence` (`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` + `PRODUCTIVE_NO_MATCH_CANONICAL_MATCH` + `DIFFERENT_WINNER` + `CANONICAL_AMBIGUOUS`), `axisAAgreementRate = axisAAgree / axisATotal` |
| Axis B (V2 vs Precedence) | `axisBAgree` (`SAME`), `axisBDivergence` (`DIFFERENT_WINNER` + `V2_MATCH_PRECEDENCE_NO_MATCH` + `V2_NO_MATCH_PRECEDENCE_MATCH`), `axisBErrorCount` (`V2_ERROR`), `axisBAgreementRate = axisBAgree / axisBTotal`, `v2ErrorRate = axisBErrorCount / axisBTotal` |
| Per-category (6) | `category`, `vectors`, `agreeA`, `divergeA`, `agreeB`, `divergeB`, `errorB`, per-axis rates |
| Precedence error rate | `0` by design (Precedence fails silent, never errors); reported as a measured fact, not a signal. |

**Accounting invariants (MANDATORY, asserted):**

- Axis A: `axisAAgree + axisADivergence = axisATotal`. No double counting.
- Axis B: `axisBAgree + axisBDivergence + axisBErrorCount = axisBTotal`. No double counting.
- `V2_ERROR` counted **only** as error — never as divergence, never as agreement.
- `V2_PENDING_PRECEDENCE_MATCH` is a **dead label** (`events.ts:17`, no branch produces it) and is
  **never used as a signal**.

### 6.2 Per downstream BRE (shape + divergence, with axis)

| BRE | Metrics the protocol MUST produce | Axis | Decision supported |
|---|---|---|---|
| **BRE-011 (wildcard)** | `wildcardRuleCount` (active rules with `description_contains`/legacy-`contains` value `*`), `wildcardPrevalence = wildcardRuleCount / activeRuleCount`, `wildcardVectorCount`, `wildcardAxisADivergenceRate = count(vectors exercising a wildcard rule with axisACode == PRODUCTIVE_MATCH_CANONICAL_NO_MATCH) / wildcardVectorCount` | Legacy-vs-Precedence (the wildcard divergence is axis-A-only, BRE-009 W-1) | Open/close with measured wildcard prevalence + real divergence rate |
| **BRE-012 (ranking)** | `multiConditionRuleCount` (≥2 canonical conditions), `overlappingRuleCount` (rules in the same condition family that can co-match), `priorityBandDistribution`, `rankingVectorCount` (≥2 co-matching rules), `axisBDifferentWinnerCount` + `axisBDifferentWinnerRate`, `axisADifferentWinnerCount` + `axisADifferentWinnerRate`, disagreement breakdown by priority band | V2-vs-Precedence (primary, BRE-009 R-1) and Legacy-vs-Precedence (secondary) | Open/close with measured ranking divergence on real rules |
| **BRE-013 (error semantics)** | `regexRuleCount` (`description_matches`), `invalidRegexRuleCount` (pattern fails `new RegExp`, canonical `[`), `axisBErrorCount`, `v2ErrorRate`, `errorCodeDistribution = { conditions_normalization_failed, engine_execution_error }` (from `MatchResult.errorCode`), normalization-failure count, `legacyOnlyV2ErrorCount` | V2-vs-Precedence | Open/close with measured error rates + errorCode distribution on real rules |

> **Legacy-only rules feed BRE-013, not BRE-011/012:** every `legacy`-origin rule produces a real
> `V2_ERROR` (`conditions_normalization_failed`) on its vectors — the measured datum that V2 cannot
> consume legacy rules. This contributes to `axisBErrorCount`, `v2ErrorRate`, and
> `errorCodeDistribution`, and is broken out as `legacyOnlyV2ErrorCount` so BRE-013 can distinguish
> "V2 cannot normalize legacy rules" from "V2 fails on regex/other conditions".

### 6.3 Data-quality metrics

`totalRulesRead`, `activeRuleCount`, `inactiveRuleCount`, `conditionTypeDistribution`,
`representationOriginCounts` (`json`/`legacy`/`both`), `corruptConditionCount` (**must be 0** or the
run aborted), `scrubAbortReasons`, `fixtureHash`, `scrubberVersion`, `gitCommit`.

---

## 7. Run lifecycle

### 7.1 Phases

```
PHASE 0 — Pre-flight (manual / review gate)
  • verify extractor is read-only (SELECT-only) — code review + `--dry-run`
  • verify target DB = accountexpress (dev), NODE_ENV != test
  • verify harness import graph contains no DB-querying module path at call-time

PHASE 1 — EXTRACTOR (outside vitest, NODE_ENV != test, SELECT-only)
  1. read-only client on accountexpress
  2. select active BankRule rows for --companyId (+ inactive count for metadata)
  3. append CANARY TRAP rule to the raw set (before scrubbing)
  4. per rule: canonicalize → validate → scrub → derive engine views (Section 3)
       ✗ any unmappable rule ⇒ FAIL CLOSED, abort run (no fixture)
  5. generate synthetic transactions + vectors + controls (Section 3.5, seeded)
  6. stamp provenance (Section 5)
  7. write ONLY the anonymized fixture to --out (default os.tmpdir()/bre010-<runId>/)
  8. print the fixture path → harness consumes via env BRE010_FIXTURE_PATH

PHASE 2 — HERMETIC HARNESS (inside vitest, NODE_ENV=test)
  1. read fixture from BRE010_FIXTURE_PATH; validate shape; assert canary-free
  2. derive three engine views per rule (Legacy / Precedence / V2)
  3. run BRE-009 pure functions per vector; classify both axes
  4. compute controls + metrics + categories (Section 6)
  5. emit ephemeral report: console + temp JSON + vitest
  6. CANARY NEGATIVE-LEAK GATE over all outputs (Section 4)
  7. runValid = controls pass AND no canary leak AND invariants hold (7.3)
```

### 7.2 Success / failure semantics

| Outcome | Meaning |
|---|---|
| `runValid=true` | Controls passed, canary gate clean, accounting invariants hold, no abort condition fired. Parity verdict + metrics are the run's evidence. |
| `runValid=false` | Any control failure, canary leak, invariant violation, or abort condition. **No parity verdict is emitted; evidence unusable by BRE-011/012/013.** |

### 7.3 `runValid` — true iff ALL of

1. All control vectors produced their pre-designed axis codes (BRE-009 control-failure semantics);
2. The canary negative-leak gate passed (no sentinel in any output);
3. Accounting invariants hold (Section 6.1);
4. All fail-closed conditions were false (Section 7.4).

### 7.4 Fail-closed rules (every abort case)

| # | Condition | Evidence to trigger |
|---|---|---|
| 1 | **Unmappable rule** — canonical condition `type` ∉ `RuleConditionType`, or `value` is not string/number, or a V1 `field`/`operator` not in `FIELD_OPERATOR_MAP` (`NormalizationError`) | Scrubber **throws**; run aborts. A skip is an abort. Never skip silently. |
| 2 | **Corrupt `conditions` JSON** — `conditions` is a non-empty array whose `detectFormat` = `corrupt` (mixed V1+V2, or elements failing V1/V2 shape detection) | Scrubber throws; run aborted. |
| 3 | **Scrubber version mismatch** — fixture stamp `scrubberVersion` ≠ current policy constant (stale fixture replay) | Run aborts before any measurement. |
| 4 | **Canary leak** — any sentinel in fixture, report, temp JSON, stdout, stderr, or error string | `runValid=false`, hard fail, no verdict. |
| 5 | **Non-read-only extractor evidence** — any write path for raw data, or reads outside `accountexpress` | Code-review gate + extractor `--dry-run` self-check; abort if found. |
| 6 | **In-test DB access** — harness transitively executes any DB query | Review gate; harness calls zero async DB functions. `db.ts:18-30` guard is the backstop. |
| 7 | **Dataset floor** — `activeRuleCount == 0` (nothing to measure) | Run aborts; return to proposal with re-scoped expectations. |
| 8 | **Metrics contract not producible** — engines yield no signal on every vector, or the report cannot be built | Run aborts. Coverage gaps for a specific BRE (e.g. zero wildcard rules) are **reported as zero-prevalence evidence, not an abort** — they gate the downstream BRE, not this run. |
| 9 | **No canonizable representation** — `conditions` has no elements (null / empty array / non-array JSON) AND legacy columns are unpopulated (empty `conditionValue`), so neither representation can be canonized deterministically (Section 3.3) | Scrubber throws; run aborted. |

### 7.5 Temp cleanup

Temp JSON (and the whole `os.tmpdir()/bre010-<runId>/` dir) is deleted in `afterAll`
(best-effort, idempotent). The fixture directory created by the extractor is reported for manual
cleanup; nothing under the repo tree is ever written.

---

## 8. Definition of Done

### 8.1 Mandatory invariants (verbatim intent — non-negotiable)

1. **The extractor executes ONLY `SELECT` operations.**
2. **NO productive data may reach persistent memory, stdout, stderr, traces, or temp JSON.**
3. **The canary test must fail on ANY leak, even partial.**
4. **The scrubber must be fail-closed: any non-canonizable field aborts the run.**
5. **The BRE-009 harness remains with NO functional modifications; BRE-010 builds a layer ON TOP, it
   does not replace the existing protocol.**

### 8.2 Acceptance criteria for the future implementation phase

- [ ] `scripts/bre010-extract.mjs` exists, is SELECT-only, and writes **only** the anonymized fixture to a temp location (never to the repo).
- [ ] `scripts/bre010-scrub-policy.mjs` defines `SCRUBBER_VERSION` and the transform table (single source of truth), including the sentinel constants.
- [ ] The scrubber's canonical mapping is proven equivalent to the production `normalize()`/`detectFormat` by a dedicated vitest test over representative condition shapes (drift guard).
- [ ] Legacy-column rules (`conditionType`/`conditionValue`) are canonicalized and measured; origin is reported only as anonymized metadata (`json`/`legacy`/`both`).
- [ ] **Legacy-only passthrough is implemented and asserted:** a `legacy`-origin rule's Legacy view is a `passthrough` of the scrubbed `conditionType`/`conditionValue` columns — never reverse-mapped (Section 3.4); the fixture `legacyView` discriminant matches `representationOrigin` and the harness rejects contradictions.
- [ ] **The field-mapping divergence is a measured signal, not normalized:** a `legacy`-origin rule with `conditionType='greater_than'` (or `less_than`/`greaterThan`/`lessThan`) is reported as Legacy `NO_MATCH` vs Precedence `amount_gt` match (Axis A divergence) — exactly production behavior — and is **not** collapsed by the reverse map. Asserted by a dedicated vitest case.
- [ ] **V2 observational view is implemented and asserted:** a `legacy`-origin rule's V2 view is `stored` (`conditions: null`) and produces the real `V2_ERROR` (`conditions_normalization_failed`) — the exact production outcome (`buildEngineRule` reads only `conditions`) — and is **never** replaced by the canonical conditions. The fixture `v2View.kind` matches `representationOrigin`; the harness rejects contradictions and asserts `legacyOnlyV2ErrorCount` (Section 6.2). Asserted by a dedicated vitest case.
- [ ] **Both-representation sub-case is asserted:** a rule carrying both `conditions` AND populated legacy columns canonicalizes from `conditions` (Section 3.3 `both` row); the scrubber's vitest suite includes an explicit canonical-model test case proving the `conditions`-derived model is chosen over the legacy columns (and `representationOrigin` = `both`).
- [ ] **Conditions-first canonicalization is implemented and asserted:** the scrubber builds the canonical model from `conditions` when it exists and has elements, using legacy columns only as fallback (Section 3.3); the reviewer box is closed (resolved decision, no longer pending review).
- [ ] `tests/measure-real-rule-parity.test.ts` runs the three pure engines on the scrubbed fixture + synthetic transactions, reusing only the Section 2.3 pure functions (never `runShadowComparison`, never `evaluateRules`).
- [ ] **The canary negative-leak test is present and mandatory:** any sentinel in fixture/report/temp JSON/stdout/stderr/error ⇒ `runValid=false` and no verdict.
- [ ] **Zero production identifiers invariant:** the report/stdout/temp JSON contain no real rule id, company id, name, condition value, threshold, GL id, or entity-context id. Verified by the canary gate plus a report-content sweep (report carries only `caseId` + category + condition **types** + codes).
- [ ] `runValid` semantics match Section 7.3; a control failure or canary leak hard-fails the run.
- [ ] The metrics contract (Section 6) is emitted per run — BRE-011/012/013 can open and close with evidence.
- [ ] Reproducibility metadata recorded: `scrubberVersion` + `fixtureHash` + `gitCommit` + transform-rules pointer.
- [ ] Exactly one company per run; the protocol is per-company and extensible to N companies without changing the contract.
- [ ] Report is ephemeral (console + temp JSON + vitest); temp JSON deleted in `afterAll`; nothing committed under the repo tree.
- [ ] Zero changes to BRE-009 (`tests/measure-rule-parity.test.ts`, `docs/specs/BRE-009-*.md`), `src/`, `package.json`, or vitest config.
- [ ] `npx tsc --noEmit` passes · `npm run lint` has no new errors · existing suite (including BRE-009) has no regressions.
- [ ] `git status` clean except the new BRE-010 files + this spec.

---

## 9. Deferred decisions (resolved during `sdd-tasks`/`sdd-apply`)

The proposal's open questions are resolved here as **constraint (fixed now)** or **deferred
(resolved later)**:

| # | Proposal question | Resolution |
|---|---|---|
| Q1 | Extractor runtime | **Constraint:** `.mjs` (repo convention, verified `scripts/*.mjs`), with a drift-guard equivalence test. The `.mjs` scrubber re-implements the canonical mapping; the vitest equivalence test proves it matches production `normalize()`/`detectFormat` over representative shapes. Exact module-loading mechanism (Node loader vs no alias) is implementation detail. |
| Q2 | Dataset floor value | **Constraint:** hard abort at `activeRuleCount == 0` (Section 7.4 #7). Counts are reported as-is; no higher statistical floor. |
| Q3 | Coverage-gap semantics | **Constraint:** a zero-prevalence category (e.g. zero wildcard rules) is **valid negative evidence** that gates the downstream BRE, and does **not** abort the BRE-010 run. |
| Q4 | Which company | **Constraint:** the tenant `companyId` is an explicit CLI argument (`--companyId`). The specific dev tenant chosen for a given run is an **operational decision made at run time**, not a contract decision. |
| Q5 | Synthetic token corpus | **Constraint:** the probe corpus is derived deterministically from `fixtureHash`; **no manual curation** is required. |
| Q6 | Amount remap interval | **Constraint:** remap output space `[100, 10000]`, order- and equality-preserving, deterministic (Section 3.2). |
| Q7 | Numeric canary vs amount remap | **Constraint:** the remap output space `[100, 10000]` excludes `424242.42` by construction; the string token form can never equal the string canary (Section 3.2). |
| — | JSON-vs-legacy priority when both present | **Constraint (LOCKED):** `conditions` takes canonicalization priority with legacy fallback, mirroring production (`rule-matching-engine.ts:163-178`, `rule-precedence-compat.ts:20-37`); legacy-derived conditions are still validated for scrub coverage; origin `both` (Section 3.3). |
| — | Engine views are observational, never reconstructed | **Constraint (LOCKED):** each engine view presents exactly what production feeds that engine — Legacy `legacy`-origin = passthrough columns (engine decides field), V2 `legacy`-origin = stored `conditions` (⇒ real `V2_ERROR`), Precedence = canonical (Section 3.4). No view is "helped" with the synthesized canonical; production divergences are measured signals. |

**Deferred to `sdd-tasks`/`sdd-apply` time (explicitly NOT decided by this spec):**

1. Exact vector count and the precise per-condition probe matrix (the generation algorithm shape is
   fixed in Section 3.5; the concrete enumeration is implementation).
2. The exact safe regex corpus for valid-pattern replacement (guarantee fixed in Section 3.2; corpus
   content lives in the scrub policy).
3. The exact synthetic date offsets for `date_before`/`date_after` (order-preserving guarantee fixed;
   concrete offsets are implementation).
4. The exact `--out` default and runId format for the fixture directory (temp-only guarantee fixed).
5. The precise set and count of control rules/vectors (controls MUST cover direction, monto, ranking,
   positive and negative; the concrete set is implementation).
6. How the extractor reads config/env (dotenv, existing repo tooling) — the `NODE_ENV != test` and
   SELECT-only guarantees are fixed; mechanism is implementation.

---

## Next step

If a senior reviewer approves this spec (the Section 3.3 canonicalization priority is resolved and
locked as conditions-first), run `sdd-tasks` for BRE-010. The task breakdown must map 1:1 to Sections
3 (anonymization), 4 (canary gate), 5 (provenance), 6 (metrics), 7 (lifecycle/fail-closed), and
8 (Definition of Done).
