# S5-01: Transaction Classification Invariants — Tasks

## Task 1 — Create transaction invariants module

**Files:** `src/lib/services/transaction-invariants.ts`

- [ ] 1.1 Export `ELIGIBLE_FOR_CLASSIFICATION_FILTER` as a frozen const with `satisfies Prisma.BankTransactionWhereInput`.
- [ ] 1.2 Export `eligibleForClassificationWhere(extra?)` wrapping the filter + extra in `{ AND: [...] }`.

---

## Task 2 — Refactor `matchTransactions` + `executeApplyAll` (apply-all-engine.ts)

**File:** `src/lib/services/apply-all-engine.ts`

**SELECT filter** (in `matchTransactions`):
- [ ] 2.1 Import `eligibleForClassificationWhere`.
- [ ] 2.2 Replace inline `findMany` `where` with the helper.

**UPDATE filter — TOCTOU defense** (in `executeApplyAll`):
- [ ] 2.3 Replace the two batch `updateMany` calls (debit and credit branches) with per-ID `updateMany` inside a `for` loop, each using `eligibleForClassificationWhere({ id })`.
- [ ] 2.4 Collect only the IDs where `result.count === 1` into an `updatedIds` array.
- [ ] 2.5 Replace `allMatchedIds` usage with the authoritative `updatedIds` for all downstream effects (journal entry creation, response counts).
- [ ] 2.6 Set `appliedCount` to the actual updated count (`updatedIds.length`), not `matchResult.totalCount`.
- [ ] 2.7 If `updatedIds.length < candidateIds.length`, log a warning with the counts.

---

## Task 3 — Refactor POST single-rule apply

**File:** `src/app/api/bank-rules/[id]/route.ts`

**SELECT filter:**
- [ ] 3.1 Import `eligibleForClassificationWhere`.
- [ ] 3.2 Replace inline `findMany` `where` with the helper.

**UPDATE filter — TOCTOU defense:**
- [ ] 3.3 Replace the two batch `updateMany` calls with per-ID `updateMany` inside a `for` loop, each using `eligibleForClassificationWhere({ id })`.
- [ ] 3.4 Collect only IDs where `result.count === 1` into an `updatedIds` array.
- [ ] 3.5 Use `updatedIds.length` as the `matched` response, not the original `matchedIds.length`.
- [ ] 3.6 If `updatedIds.length < matchedIds.length`, log a warning.

---

## Task 4 — Refactor `getEntityCandidates` (entity-classifier.ts)

**File:** `src/lib/services/entity-classifier.ts` (`getEntityCandidates`)

- [ ] 4.1 Import `eligibleForClassificationWhere`.
- [ ] 4.2 Add the invariant filter to the `findMany` query.
- [ ] 4.3 Verify `take: 2000` remains unchanged (filter narrowing may reduce the total, which is fine — we want fewer, higher-quality candidates).

---

## Task 5 — Refactor smart-classify wizard

**File:** `src/app/api/learning/smart-classify/route.ts`

- [ ] 5.1 Import `eligibleForClassificationWhere`.
- [ ] 5.2 Replace inline `where` with the helper.

---

## Task 6 — Refactor rule simulation

**File:** `src/app/api/learning/rules/simulate/route.ts`

- [ ] 6.1 Import `eligibleForClassificationWhere`.
- [ ] 6.2 Replace inline `where` with the helper.

---

## Task 7 — Refactor pending entities

**File:** `src/app/api/learning/pending-entities/route.ts`

- [ ] 7.1 Import `eligibleForClassificationWhere`.
- [ ] 7.2 Replace inline `where` with the helper.

---

## Task 8 — Unit & behavioral tests

### 8a — Helper tests

**File:** `tests/services/transaction-invariants.test.ts`

- [ ] 8.1 Verify `ELIGIBLE_FOR_CLASSIFICATION_FILTER` contains the five expected fields with correct values (`isReconciled: false`, `isIgnored: false`, `journalEntryId: null`, `matchedRuleId: null`, `glAccountId: null`).
- [ ] 8.2 Verify `eligibleForClassificationWhere({ field: value })` produces `{ AND: [ELIGIBLE_FOR_CLASSIFICATION_FILTER, { field: value }] }`.
- [ ] 8.3 Verify `eligibleForClassificationWhere()` with no args returns `{ AND: [ELIGIBLE_FOR_CLASSIFICATION_FILTER, {}] }`.
- [ ] 8.4 Verify `eligibleForClassificationWhere({ isIgnored: true })` wraps the conflicting filter in `AND` with both members preserved — the helper does NOT silently discard the override.

### 8b — SELECT query verification (6 consumers)

Verify through mock/spy on Prisma that each consumer's `findMany` includes the five invariants:

- [ ] 8.5 `matchTransactions` (apply-all-engine): mock `db.bankTransaction.findMany` and assert the called `where` contains all five invariant fields.
- [ ] 8.6 POST single-rule apply (`bank-rules/[id]`): mock `db.bankTransaction.findMany` and assert the called `where` contains all five invariant fields.
- [ ] 8.7 `getEntityCandidates` (entity-classifier): mock `db.bankTransaction.findMany` and assert invariants present.
- [ ] 8.8 GET smart-classify (`/api/learning/smart-classify`): mock `db.bankTransaction.findMany` and assert invariants present.
- [ ] 8.9 POST simulate (`/api/learning/rules/simulate`): mock `db.bankTransaction.findMany` and assert invariants present.
- [ ] 8.10 GET pending-entities (`/api/learning/pending-entities`): mock `db.bankTransaction.findMany` and assert invariants present.

### 8c — TOCTOU / non-overwrite verification (2 mutating consumers)

For each of the two mutating flows, verify that a transaction in a protected state (any of the five invariants) is never overwritten:

- [ ] 8.11 `executeApplyAll` does NOT update a transaction that is ignored, reconciled, linked, classified, or rule-matched. Parametrize the five protected states.
- [ ] 8.12 Single-rule apply (`bank-rules/[id]` POST) does NOT update a transaction in any of the five protected states. Parametrize the five protected states.
- [ ] 8.13 If a transaction becomes protected between SELECT and UPDATE, the per-ID `updateMany` returns `{ count: 0 }`; verify:
  - The ID is NOT included in `updatedIds`.
  - No journal entry is created for that transaction.
  - The transaction is NOT counted in the operation's response (`appliedCount` or `matched`).
  - The warning log reflects the discrepancy.

---

## Task 9 — Verification

- [ ] 9.1 `npx tsc --noEmit` — 0 errors.
- [ ] 9.2 `npx vitest run --no-file-parallelism` — suite completa, cero fallos.
- [ ] 9.3 `npm run build` — successful.
