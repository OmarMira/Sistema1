# S5-01: Transaction Classification Invariants

## Scope

Centralize and enforce the business rule that certain persisted bank transactions must never be re-processed by the classification engine. Currently, the definition of "eligible for classification" is repeated across 6 query sites with slightly different filters, creating a risk that protected transactions are re-classified or overwritten.

## Invariant Rule (Domain Contract)

A persisted `BankTransaction` **MUST NOT** be fed into any classification, rule-matching, simulation, or suggestion engine if **any** of the following hold:

- `isReconciled === true`
- `isIgnored === true`
- `journalEntryId !== null` (already linked to a Journal Entry)
- `matchedRuleId !== null` (already classified via a Bank Rule)
- `glAccountId !== null` (manually or automatically classified)

This is a **domain invariant**, not a SQL optimization. It applies to classification / rule-reapplication flows only — reporting, reconciliation, and analytical queries may include the full universe of transactions.

## Deliverable

### 1. Single Source of Truth

**File:** `src/lib/services/transaction-invariants.ts`

Must export:

```ts
import type { Prisma } from '@prisma/client';

export const ELIGIBLE_FOR_CLASSIFICATION_FILTER = Object.freeze({
  isReconciled: false,
  isIgnored: false,
  journalEntryId: null,
  matchedRuleId: null,
  glAccountId: null,
}) satisfies Prisma.BankTransactionWhereInput;

export function eligibleForClassificationWhere(
  extra: Prisma.BankTransactionWhereInput = {},
): Prisma.BankTransactionWhereInput {
  return {
    AND: [ELIGIBLE_FOR_CLASSIFICATION_FILTER, extra],
  };
}
```

The `AND` wrapper prevents callers from **silently** overriding any invariant field: if a caller passes `{ isIgnored: true }`, Prisma receives `AND: [{ isIgnored: false, ... }, { isIgnored: true }]` and returns zero rows. The conflict is expressed, not hidden.

### 2. Refactored Consumers (6 sites)

Each of the following MUST replace its inline `where` filter with `eligibleForClassificationWhere()`:

| # | Module / Route | Purpose | Current `where` |
|---|---|---|---|
| 1 | `apply-all-engine.ts` (`matchTransactions`) | Batch rule application | `isReconciled: false, matchedRuleId: null` |
| 2 | `src/app/api/bank-rules/[id]/route.ts` (POST) | Single-rule application | `isReconciled: false, matchedRuleId: null` |
| 3 | `entity-classifier.ts` (`getEntityCandidates`) | Candidate suggestion engine | None (loads all 2000 txs) |
| 4 | `src/app/api/learning/smart-classify/route.ts` | Wizard classification flow | `isReconciled: false, glAccountId: null` |
| 5 | `src/app/api/learning/rules/simulate/route.ts` | Rule simulation preview | `isReconciled: false` only |
| 6 | `src/app/api/learning/pending-entities/route.ts` | Pending entity clustering | `isReconciled: false, glAccountId: null` |

For **read-only** consumers (`smart-classify`, `simulate`, `pending-entities`, `getEntityCandidates`), the `where` clause change is the only modification — business logic and output format remain untouched.

For **mutating** consumers (`apply-all-engine`, single-rule apply), a second defense MUST exist at the write site: the `updateMany` call must include the invariant filter, so a transaction that becomes protected between SELECT and UPDATE is never overwritten. Business logic and output format otherwise remain untouched.

Furthermore, a transaction that was **skipped** by the conditional UPDATE MUST:
- Not be included in any downstream effect (journal entry creation, audit log, response counts).
- Not be counted as applied in the operation result.
- The response MUST reflect the actual number of transactions that were modified, not the originally selected set.

### 3. Verification

- TypeScript compilation: 0 errors.
- Production build: successful.
- For the two mutating flows, `updateMany` must include `eligibleForClassificationWhere(...)` so that TOCTOU races cannot overwrite a transaction that became protected after the initial SELECT.
- Existing behavior and API contracts must remain unchanged. Existing tests should continue passing; tests may be updated only where their query-shape mocks must reflect the centralized invariant (the `where` object structure changes from flat to `AND`).
- New unit tests in `tests/services/transaction-invariants.test.ts` verify:
  - The constant contains the five expected fields with correct values.
  - The helper produces correct `AND` + extra composition with and without arguments.
  - `eligibleForClassificationWhere({ isIgnored: true })` wraps the filter + conflicting flag in `AND` (no silent override).
- Behavior of the six consumers MUST be verified through query inspection tests (mock Prisma and assert the resulting `where` contains the five invariants).

---

## Known Limitation (deferred)

In `apply-all-engine`, the refetch query (`matchedTxs`) runs within the same `$transaction` but under PostgreSQL Read Committed isolation. Between the per-rule `updateMany` and the final refetch, another concurrent process could classify a transaction (set `glAccountId`) without creating a journal entry. That transaction would:

- Be **correctly skipped** by our `updateMany` (the invariant WHERE excludes it).
- Still **appear in the refetch** (`glAccountId: { not: null }`, `journalEntryId: null`).
- Potentially **receive a duplicate journal entry**.

The definitive fix requires identifying exactly which rows were updated by this operation — e.g. via `UPDATE ... RETURNING id` (requires raw SQL, not Prisma `updateMany`) or a redesign of the journal-creation flow to tolerate and deduplicate concurrent classifications. This is outside the scope of S5-01 and should be addressed in a dedicated Sprint.
