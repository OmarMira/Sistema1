# BRE-010: Scrubbed Real-Rule Conformance Measurement — Exploration

**Status:** Exploration (review-readiness gate for `sdd-propose`)
**Artifact store:** openspec (file-based)
**Scope of this document:** static analysis only. No code, no commits, no DB access, no changes under `src/`, `tests/`, `docs/`, or the BRE-009 protocol.

---

## Executive summary

- **BRE-010 proposes a safe variant of the BRE-009 parity harness:** run the three engines (Legacy, Precedence, V2) against **real bank rules** with **synthetic transactions**, while provably keeping every real identifier out of every output (report, stdout, temp JSON, error paths).
- **Real rules live in `BankRule`** (`prisma/schema.prisma:245-272`). The dev database is `accountexpress` (per `tests/setup.ts:9` and the BRE-009 spec). The engines themselves are **pure** (`src/lib/rule-engine/**` contains zero `console.*`/`logger.*` calls — verified), which keeps the measurement controllable.
- **Hard architectural fact:** `src/lib/db.ts:18-30` refuses to create a PrismaClient in `NODE_ENV=test` unless `DATABASE_URL` points to `accountexpress_test`. A vitest run **cannot** read the real rules DB. Therefore BRE-010 must extract + scrub **outside vitest** and feed the measurement a **scrubbed fixture**.
- **Primary leak vectors** are inside engine internals, not the report: trace events carry real `ruleId`s (`rule-engine/types.ts:132-141`), and V2/precedence evaluators embed real **condition values** in `EvaluatedCondition.detail` (`conditions/description.ts`, `conditions/amount.ts`). Scrubbing **before any engine sees a rule** neutralizes all of them at once.
- **Recommended architecture (Alt A):** a read-only extractor/scrubber script (runs with `NODE_ENV != test`, SELECT-only) produces a scrubbed fixture; a vitest measurement reuses the BRE-009 pure functions on that fixture; a **negative-leak canary test** makes any leak a hard run failure.
- **Recommendation:** proceed to `sdd-propose` with Alt A, a mandatory negative-leak gate, and an explicit abort condition list (Section 7).

---

## Quick path (review order)

1. Read **Section 3 (field inventory)** — confirms which fields are identity-bearing vs structural.
2. Read **Section 4 (anonymization point)** — the single most important decision.
3. Read **Section 5 (leak-risk matrix)** — the enumerated surface the scrub must cover.
4. Read **Section 6 (negative-leak test)** — the verifiable scrubbing mechanism.
5. Read **Section 7 (abort conditions)** and **Section 8 (metrics contract)** — the hard gates for downstream BREs.
6. Decide the **open questions** in Section 10 before `sdd-propose`.

---

## 1. Data-source inventory

### 1.1 Entities that hold real bank rules

| Entity | Schema ref | Role in the measurement |
|---|---|---|
| `BankRule` | `prisma/schema.prisma:245-272` | **The only required source.** Holds `conditions` (JSON), legacy `conditionType`/`conditionValue`, direction, priority, GL refs. |
| `GlAccount` | `prisma/schema.prisma:111-138` | Referenced by rules via `glAccountId`/`debitGlAccountId`/`creditGlAccountId`. Not needed for parity (BRE-009 passes a synthetic GL); **drop, do not read.** |
| `EntityContext` | `prisma/schema.prisma:373-392` | Referenced via `entityContextId`. Parity engines run with `entityContexts: []` (BRE-009 harness); **drop, do not read.** |
| `Company` | `prisma/schema.prisma:63-97` | Scoping tenant of the rules. Only `companyId` matters and it is scrubbed. |
| `BankTransaction` | `prisma/schema.prisma:185-221` | **Out of scope** — BRE-010 uses synthetic transactions only. `matchedRuleId` on transactions is not read. |

**Data source to read (single):** `BankRule` rows for the target tenant(s) in the dev DB `accountexpress`.

### 1.2 Services / routes that read real rules (read-only reference)

| Reader | Location | Notes for BRE-010 |
|---|---|---|
| `db.bankRule.findMany` (GET list) | `src/app/api/bank-rules/route.ts:38,75` | Paginated; includes `glAccount`, `entityContext`, `_count`. Not reusable inside vitest (DB guard). |
| `db.bankRule.findMany` | `src/app/api/reconciliation/auto/route.ts:48` | Reads active rules ordered by priority; runs Legacy (`transactionMatchesRule` + `evaluateWinningRule`). |
| `db.bankRule.findMany` | `src/app/api/reconciliation/auto-preview/route.ts:36` | Same shape as auto. |
| `db.bankRule.findMany` | `src/lib/services/apply-all-engine.ts:133,367` | Reads rules for apply-all; uses precedence/V2 paths. |
| `db.bankRule.findMany` | `src/lib/services/apply-all-use-case.ts:351` | Active rules for a batch. |
| `db.bankRule.findMany` | `src/lib/services/import.service.ts:484` | Rules used by the import-time shadow (`import.service.ts:88-111`). |
| `db.bankRule.findMany` | `src/lib/services/entity-classifier.ts:109,257` | Rule patterns for entity classification — **out of scope** (entity logic). |
| `db.bankRule.findMany` | `src/app/api/ai-assistant/route.ts:404`, `src/app/api/ai-rules/scan/route.ts:64`, `src/lib/backup.ts:201` | Context only. |

### 1.3 How a rule's conditions/descriptions flow into each engine

- **Legacy** (`transactionMatchesRule`, `src/lib/services/rule-matching-engine.ts:128-181`): consumes either the V2-style `conditions` array (`{field, operator, value}`, type from `@/lib/types/shared`) or the legacy columns `conditionType`/`conditionValue`. `evaluateWinningRule` (`:268-315`) scores by `rolePriority → dbPriority`.
- **Precedence** (`evaluateTransactionAgainstRules`, `src/lib/services/rule-precedence-engine.ts:117-201`): input via `toRulePrecedenceRule` (`rule-precedence-shadow.ts:113-137`), conditions normalized by `normalizeRuleForPrecedence` (`rule-precedence-compat.ts:20-37`) which calls the same V1→V2 normalizer. Ranks by `specificityScore → matchQuality → priority → ruleId` (`:169-175`).
- **V2** (`runRuleEngineV2Shadow`, `src/lib/services/rule-engine-adapter/index.ts:107-122`): builds engine rules via `buildEngineRule` (`:6-24`) + `normalize` (`conditions-normalizer.ts:90-101`), runs the pure pipeline (`evaluateRulesPure`, `rule-engine/index.ts:20-74`). `detectFormat` (`conditions-normalizer.ts:64-67`) distinguishes V1 `{field,operator,value}` from V2 `{type,value,range?}`.

> **Key:** all three engines converge on the same normalized condition shape (`RuleCondition`, `rule-engine/types.ts:19-23`) and operate on `conditions` values. The normalizer is the single choke point the scrubber must mirror: any value it can read into a `detail` string or a trace is a value the scrubber must neutralize.

---

## 2. Field inventory (productive fields entering the measurement)

### 2.1 Per `BankRule`

| Field | Type | Class | Decision for BRE-010 |
|---|---|---|---|
| `id` | cuid | **Identity-bearing** | Replace with synthetic id (e.g. `scrubbed-rule-<n>` or hash). |
| `companyId` | cuid | **Identity-bearing** | Replace with synthetic tenant token. |
| `name` | text | **Identity-bearing** (may embed merchant/company names) | Replace with synthetic name. |
| `conditions` | JSON | **Mixed** — types/operators are structural; `value`/`range` are **identity-bearing** | Keep `field`/`operator`/`type`; replace every string `value` and numeric threshold. |
| `conditionType` | text (legacy V1 op) | structural | Keep (operator name). |
| `conditionValue` | text/number (legacy) | **Identity-bearing** | Replace (string token or synthetic threshold). |
| `transactionDirection` | text (`any/debit/credit`) | structural | Keep. |
| `glAccountId`, `debitGlAccountId`, `creditGlAccountId` | cuid | **Identity-bearing** | Drop/replace — parity does not use them (`BRE-009` passes a synthetic GL). |
| `priority` | int | structural | Keep. |
| `isActive` | bool | structural | Keep (and filter to `isActive=true`, matching engines). |
| `entityContextId` | cuid | **Identity-bearing** | Drop — engines run with `entityContexts: []`. |
| `isManuallyEdited` | bool | metadata | Drop. |
| `intent` | enum | metadata | Drop. |

### 2.2 Joined / ambient fields

| Source | Fields | Decision |
|---|---|---|
| `GlAccount` | `code`, `name` | Not read; never enters the fixture. |
| `EntityContext` | `pattern`, `role` | Not read. |
| `Company` | `legalName`, `taxId`, `email`, … | Only `companyId` is read (for scoping) and it is scrubbed. |
| `BankTransaction` | any | Not read. |

### 2.3 Structural vs identity-bearing summary

- **Structural (must be preserved exactly for the measurement):** condition `type`/`operator`/`field`, condition **count** per rule, `transactionDirection`, `priority`, `isActive`.
- **Identity-bearing (must be scrubbed or dropped):** `id`, `companyId`, `name`, all string condition values, all numeric thresholds, regex patterns, GL ids, entity-context id.

> The measurement is **structural**: divergence between engines depends on condition types, direction, priority and counts — not on the literal description text or thresholds. Scrubbing values therefore does **not** invalidate the parity signal.

---

## 3. Exact anonymization point — tradeoff analysis

Three candidate boundaries. Each later boundary lets more real data flow further down the pipeline.

| Point | What is scrubbed | Hermeticity | Risks | Effort |
|---|---|---|---|---|
| **A. DB-read boundary (extractor script, outside vitest)** | Real rules are scrubbed *before leaving the extractor process*. Only the scrubbed fixture exists on disk. | **Strongest.** No real value ever exists in a file the test touches. | Extractor runs with `NODE_ENV != test`, so it must be a dedicated read-only script with no write path for raw dumps. | M (extractor + scrubber + fixture stamp) |
| **B. Rule-materialization boundary (in-test adapter)** | The test reads a fixture and scrubs when building engine inputs (per-rule adapter). | Medium. Engines only see scrubbed data, but the raw fixture exists on disk/in memory → leak surface if the fixture is raw or a throw dumps inputs. | Raw fixture must exist; committed raw fixture is a data leak by construction. | S-M |
| **C. Report-serialization boundary (scrub only what is emitted)** | Engines run on real rules; only the report strings are scrubbed. | **Weakest.** Trace `ruleId`s, `EvaluatedCondition.detail`, and error `details` carry real values into memory and any console/log output *before* the report is built. | Any throw, `console.*`, `logger.*`, or vitest failure diff leaks before the report scrub runs. Not interceptable everywhere. | S (but unsafe alone) |

**Recommendation: Point A as the primary boundary, with Point C re-implemented as a *final assertion sweep* (the negative-leak test, Section 6) rather than as the scrubbing mechanism.**

Rationale: the pure engines (`rule-engine/index.ts`, `rule-precedence-engine.ts`, `rule-matching-engine.ts`) emit real identifiers in *internal* structures (traces at `rule-engine/types.ts:132-141`; details at `conditions/description.ts:9-57` and `conditions/amount.ts:11-58`). Scrubbing at A means every downstream string is already synthetic, so a report-time sweep is cheap and defense-in-depth.

Scrub transform (deterministic, applied at A):
- `id` → `scrubbed-rule-<index>`; `companyId` → `company-scrubbed-1`.
- `name` → `rule-<index>`.
- Each string condition value → `token-<hash>` (or `*` preserved verbatim — the wildcard marker is structural and needed for BRE-011; see Section 8).
- Each numeric threshold → rounded synthetic magnitude (deterministic).
- Regex pattern values → synthetic regex; **invalid-pattern status is preserved** (if the original pattern fails `new RegExp(...)`, replace with the canonical invalid `[`, as BRE-009 X-1 uses) so BRE-013 can still observe `V2_ERROR`.
- GL/entity ids → dropped.

---

## 4. Leak-risk matrix

| # | Surface | Real identifiers that can appear | Mechanism | Risk | Mitigation |
|---|---|---|---|---|---|
| 1 | `EvaluatedCondition.detail` | condition values, transaction description | evaluators embed values (`conditions/description.ts:9-57`, `conditions/amount.ts:11-58`); surfaces in Precedence `RankedCandidate.evaluatedConditions` (`rule-precedence-engine.ts:159-161`) | **HIGH** | Scrub values at Point A; never serialize `candidates`/`detail` in the report. |
| 2 | V2 trace events | `ruleId`, `rankedRuleIds`, `winnerRuleId` | `rule-engine/types.ts:132-141`; emitted in `pipeline.ts:61,73,75`, `ranking.ts:26`, `decision.ts:97` | **HIGH** | Scrub `id` at Point A; never print traces. |
| 3 | V2 errors | regex pattern, numeric value, condition type | `InvalidRegex`/`InvalidNumericValue` `details` (`errors.ts:49-59`); `evaluateRulesPure` attaches `err.trace` with ruleIds (`rule-engine/index.ts:58-70`) | **HIGH** (only if error is logged) | `runRuleEngineV2Shadow` maps errors to codes without logging (`rule-engine-adapter/index.ts:116-121`). Never log the thrown error; negative-leak test asserts stderr/stdout clean. |
| 4 | `NormalizationError` | field/operator names | `conditions-normalizer.ts:72,77,85` | LOW | Operator names are not sensitive; message contains no values. |
| 5 | Console / stdout | report lines, any `console.*` | `printReport` uses `process.stdout` (`measure-rule-parity.test.ts:745-864`); `logger` outputs via console (`src/lib/logger.ts:24`) | MEDIUM | Use only pure functions (no `runShadowComparison` which logs at `rule-precedence-shadow.ts:183-209`); negative-leak test scans captured stdout. |
| 6 | Vitest output / failure diffs | any value in an `expect` argument | a failed assertion prints the actual value | MEDIUM | Assert only `caseId`/category/codes; never assert on real fields. |
| 7 | Temp JSON | report contents | BRE-009 writes `os.tmpdir()` JSON then deletes (`measure-rule-parity.test.ts:705-725`) | MEDIUM | Reuse lifecycle; negative-leak test reads the temp JSON *before* deletion. |
| 8 | Prisma slow-query logs | SQL (may embed literals) | `db.ts:85-87` → `logger.slowQuery` → console | LOW (only if a real DB query fires) | Measurement performs no DB queries inside vitest (fixture is in-memory); extractor runs outside vitest. |
| 9 | `RuleExecutionAudit` persistence | `winnerRuleId`, trace | `audit.ts:12-27` (via `evaluateRules`, not `evaluateRulesPure`) | N/A | Use `evaluateRulesPure`/`runRuleEngineV2Shadow` (pure, no audit). |
| 10 | Network barrier | — | `tests/setup.ts:23-38` throws on unmocked `fetch` | N/A | Harness makes no network calls. |

**Verified non-risks:** `src/lib/rule-engine/**` has zero `console.*`/`logger.*` calls (grep-confirmed). `compareRuleDecisions` (`rule-precedence-shadow.ts:141-172`) is pure. `runRuleEngineV2Shadow` catches errors without logging.

---

## 5. Negative-leak test design (verifiable scrubbing)

### 5.1 Sentinel tokens (canaries)

- **String canary:** `BRE010_CANARY_STR_9f1c2d3e` — a fixed constant injected into the trap rule's `name`, `conditionValue`, and one `description_contains` condition value *before* scrubbing.
- **Numeric canary:** `424242.42` — injected into one amount-condition threshold *before* scrubbing (string scanning still detects it as a substring).

### 5.2 Mechanism

1. **Trap rule** — the extractor appends a synthetic rule (id `trap-rule`, company `trap-company`) to the real-rule set **before** scrubbing. Its fields carry both canaries. (No real data involved — it is fabricated, but it exercises the *same scrub path* real rules exercise.)
2. **Scrub** the full set (real + trap) through the Point A scrubber.
3. **Assert the fixture:** recursively collect all string values from the scrubbed fixture (`collectStringValues` pattern from `measure-rule-parity.test.ts:731-743`) and assert neither canary is present.
4. **Run the measurement** on the scrubbed fixture (synthetic transactions), building the hermetic report (report fields identical to BRE-009: `caseId` + category + condition types + axis codes — `measure-rule-parity.test.ts:586-616`).
5. **Assert the report:** in-memory report + temp JSON (read before deletion) contain neither canary.
6. **Assert stdout/stderr:** capture `process.stdout.write`/`console` during the run (`vi.spyOn`); concatenate captured output and assert neither canary is present.
7. **Assert error paths:** any error thrown during the run is caught, `String(error)` inspected, and asserted canary-free before rethrowing (or failing).

### 5.3 Failure semantics

- **Any** `expect(...).not.toContain(canary)` violation fails the test → the whole run is **INVALID** and no parity verdict is emitted (mirrors the BRE-009 control-failure semantics: `runValid=false`).
- Because the canaries are **known to exist** in the un-scrubbed input, their absence in all outputs proves the scrub is lossless over the identity-bearing fields — the test cannot "pass by accident".

### 5.4 Assertion mechanism (precise)

```text
combined := fixtureText + reportJsonText + tempJsonText + capturedStdout + capturedStderr + (runError? String(runError) : '')
expect(combined).not.toContain('BRE010_CANARY_STR_9f1c2d3e')
expect(combined).not.toContain('424242.42')
```

Both assertions are in the final `it()` of the measurement, after the temp-JSON read and before `afterAll` cleanup.

---

## 6. Abort conditions (BRE-010 MUST stop and return a revised proposal)

| # | Condition | Evidence needed to trigger |
|---|---|---|
| 1 | **Cannot prove no-leak** — the negative-leak test cannot be executed (e.g., no fixture, canary not injected, stdout capture unavailable) | run aborts before emitting any verdict |
| 2 | **Data source out of scrubbing control** — a `BankRule` row has `conditions` JSON that `detectFormat` classifies as `corrupt` (`conditions-normalizer.ts:53-67`), or contains a condition shape the scrub model cannot map | scrubber must **fail closed** (throw), never skip; a skip is an abort |
| 3 | **Uninterceptable logging layer** — any transitive import of the pure engines emits to stdout/stderr outside vitest capture (native module, worker) | verify via captured-output scan in a dry run; abort if found |
| 4 | **In-test DB access required** — any design that requires reading the real DB inside vitest is architecturally blocked by `db.ts:18-30` | hard constraint; abort the design, not the DB |
| 5 | **Extractor not provably read-only** — the extractor script has any write path to real data, or targets a DB other than `accountexpress` | code review gate |
| 6 | **Dataset too small** — the scrubbed real-rule fixture is empty or below a statistically uninformative floor | return to proposal with re-scoped expectations |
| 7 | **Metrics contract unmet** — the measurement cannot produce the Section 8 metrics (missing condition-type coverage, no wildcard/regex rules present) | return to proposal before opening BRE-011/013 |

---

## 7. Metrics contract for downstream BREs

The measurement MUST emit, per run, the following (reusing the BRE-009 `Metrics`/`CategoryStats` shape — `measure-rule-parity.test.ts:387-422`):

### 7.1 Cross-cutting (both axes, exact, no sampling)

- `legacyPrecedenceTotal/Agree/Divergence` + `legacyPrecedenceAgreementRate` (axis A).
- `v2PrecedenceTotal/Agree/DivergenceCount/ErrorCount` + `v2PrecedenceAgreementRate` + `v2ErrorRate` (axis B).
- Per-category `verdict`, `recallA/recallB`, `falsePositiveAxisA/falsePositiveAxisB` (6 categories: control, direccion, monto, wildcard, ranking, regex).
- Accounting sanity: axis A `agree+divergence=total`; axis B `agree+divergence+error=total`.

### 7.2 Per downstream BRE

| BRE | Metric the protocol must produce | Decision supported |
|---|---|---|
| **BRE-011 (wildcard)** | Count of real rules with a `description_contains`/legacy-`contains` condition whose value is exactly `*`; per-category agreement rate on vectors exercising wildcard rules; count of `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` on axis A for those vectors | Open/close BRE-011 with a measured wildcard prevalence and divergence rate on **real** rules |
| **BRE-012 (ranking)** | Count of real multi-condition/overlapping rules; `DIFFERENT_WINNER` count + rate between V2 and Precedence on real-rule vectors; breakdown by priority band; count of V2-tier vs Precedence-specificity disagreements | Open/close BRE-012 with measured ranking divergence on real rules |
| **BRE-013 (error semantics)** | Count of real rules with `description_matches` conditions; `V2_ERROR` count; `errorCode` distribution (`conditions_normalization_failed` vs `engine_execution_error`); invalid-regex count; normalization-failure count | Open/close BRE-013 with measured error rates on real rules |

### 7.3 Data-quality metrics

Total rules read, active vs inactive, rule count by condition type, by direction, by priority band, corrupt/unknown-conditions count, scrub success/failure counts, fixture version stamp (hash of raw inputs + scrub policy).

---

## 8. Design alternatives

### Alt A — Two-phase extractor/scrubber + hermetic measurement (recommended)

- **Phase 1 (outside vitest):** a dedicated read-only script (`NODE_ENV != test`) opens `accountexpress` with a SELECT-only client, reads active `BankRule` rows, appends the canary trap rule, applies the Point-A scrubber, stamps a fixture version (hash of raw inputs + scrub policy), and writes **only** the scrubbed fixture.
- **Phase 2 (vitest):** measurement test reads the fixture, builds synthetic transactions, runs the three pure engines, computes the Section 7 metrics, emits the hermetic report (console + temp JSON + vitest), and runs the negative-leak gate.
- **Tradeoffs:** strongest hermeticity; the extractor is a manual/scripted pre-step; fixture can go stale (mitigated by the version stamp + re-extract before each measurement run). Does not modify BRE-009 or any `src/`/`tests/`/`docs/` file.
- **Effort:** M — extractor+scrubber ~150-250 lines, measurement test ~200 lines reusing BRE-009 harness patterns, canary gate ~40 lines.

### Alt B — Raw fixture + in-test materialization scrub

- A developer exports raw rules to a fixture (or commits a dump); the test scrubs at the rule-materialization boundary (Point B).
- **Tradeoffs:** no separate script; but the raw dump exists on disk/committed (leak risk by construction), scrub logic lives in the test (harder to prove), and any throw before scrub leaks. 
- **Effort:** S-M, **unsafe unless** the raw dump is gitignored and memory-only.

### Alt C — Report-serialization-only scrub

- Engines see real rules; only the emitted report is scrubbed (Point C).
- **Tradeoffs:** simplest to build, but trace `ruleId`s and `detail` values (`Section 4`, risks #1-3) already leaked into memory/console/logs before the report is built; a throw or vitest failure diff exposes real data. Rejected as primary; retained only as a final assertion sweep.
- **Effort:** S, **unsafe alone.**

### Recommendation

**Alt A**, with the negative-leak canary as a hard `runValid` gate, fixture version stamping, and the Section 6 abort conditions enforced by the extractor's fail-closed scrubber.

---

## 9. Checklist (reviewer confirmation)

- [ ] Real rules source is `BankRule` only; `GlAccount`/`EntityContext`/`Company`/`BankTransaction` are never read.
- [ ] Field inventory (Section 2) classifies every `BankRule` column as structural vs identity-bearing.
- [ ] Point A (DB-read boundary) is the scrubbing point; Point C is only a final assertion sweep.
- [ ] Leak matrix (Section 4) is fully covered: details, traces, errors, stdout, vitest diffs, temp JSON, DB logs.
- [ ] Negative-leak test is a hard gate (any canary → run INVALID).
- [ ] All seven abort conditions are enforceable (esp. fail-closed scrubber and no in-test DB access).
- [ ] Metrics contract (Section 7) lets BRE-011, BRE-012, BRE-013 open and close with evidence.
- [ ] Alt A recommended; Alt C explicitly rejected as primary; no changes to BRE-009 or `src/`/`tests/`/`docs/`.

---

## 10. Open questions (must be decided before `sdd-propose`)

1. **Fixture location:** commit a scrubbed fixture under `tests/fixtures/`/`docs/fixtures/` (reproducible, stale risk) vs generate fresh on each measurement run and gitignore it (always fresh, adds a pre-step)?
2. **Tenant scope:** which company's rules (single tenant, all tenants, or a selected set)? This is a privacy-scope decision.
3. **Extractor runtime:** `.ts` script executed with `tsx`/`ts-node`, or a Prisma/node script? Affects the effort estimate and the `NODE_ENV != test` guarantee.
4. **Entity-context rules:** confirm rules linked to an `EntityContext` are evaluated with `entityContexts: []` (matching BRE-009), i.e., only condition/direction/priority shape matters.
5. **Numeric thresholds:** confirm amount-condition thresholds may be replaced with synthetic magnitudes (measurement is structural) rather than preserved.
6. **Active-only scope:** confirm the fixture includes only `isActive=true` rules (both precedence `rule-precedence-engine.ts:133` and V2 `rule-engine-adapter/index.ts:68` filter on it).
7. **Legacy-column rules:** confirm rules with empty `conditions` JSON but populated `conditionType`/`conditionValue` are in scope (they exist via the API fallback, `bank-rules/route.ts:191-242`).
8. **Hard gate strength:** should the captured-console canary check mark `runValid=false` even if the parity metrics themselves look clean?

---

## Next step

If a senior reviewer approves this exploration, run `sdd-propose` for BRE-010 with **Alt A**, the negative-leak canary gate, the Section 6 abort conditions, and the Section 7 metrics contract as the proposal's acceptance criteria.
