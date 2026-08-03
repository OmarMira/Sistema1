# Change Candidate Index — Verification Report (2026-08)

Verification evidence behind [`change-candidate-index.md`](change-candidate-index.md). This report is **archival**: it records how and when each candidate was verified. It does not prioritize, recommend, or open any change.

## 1. Verification metadata

| Field | Value |
|---|---|
| **Date** | 2026-08-03 |
| **Verified base** | `origin/main` at `257c194` — commit `docs(roadmap): add SDD change candidate index` |
| **Scope** | Candidates A–E of the original index + candidates F–I added from objective repository evidence |
| **Method** | Physical verification of paths, imports, line references, and test runs against the local checkout of `origin/main` |
| **Status at audit time** | The index update was **working-tree-only** (no commit, no push). `origin/main` still published the original A–E version. |

## 2. Evidence used

- Path existence checks (`Test-Path`) for all 31 cited files.
- Line-level reads of: `src/components/app/PlaceholderView.tsx` (43-45), `src/app/api/accounting-flow/audit/fuzzy-match/route.ts` (6-7), `src/lib/services/rule-matching-engine.ts` (347-351), `src/lib/services/rule-precedence-engine.ts` (32, 104), `src/lib/security/rate-limiter.ts` (14), `SECURITY_AUDIT.md` (60-83).
- Test run: `npx vitest run src/lib/rule-engine/__tests__ tests/unit/rule-precedence-engine.test.ts tests/adversarial-ranking-parity.test.ts` — **23 test files, 381/381 passed**.
- Inventory: 44 rule-engine src files; 21 inline tests in `src/lib/rule-engine/__tests__`; 28 rule-related test files in `tests/`.
- `rg` searches for rollback/compensation, wildcard DB constraints, and `rolePriority` usage.

> Note: PowerShell globs (`src/**/*.ts`) do not expand; directory-recursive `rg`/`Select-String` with those globs produced false negatives. The IDE grep tool was used instead. Subsequent existence checks used explicit paths via `Test-Path`.

## 3. Results — original candidates (A–E)

| # | Candidate | Result | Evidence |
|---|---|---|---|
| A | Rule Management UI | **Discarded** — a full rule-management SPA already exists and is mounted | `src/components/spa/BankRulesPage.tsx`; mounted at `src/components/app/PlaceholderView.tsx:43-45` (`if (view === 'bank-rules') { return <BankRulesPage />; }`); `src/components/learning/ConversationalRuleBuilder.tsx`; `tests/components/BankRulesPage.test.tsx`. Original claim was a false positive. |
| B | Fuzzy Matching | **Redefined** — active, but as an audit/duplicate-detection tool, not a rule condition | `src/app/api/accounting-flow/audit/fuzzy-match/route.ts:6-7` imports `fetchFuzzyCandidates` (`fuzzy-pre-filter`) and `runFuzzyMatch` (`fuzzy-matcher`); front hook `src/hooks/useFuzzyMatchAudit.ts`. `RuleConditionType` in `src/lib/rule-engine/types.ts` has no fuzzy operator. Gap reframed as "fuzzy/regex as a BankRule condition type". |
| C | Rollback / Rule Simulation | **Confirmed (gap is real)** — no rule rollback exists | `src/app/api/bank-rules/apply-all/preview/route.ts` is READ-ONLY (estimates totals); `src/app/api/learning/rules/simulate/route.ts` simulates condition matching only; the only `rollback` route is `api/learning/auto-assignments/[id]/rollback` (unrelated). Shadow metrics (`s7-05b`) is a read-only AuditLog aggregator; `src/lib/operational-policy/policy-service.ts` has no rollback/simulation. |
| D | Dedicated Rule Engine Testing | **Confirmed (gap not significant)** — coverage already extensive | 23 rule-engine test files passed 381/381; 44 rule-engine src files; 21 inline tests + 28 rule-related test files in `tests/`. No coverage threshold configured in `vitest.config.ts`. Gap narrowed to formal coverage metrics/threshold. |
| E | Security Finding 5.1 Production Verification | **Confirmed (status: pending deployment)** | `SECURITY_AUDIT.md:60,70` marks 5.1 as "FIX IMPLEMENTED - pending deployment"; `src/lib/crypto.ts` no longer has a dev/test fallback; `SESSION_SECRET` mandatory (ADR-003); 19 tests in `tests/crypto.test.ts`. Remaining work is production verification, not code. |

## 4. Candidates added during verification (F–I)

| # | Candidate | Status | Evidence |
|---|---|---|---|
| F | General rate limiter is not distributed | Confirmed — SECURITY_AUDIT finding 5.2 (MEDIUM) | `SECURITY_AUDIT.md:72-83`; `src/lib/security/rate-limiter.ts:14` in-memory `Map`; auth rate limiter (`src/lib/rate-limiter.ts`) uses DB persistence. |
| G | DB-level wildcard `*` restriction | Confirmed — BRE-011 future item, explicitly out of scope there | Write/import barrier only in shared domain/API layer (`src/lib/rule-engine/wildcard.ts`); no DB constraint in `prisma/`. |
| H | `rolePriority` role in canonical tiebreak | Confirmed — BRE-012 future item | `rolePriority` computed and consumed by `selectLegacyWinner` (`src/lib/services/rule-matching-engine.ts:347-351`), but NOT a ranking signal in the canonical path (BRE-012 D1). |
| I | Rule lifecycle: testing → active promotion | Requires verification | ADR-009 open question; `rule.isActive` is the only state (`src/lib/services/rule-precedence-engine.ts:32,104`). No partial implementation found. |

## 5. Physically corroborated files and lines

All 31 cited paths exist in the checkout of `origin/main` (`257c194`). Key line-level confirmations:

- `src/components/app/PlaceholderView.tsx:43-45` — `view === 'bank-rules'` renders `BankRulesPage`.
- `src/app/api/accounting-flow/audit/fuzzy-match/route.ts:6-7` — imports `fuzzy-pre-filter` and `fuzzy-matcher`.
- `src/lib/services/rule-matching-engine.ts:347-351` — `rolePriority` in `scored.sort` comparator.
- `src/lib/services/rule-precedence-engine.ts:32,104` — `isActive` field and guard.
- `src/lib/security/rate-limiter.ts:14` — in-memory sliding-window `Map`.
- `SECURITY_AUDIT.md:60-83` — findings 5.1 (FIX IMPLEMENTED - pending deployment) and 5.2 (MEDIUM, architecture-dependent).

## 6. Limitations

- The verified A–I update was **not yet committed or pushed** at audit time; the published remote index remains the original A–E version. Claims about the update are **working-tree-only** until a diff is shown or a commit/branch is pushed.
- No numeric coverage report was generated (no coverage threshold configured in `vitest.config.ts`); candidate D relies on the test-suite inventory and the 381/381 run, not a coverage percentage.
- The verification was run against the local checkout; the user independently confirmed on GitHub that `origin/main` still contains the original A–E version.
