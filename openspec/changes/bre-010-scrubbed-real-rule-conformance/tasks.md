# Tasks: BRE-010 — Scrubbed Real-Rule Conformance Measurement

- **ID:** BRE-010
- **Base:** BRE-009 (reused as-is, NOT modified)
- **Spec:** `openspec/changes/bre-010-scrubbed-real-rule-conformance/03-spec.md` (authoritative)
- **Guiding principle (LOCKED):** engine views are **observational, never reconstructed**. Each
  engine receives exactly what production feeds it; the protocol measures differences, it does not
  correct them. `legacy`-origin → Legacy view = passthrough columns (engine decides field); V2 view =
  stored `conditions` (⇒ real `V2_ERROR`); Precedence view = canonical. Do NOT introduce tasks that
  "convert legacy rules to canonical before V2", "reuse the reverse map for all engines", or
  "normalize engine inputs" beyond what the spec pins.

---

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1000-1400 |
| 400-line budget risk | High |
| Chained PRs recommended | No (single hermetic feature; no shared intermediate state) |
| Suggested split | 3 work units, single PR with `size:exception`, or 3 stacked PRs |
| Delivery strategy | ask-on-risk (default) |
| Chain strategy | stacked-to-main (if chained) |

Decision needed before apply: yes (400-line risk High → apply `ask-on-risk` gate).

### Suggested Work Units

| Unit | Goal | Artifacts | Notes |
|------|------|-----------|-------|
| 1 | Scrub policy + drift-guard equivalence test | `scripts/bre010-scrub-policy.mjs`, `tests/scrub-policy-drift-guard.test.ts` | Pure module; TDD-friendly. Locks canonicalization, transforms, engine-view construction. |
| 2 | Extractor (Phase 1, SELECT-only, fail-closed) | `scripts/bre010-extract.mjs` | Runs outside vitest (`NODE_ENV != test`). Reads only `BankRule`; writes only the anonymized fixture to temp. |
| 3 | Hermetic harness (Phase 2) + canary gate + report | `tests/measure-real-rule-parity.test.ts` | Reuses Section 2.3 pure functions only. Temp-JSON lifecycle + canary gate + `runValid`. |

DoD gates (tsc/lint/full suite) run across all units and are checked after Unit 3.

---

## Work Unit 1 — Scrub policy module + drift-guard test

**Spec refs:** §2.5, §3.1, §3.2, §3.3, §3.4, §5, §7.4 (#1, #2, #9), §8.2.

### 1.1 Define `scripts/bre010-scrub-policy.mjs`

- [ ] `SCRUBBER_VERSION` constant (value `bre010-scrub-1.0.0`) — the single source of truth; no other
      copy of the version string exists anywhere.
- [ ] Sentinel constants: `BRE010_CANARY_STR_9f1c2d3e` and `424242.42`.
- [ ] Field-classification table and scrub transforms per §3.1/§3.2:
      strings → `token-<sha256(value).slice(0,8)>`; `*` wildcard preserved verbatim; numeric
      thresholds/range endpoints → order- and equality-preserving magnitude remap into `[100, 10000]`
      (remap output can NEVER equal `424242.42`); regex → safe-corpus valid pattern OR canonical `[`
      (invalid-pattern status preserved); dates → fixed offsets from `FIXED_DATE`; rule
      `id`/`companyId`/`name` → `scrubbed-rule-<n>`/`company-scrubbed-1`/`rule-<n>`.
- [ ] Canonicalization rules per §3.3: conditions-first with legacy fallback (exact production
      ordering); `detectFormat` semantics; `both` origin → conditions win; corrupt → throw;
      no-representation → throw.
- [ ] Engine-view construction per §3.4 — **observational**:
      - `legacyView` for `json`/`both` → `{ kind: 'reverseMap', items: V1Condition[] }` via the §3.4
        reverse-map table ONLY.
      - `legacyView` for `legacy` → `{ kind: 'passthrough', conditionType, conditionValue }`
        (scrubbed), **never** reverse-mapped.
      - `v2View` for `json`/`both` → `{ kind: 'canonical', conditions: RuleCondition[] }`.
      - `v2View` for `legacy` → `{ kind: 'stored', conditions: null }` — **never** the synthesized
        canonical. Do NOT "help" V2 consume legacy rules.
- [ ] Representation-origin classification: `json` | `legacy` | `both` per §3.3, exposed for
      metadata.

### 1.2 Drift-guard equivalence test

- [ ] `tests/scrub-policy-drift-guard.test.ts` proves the scrub policy's canonical mapping is
      equivalent to production `normalize()`/`detectFormat` (`conditions-normalizer.ts`) over
      representative condition shapes: V1 JSON, V2 JSON, legacy-only, both, empty-array, null,
      non-array, corrupt (mixed V1+V2), amount operators incl. `greater_than`/`less_than`/
      `greaterThan`/`lessThan` legacy columns.
- [ ] Test asserts the **observational** engine views:
      - legacy-only `conditionType='greater_than'` → `legacyView.kind = passthrough` (field NOT
        decided by the scrubber) and `v2View.kind = stored` with `conditions: null`.
      - JSON-origin rule → `legacyView.kind = reverseMap` and `v2View.kind = canonical`.
- [ ] Test asserts `SCRUBBER_VERSION` constant and the `[100, 10000]` remap canary-exclusion
      (`424242.42` never producible).

**Unit 1 gate:** `npx vitest run tests/scrub-policy-drift-guard.test.ts` green; `npx tsc --noEmit`
clean.

---

## Work Unit 2 — Extractor (Phase 1, SELECT-only, fail-closed)

**Spec refs:** §2.1, §2.2, §2.4, §3.5, §3.6, §5, §7.1 (PHASE 1), §7.4.

### 2.1 Read-only guarantee

- [ ] `scripts/bre010-extract.mjs` runs with `NODE_ENV != test`; constructs the Prisma client
      read-only (SELECT-only). The script's only Prisma calls are `bankRule.findMany`/`bankRule.count`
      on `accountexpress` (dev). No `create`/`update`/`delete`/`updateMany`/`$transaction` write path
      exists anywhere in the script.
- [ ] `--dry-run` mode: performs the SELECTs, prints counts, exits WITHOUT writing any fixture.
- [ ] CLI: `--companyId <cuid>` (required), `--out <dir>` (default
      `os.tmpdir()/bre010-<runId>/`).

### 2.2 Data selection (tenant-scoped, active only)

- [ ] `bankRule.findMany({ where: { companyId }, select: {...} })` for the measurement set
      (`isActive = true` only) plus an inactive count for metadata.
- [ ] Exactly one `companyId` per run; `GlAccount`/`EntityContext`/`Company`/`BankTransaction` are
      never read.

### 2.3 Per-rule pipeline (fail-closed)

- [ ] Append the CANARY TRAP rule (Section 4.2) to the raw set BEFORE scrubbing.
- [ ] Per rule: `canonicalize → validate → scrub → derive engine views` using the scrub policy.
- [ ] Any unmappable/non-canonizable rule ⇒ throw; run aborts with non-zero exit and NO fixture
      written. Never skip silently (§7.4 #1, #2, #9).

### 2.4 Synthetic vectors + controls

- [ ] Generate synthetic transactions + vectors deterministically seeded from `fixtureHash` (§3.5):
      per-condition probes (description match/non-match/empty; amount below/equal/above with both
      debit and credit signs; regex valid/arbitrary; wildcard non-empty), multi-rule ranking vectors
      with recorded input order, hermetic scoping, category tags, and injected control rules with
      pre-designed expected axis codes.
- [ ] Vectors/controls embedded in the fixture with the §3.6 schema.

### 2.5 Fixture write + provenance

- [ ] Stamp provenance (§5): `scrubberVersion`, `fixtureHash`
      (`fnv1a-<sha256(canonicalJson).slice(0,12)>` of deterministic sorted-key JSON), `gitCommit`
      (`git rev-parse HEAD`, fallback `unknown`), `fixedDate`, `runId`.
- [ ] Write ONLY the anonymized fixture (including `legacyView` + `v2View` discriminants and
      `representationOrigin` per rule) to `--out` (default temp). NEVER write raw rules/raw SQL/
      productive values anywhere.
- [ ] Print the fixture path to stdout (path only) for `BRE010_FIXTURE_PATH`.

**Unit 2 gate:** `node scripts/bre010-extract.mjs --dry-run --companyId <cuid>` (NODE_ENV != test)
runs read-only and exits 0; code-review confirms zero write paths.

---

## Work Unit 3 — Hermetic harness (Phase 2) + canary gate

**Spec refs:** §2.3, §2.6, §3.6, §4, §5, §6, §7.1 (PHASE 2), §7.2, §7.3, §7.5, §8.

### 3.1 Entry + validation

- [ ] `tests/measure-real-rule-parity.test.ts` reads the fixture from `BRE010_FIXTURE_PATH`; if
      unset/absent/empty ⇒ abort before any measurement (no verdict).
- [ ] Validates fixture shape; rejects discriminant/origin contradictions:
      `legacyView.kind`/`v2View.kind` must match `representationOrigin` (§3.6); a `passthrough` view
      must never be reverse-mapped; a `stored` view must never be replaced by canonical conditions.
- [ ] Re-asserts the fixture is canary-free before measurement.

### 3.2 Measurement (reuses ONLY Section 2.3 pure functions)

- [ ] Derives the three engine views per rule from the fixture and runs the BRE-009 pure functions:
      `transactionMatchesRule`/`evaluateWinningRule` (Legacy — fed the `legacyView` path per origin),
      `evaluateTransactionAgainstRules` (Precedence — canonical), `compareRuleDecisions` (Axis A —
      NOT `runShadowComparison`), `classifyDivergence` (Axis B), `runRuleEngineV2Shadow` (V2 — fed
      `v2View` per origin, so `legacy`-origin rules emit real `V2_ERROR`).
- [ ] Never uses `runShadowComparison` (logs real ids) nor `evaluateRules` (persists audit).
- [ ] Synthetic transactions/vectors from the fixture; controls asserted exactly with pre-designed
      expected axis codes (BRE-009 control semantics).

### 3.3 Metrics + invariants

- [ ] Emits the §6 metrics: cross-cutting (Axis A/B rates), per-category (6), and per-BRE metrics
      incl. `wildcardRuleCount`/`wildcardPrevalence`, `rankingVectorCount`/`axisB*`/`axisA*` rates,
      and `regexRuleCount`/`invalidRegexRuleCount`/`errorCodeDistribution`/`legacyOnlyV2ErrorCount`
      (§6.2 BRE-013).
- [ ] Asserts accounting invariants (§6.1): Axis A `agree + diverge = total`; Axis B
      `agree + diverge + error = total`; `V2_ERROR` counted ONLY as error; `V2_PENDING_PRECEDENCE_MATCH`
      never a signal.
- [ ] Data-quality metadata (§6.3): `representationOriginCounts`, `corruptConditionCount` (0 or
      abort), `scrubAbortReasons`, provenance stamps.

### 3.4 Report + temp lifecycle + canary gate

- [ ] Ephemeral report: console + temp JSON + vitest output; temp JSON in
      `os.tmpdir()/bre010-<runId>/`, read before deletion, deleted in `afterAll` (§2.3, §7.5).
- [ ] Canary negative-leak gate as final `it()` before cleanup (§4): `collectStringValues` sweep over
      fixture, in-memory report, temp JSON (read before delete), captured stdout (`vi.spyOn` on
      `process.stdout.write`), captured stderr/console (`console.error/warn/log`), and any caught
      error string — neither `BRE010_CANARY_STR_9f1c2d3e` nor `424242.42` may appear.
- [ ] `runValid` computed per §7.3: controls pass AND canary gate clean AND invariants hold AND no
      fail-closed trigger. `false` ⇒ no parity verdict, evidence unusable.

**Unit 3 gate:** `BRE010_FIXTURE_PATH=<tmp fixture from Unit 2> npx vitest run
tests/measure-real-rule-parity.test.ts` green; report shows `runValid=true` with control vectors
passing.

---

## Work Unit 4 — DoD verification (no code changes)

**Spec refs:** §8.2.

- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run lint` has no new errors.
- [ ] Existing suite (including BRE-009 `tests/measure-rule-parity.test.ts`) has NO regressions —
      BRE-009 untouched.
- [ ] Zero changes under `src/`, `package.json`, vitest config, or BRE-009
      (`tests/measure-rule-parity.test.ts`, `docs/specs/BRE-009-*.md`).
- [ ] `git status` clean except the new BRE-010 files + `tasks.md` + this spec.

---

## Non-goals (do NOT do)

- Do NOT modify any production engine, adapter, normalizer, or ranking code.
- Do NOT modify BRE-009 or its docs.
- Do NOT add routes/services/schema/migrations/feature flags/telemetry/audit persistence.
- Do NOT read `BankTransaction`, `GlAccount`, `EntityContext`, or `Company`.
- Do NOT touch more than one company per run.
- Do NOT commit any fixture, report, or raw data under the repo tree.
- Do NOT make V2 consume legacy rules by synthesizing canonical conditions (locked decision).
- Do NOT make the Legacy view's field decision in the scrubber (locked decision — the engine decides).

---

## Next step

After DoD verification passes, run `sdd-verify` for BRE-010, then `sdd-archive`.
