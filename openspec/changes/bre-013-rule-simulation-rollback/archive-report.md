# Archive Report: BRE-013 — Rule Simulation and Rollback Safety

- **Change**: bre-013-rule-simulation-rollback
- **Repo**: Sistema1
- **Main SHA**: e1ffff7 (HEAD)
- **Date**: 2026-08-05
- **Validation Status**: Passed at archive time

## Decision

`durable-ruleapplyrecord-atomic-rollback` — a durable `RuleApplyRecord` anchored inside the
apply transaction (1-table model via nullable FKs); rollback via guarded CAS
`applied → reverted` (soft-reverse: void + balance recalc + unlink); simulation as a
read-only forecast reusing the real matcher with deterministic canonical ordering.

## Resolved Decisions

1. **D1 — Durable record name and shape**: `RuleApplyRecord` (origin `batch` | `single-rule`,
   single `ruleId`, `userId`, `companyId`, `state`, `appliedAt`, `idempotencyKey @unique`);
   nullable `ruleApplyRecordId` FKs on `BankTransaction` and `JournalEntry` (1-table model;
   re-apply overwrites FKs).
2. **D2 — State machine**: unidirectional `applied → reverted`; every transition all-or-nothing;
   no `reversalOfId`, no hard delete, no rollback-of-rollback.
3. **D3 — Revert concurrency**: guarded CAS on `state: 'applied'`; 0 rows ⇒ this transaction
   aborts; double invoke returns idempotent `already-reverted`.
4. **D4 — Fiscal-period guard**: `assertActiveFiscalPeriod` per transaction date INSIDE the apply
   and revert transactions (no TOCTOU); ANY locked period aborts the whole transaction.
5. **D5 — Simulation**: read-only, reuses `matchTransactions({ shadow: 'disabled' })`, deterministic
   canonical ordering, explicitly NO ledger-accuracy claim.
6. **D6 — Rollback entry point**: new `POST /api/bank-rules/applications/[id]/rollback` →
   `revertApplyRecord`; kept separate from rule CRUD and the apply-all funnel.
7. **D7 — Apply concurrency (corrective)**: acquisition is the single source of truth — rows are
   claimed via `updateManyAndReturn` and the durable record + `ruleApplyRecordId` link are created
   only when rows were actually acquired; a concurrent loser creates no durable record.

## Implementation Evidence

- **Corrective commit**: `e1ffff7` `fix(bre-013): make concurrent classification apply acquire rows
  atomically` — published to `origin/main` (`8389a91..e1ffff7`).
- **Concurrency corrective**: defect apply-vs-apply; root cause candidate IDs vs actually-acquired
  IDs; fix `updateManyAndReturn()` in `executeApplyAll` and `executeSingleRuleClassificationApply`;
  durable record + FK link gated on actually-acquired rows.
- **Deterministic concurrent tests**: `tests/integration/bre013-concurrent-apply-engine-40.test.ts`
  and `tests/integration/bre013-concurrent-single-rule-40.test.ts`, driven by
  `tests/helpers/concurrency.ts` — both passed at the time of archive.
- **Validations (closure)**: `npx tsc --noEmit` exit 0; `npx prisma validate` OK; BRE-013
  unit/integration/E2E suite passed; `git diff --check` clean (only pre-existing CRLF warnings).
- **ESLint (closure)**: 0 errors on the BRE-013 productive files reviewed (`apply-all-engine.ts`,
  `single-rule-apply.service.ts`, `bank-rules/[id]/route.ts`); test files are excluded by the repo
  eslint config.

## Out of Scope

- `tests/api/apply-all-enforcement-contract.test.ts`: 2 failing tests. These are out of scope for
  BRE-013 and are tracked as a separate contract-drift incident against
  `S7-11A-apply-all-enforcement-contract`.
- `lint` reports 3 pre-existing errors in unrelated components
  (`src/components/learning/EntityOnboardingModal.tsx:278`,
  `src/components/spa/FinancialDashboardPage.tsx:356`, `src/lib/bank-profile-service.ts:18`).
- A `.env` file remains tracked in the repo (pre-existing, outside this change).

## Published Specs / Artifacts

- `openspec/changes/bre-013-rule-simulation-rollback/specs/rule-simulation-and-rollback/spec.md` — delta spec
- `docs/adr/ADR-013-bre-013-rule-simulation-rollback.md`
- `docs/history/2026-08-rule-simulation-rollback.md`

## Status

This change is considered complete for the approved BRE-013 scope.
