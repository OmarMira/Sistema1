# Tasks: BRE-013 — Rule Simulation and Rollback Safety

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~520–600 (additions+deletions incl. migration) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Durable record + fiscal guard in apply paths | PR 1 | `schema.prisma`, `executeApplyAll`, use-case, single-rule `action=apply` |
| 2 | Rollback service + endpoint | PR 2 | `rollback-apply.service.ts` + rollback route; bases on PR 1 |
| 3 | Simulation service + endpoint | PR 3 | `rule-simulation.service.ts` + confirm contract; bases on PR 1 |
| 4 | Tests, migration, cleanup | PR 4 | Spec scenario tests + migration naming + docs |

## Phase 1: Foundation / Schema

- [x] 1.1 Modify `prisma/schema.prisma`: add `RuleApplyRecord` model (execution header). Add nullable `ruleApplyRecordId` FK on `BankTransaction` and `JournalEntry` pointing to active record. No join table. `idempotencyKey @unique`.
- [x] 1.2 Wire fiscal-per-period validation into the apply transaction (`executeApplyAll`, `apply-all-engine.ts`) using `assertActiveFiscalPeriod` per transaction date.

## Phase 2: Core Services

- [x] 2.1 `apply-all-engine.ts`: extend `executeApplyAll` to create `RuleApplyRecord` (state `applied`) inside the same `tx`; link via `ruleApplyRecordId` on affected BankTransactions and generated JournalEntries; return `applyRecordId` in `ApplyResult`.
- [x] 2.2 `apply-all-use-case.ts`: pass `userId`/origin into `executeApplyAll`; surface record id; keep policy gate unchanged.
- [x] 2.3 Create `rollback-apply.service.ts`: `revertApplyRecord` — load record with related transactions/journals via FK, idempotent abort if not `applied`, per-period fiscal guard, void journals + recalc balances, unlink GL/journal links (ruleApplyRecordId stays pointing to reverted record), guarded CAS `updateMany` (`state:'applied'`→`'reverted'`; 0 rows ⇒ rollback), append `RULE_REVERTED`.
- [x] 2.4 Create `rule-simulation.service.ts`: `simulateApply` read-only, reuse `matchTransactions` (`shadow:'disabled'`), deterministic canonical ordering, no writes/record; document no ledger-accuracy claim.
- [x] 2.5 `bank-rules/[id]/route.ts`: `action=apply` creates `RuleApplyRecord` (state `applied`, no journal, origin `single-rule`) inside existing transaction; sets `ruleApplyRecordId` on affected BankTransactions.

## Phase 3: Routes / Integration

- [x] 3.1 Create `src/app/api/bank-rules/applications/[id]/rollback/route.ts`: `POST` → `revertApplyRecord`; return `{status:'already-reverted'}` on double invoke. userId from authenticated context only.
- [x] 3.2 Create `src/app/api/bank-rules/simulate/route.ts`: read-only simulation endpoint. Coexists with `/api/learning/rules/simulate`. Limit validated 1..200.
- [x] 3.3 Verify `action=apply` + apply-all + rollback+re-apply E2E route flow reuses fresh record/journal IDs. Implemented as `tests/api/bre013-e2e-apply-rollback-reapply.test.ts` (included in the 37-test green suite); test DB is migrated.

## Phase 4: Testing

Coverage ledger — what each layer actually proves (avoid overclaiming):

- **Unit tested** (mock deps, no DB atomicity): 4.1 (throw+no-audit on CAS 0-row), 4.2 (idempotency), 4.10 (simulation contract `tests/unit/rule-simulation.service.test.ts`).
- **E2E tested** (route flow, PostgreSQL real): re-apply-with-fresh-IDs + full apply→rollback→re-apply covered by Phase 3.3 `tests/api/bre013-e2e-apply-rollback-reapply.test.ts`.
- **Integration tested** (PostgreSQL real, DB atomicity): 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10 — all 25 BRE-013 tests green, `npx tsc --noEmit` exit 0, `npx prisma validate` OK.

- [x] 4.1 Unit: `revertApplyRecord` CAS 0-row throws concurrency error and does not append `RULE_REVERTED` audit. NOTE: unit mock of `$transaction` runs the callback only and does NOT simulate Postgres rollback, so it does NOT prove "record stays applied" or atomic persistence — that is covered by 4.5/4.8 (integration, real DB). Link-clearing field set assertions. Evidence: `tests/unit/rollback-apply.service.test.ts`.
- [x] 4.2 Unit: idempotent double invoke on `reverted` batch returns `already-reverted`, no re-void/re-recalc/re-audit (Scenario: Reverting an already-reverted batch is a no-op). Evidence: `tests/unit/rollback-apply.service.test.ts`.
- [x] 4.3 Unit: post-revert re-eligibility (eligibility fields cleared) via `transaction-invariants.ts`. NOTE: fresh record/journal IDs on re-apply are NOT unit-tested here; covered by Phase 3.3 E2E (`tests/api/bre013-e2e-apply-rollback-reapply.test.ts`) and 4.6/4.8. (Scenario: A re-applied transaction starts fresh). Evidence: `tests/unit/rollback-apply.service.test.ts`.
- [x] 4.4 Integration: apply all-or-nothing — fault injection mid-tx ⇒ no record, no partial journal (Scenario: Commit is all-or-nothing for apply). Evidence: `tests/integration/bre013-atomicity-44-45.test.ts`.
- [x] 4.5 Integration: revert all-or-nothing — fail after void ⇒ record stays `applied`, balances unchanged (Scenario: all-or-nothing rollback). Evidence: `tests/integration/bre013-atomicity-44-45.test.ts`.
- [x] 4.6 Integration: journaled rollback fully compensates — status→`void`, both GL balances recalculated,`journalEntryId`/`journalLineId` nulled (Scenario: journaled transaction). Evidence: `tests/integration/bre013-rollback-success-46.test.ts`.
- [x] 4.7 Integration: per-transaction fiscal guard — two-period batch, one locked ⇒ whole abort (Scenario: batch spanning two periods aborts wholly); revert rejects any closed period. Evidence: `tests/integration/bre013-fiscal-guard-47.test.ts`.
- [x] 4.8 Integration: concurrent reverts via `Promise.all` on real DB — exactly one winner; loser returns `already-reverted` OR loses the CAS (timing-dependent), never both persist (Scenario: concurrency mechanism open / single winner). Evidence: `tests/integration/bre013-concurrent-revert-48.test.ts`.
- [x] 4.9 Route: `action=apply` creates record (no journal); classification-only revert clears only `glAccountId`/`matchedRuleId`, no journal touched (Scenarios: classification-only).
  - Implemented in `tests/integration/bre013-classification-rollback-49.test.ts` (1/1 green): real route `POST /api/bank-rules/[id]` with `action=apply` via real user session on `accountexpress_test`; asserts record origin `single-rule` + state `applied`; zero `JournalEntry`/`JournalLine`; transaction `glAccountId`/`matchedRuleId`/`ruleApplyRecordId` set, `journalEntryId`/`journalLineId` null. Then `revertApplyRecord` (real engine) → state `reverted`, classification fields cleared, `ruleApplyRecordId` FK preserved, journals still zero, both GL balances identical to initial (no recalc side effect), exactly 1 `RULE_REVERTED` audit, and re-eligibility via `eligibleForClassificationWhere` (1) confirmed.
- [x] 4.10 Simulation: no-side-effects + reproducible deterministic ordering + refuses accounting claim (Simulation scenarios).
  - Unit contract in `tests/unit/rule-simulation.service.test.ts` (3/3 green, mocked engine): `readOnly:true` / `recordCreated:false` / `ledgerAccuracyNotGuaranteed:true`; forwards companyId+limit to `matchTransactions`; canonical ordering (priority asc, txIds asc).
  - Integration in `tests/integration/bre013-simulation-410.test.ts` (1/1 green, `accountexpress_test`): `simulateApply` run twice on a matched fixture → both forecasts identical (`totalCount`=1, same txIds); zero records, zero journals, zero lines, zero audit events, transaction classification fields stay null, GL balance unchanged.

## Phase 5: Cleanup

- [x] 5.1 Run `npm run lint` + typecheck; fix issues.
  - `npx tsc --noEmit` → exit 0.
  - `npm run lint` → 3 errors, ALL pre-existing and outside BRE-013 scope: `src/components/learning/EntityOnboardingModal.tsx:278`, `src/components/spa/FinancialDashboardPage.tsx:356`, `src/lib/bank-profile-service.ts:18` (verified `git diff --stat` shows zero modifications to those files). All BRE-013 files pass `npx eslint` scoped run (exit 0).
- [x] 5.2 Confirm no hard-delete/reversalOfId introduced; record `RULE_REVERTED` vs `RULE_APPLIED` history append-only (no rollback-of-rollback).
  - No `.delete()`/`.deleteMany()` on apply/rollback paths (`rollback-apply.service.ts`, `apply-all-engine.ts`, `apply-all-use-case.ts`, `bank-rules/[id]/route.ts` apply path); the only deletes in `bank-rules/[id]/route.ts:382` and `bank-rules/route.ts:539` are rule deletion, unrelated to apply/rollback.
  - `reversalOfId` appears only in docs (`01-explore.md`, `02-proposal.md`, `spec.md`), never in `src/`. spec:69 mandates soft-reverse via void, no hard-delete, no `reversalOfId`.
  - State machine unidirectional `applied → reverted`: record created with `state: 'applied'` (`apply-all-engine.ts:502`), flipped via guarded CAS `updateMany({ where: { id, state: 'applied' }, data: { state: 'reverted' } })` (`rollback-apply.service.ts:100-103`); no reverse transition exists in `src/`.
  - `RULE_APPLIED` (`bank-rules/[id]/route.ts:504,514`) and `RULE_REVERTED` (`rollback-apply.service.ts:111`) are both appended via `createAuditLogWithRetry` (insert-only). Verified append-only by design and by 4.8 concurrency test (exactly one winner; loser never persists a second event).
  - No rollback-of-rollback: once `reverted`, `revertApplyRecord` returns `already-reverted` (idempotent no-op, `rollback-apply.service.ts:46-48`); re-apply is a fresh record, never a revert-of-revert.
- [x] 5.3 Update design Open Questions (`idempotencyKey` unique, simulation coexistence) with implementation decisions.
  - `design.md` Open Questions now all [x]. Coexistence resolved: `/api/bank-rules/simulate` (BRE-013 faithful over real matcher) coexists with `/api/learning/rules/simulate` (legacy conditions simulator); no route replaced/removed. Bulk cap documented as **current implemented cap** `MAX_PER_BATCH = 200` (single source of truth via `parseSimulateLimit`), explicitly NOT a future-scalability decision; chunking/resumable execution out of scope.

## Phase 6: Concurrency hardening — apply-vs-apply (post-implementation corrective, e1ffff7)

Post-implementation defect discovered after the original slices shipped: two concurrent
applies over the SAME disputed BankTransaction row could persist a spurious
`RuleApplyRecord`. Root cause: the engine treated pre-transaction candidate IDs as if they
were acquired, so a concurrent loser that acquired ZERO rows (the winner already claimed
them via the eligibility-filtered UPDATE) still created a durable record and re-pointed the
disputed row's `ruleApplyRecordId` at its empty record.

- [x] 6.1 Defect fix — acquisition is the single source of truth. `executeApplyAll` and the new
  `executeSingleRuleClassificationApply` claim rows via `updateManyAndReturn` and push only the
  RETURNED ids; the `RuleApplyRecord` is created and linked ONLY when rows were actually
  acquired. A loser acquiring zero rows creates no durable record and cannot overwrite another
  apply's `ruleApplyRecordId`. Evidence: `src/lib/services/apply-all-engine.ts`,
  `src/lib/services/single-rule-apply.service.ts`.
- [x] 6.2 Integration (engine): deterministic concurrent `executeApplyAll` vs `executeApplyAll` over
  one disputed row — exactly ONE legit record, one journal with two lines, `ruleApplyRecordId` →
  winner. Evidence: `tests/integration/bre013-concurrent-apply-engine-40.test.ts` (passed).
- [x] 6.3 Integration (single-rule): deterministic concurrent `executeSingleRuleClassificationApply`
  vs itself — exactly ONE legit record, no spurious empty record, `ruleApplyRecordId` → winner.
  Evidence: `tests/integration/bre013-concurrent-single-rule-40.test.ts` (passed).
- [x] 6.4 Concurrency helper: deterministic lock race over a single disputed row using independent
  single-connection clients; an observer confirms both operations are waiting before releasing the
  blocker. Evidence: `tests/helpers/concurrency.ts`.
- [x] 6.5 Validation: `npx tsc --noEmit` exit 0; `npx prisma validate` OK; `npx eslint` clean on the 6
  touched files (test files excluded by the repo eslint config). The 2 failures in
  `tests/api/apply-all-enforcement-contract.test.ts` are OUT OF SCOPE for this change — tracked as a
  separate incident against `S7-11A-apply-all-enforcement-contract`.
