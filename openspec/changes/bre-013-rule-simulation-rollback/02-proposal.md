# Proposal: BRE-013 — Rule Simulation and Rollback Safety

**Change:** `bre-013-rule-simulation-rollback`  
**Base:** `01-explore.md` (fully mapped database mutations, transactional choke points, and inconsistency in fiscal period guards)  
**Artifact store:** openspec  
**Status:** Proposal (gate → `sdd-spec` approval)  

---

## 1. Observed Evidence (Closed — Facts are NOT reopened here)

Measured, not asserted (`01-explore.md` §3, §5, §11, §12). The exploration was fully audited, and the following verified repository facts serve as the sole foundation for this proposal.

| Finding / Evidence | Location / Source | Level |
|---|---|---|
| **No durable batch entity** | No durable apply/batch record exists in `prisma/schema.prisma`. `batchId` exists only as a transient UUID used as `entityId` in `AuditLog` rows. | Fact |
| **Missing fiscal period guard** | `executeApplyAll` (`apply-all-engine.ts:358-468`) does NOT call `assertActiveFiscalPeriod`. It operates on raw transaction dates without checking lock states. | Fact |
| **Single mode guards the period** | Single-rule apply validates the fiscal period via `verifyPeriodNotLocked` (`apply-all-use-case.ts:324, 437`). | Fact |
| **Void does not unlink transaction** | Existing `journal/[id]` 'void' handler (`journal/[id]/route.ts:281-327`) marks the entry status as `void` but does NOT null out `bankTransaction.journalEntryId`. | Fact |
| **Balances aggregate posted only** | `recalculateBalance` (`journal-entry.service.ts:76`) only sums *posted* journal lines, meaning a `void` status naturally removes their effect on balances. | Fact |
| **Eligibility filter** | `transaction-invariants.ts:3-17` requires `glAccountId`, `matchedRuleId`, and `journalEntryId` to be null and `isReconciled = false` for rule eligibility. | Fact |
| **AuditLog is append-only in normal flows** | `audit.ts:18` only supports insertions in rule matching and application paths. Deleting or modifying logs is restricted to the admin company purge exception (`admin/companies/[id]/route.ts:141`). | Fact (with documented exception) |

---

## 2. Problem Framing — Simulation vs Preview vs Rollback vs Compensation

To ensure accounting safety and precise domain language, this proposal explicitly distinguishes four technical capabilities:

1. **Simulation**: A read-only forecast of rule classification using the same matching engine and eligibility rules as an apply, with no side effects. See the Simulation Contract (§4).
2. **Preview (`/api/bank-rules/apply-all/preview`)**: The existing read-only endpoint that returns matched-rule counts, totals, and remaining transactions via `matchTransactions` (`apply-all-engine.ts:324`). It does not predict GL/journal ledger effects.
3. **Rollback**: The physical reversal of rule-classification fields on `BankTransaction` (`glAccountId` and `matchedRuleId`) back to `null`, making them eligible for re-evaluation.
4. **Compensation**: The accounting preservation mechanism. For transactions that generated posted ledger effects, rollback *must* trigger compensation (marking the `JournalEntry` as `void`, recalculating the `GLAccount` balances, and unlinking the journal from the bank transaction) to prevent dangling journals or corrupt financial balances.

---

## 3. Business Decisions (The Contract)

The following **seven business decisions** constitute the binding contract approved by the user. No design or implementation phase may deviate from them.

### Decision 1: Rollback Scope (Dual Semantics)
We adopt a dual-reversal semantic based strictly on whether an accounting journal entry was generated:
- **With Journal Entry**: Revert classification fields (`glAccountId`, `matchedRuleId`) + trigger accounting compensation (set `JournalEntry` status to `void`, recalculate `GLAccount.balance` on affected debit/credit accounts) + unlink the `JournalEntry` from the transaction (`journalEntryId` and `journalLineId` set to `null`).
- **Classification-Only (No Journal)**: Revert only `glAccountId` and `matchedRuleId` + clear associated links.
- **Invariant**: Never leave a dangling/orphan journal entry, and never break double-entry ledger parity.

### Decision 2: Compensation Form (Void in Open Periods Only)
First-slice implementation is strictly limited to soft-reversal via **voiding** in open periods:
- No hard-deletes of `JournalEntry` or `JournalLine` rows are allowed under normal flows.
- No new columns or tables for reversing entries (e.g., `reversalOfId`) are introduced in this slice.
- Compensating posted entries in closed periods via reversing entries is out of scope and is deferred to a future change.
- A rolled-back transaction has its linked `JournalEntry` status updated to `void`. The `GLAccount` balances are recomputed using existing `recalculateBalance` primitives, and the `BankTransaction` fields `journalEntryId` and `journalLineId` are nullified.

### Decision 3: Durable Anchor (Conceptual Durable Apply Record)
We reject relying solely on `AuditLog.entityId` as a permanent solution. BRE-013 introduces a **conceptual** durable application record whose definitive name is resolved in `sdd-design` (candidates include `ApplyBatch`, `RuleApplication`, `RuleExecution`). At proposal level it defines capabilities, not physical structure:
- Identify a single execution.
- List affected transactions and generated journals.
- Record origin, rule (if single), user, and date.
- Track lifecycle state.
- Support idempotency.
- Support auditable reversal.

Physical shape (columns, cardinality, nullability, indexes) and the exact relations between batch, transactions, and journals are **open design questions**, not decided here.

### Decision 4: Fiscal Period Guard Correction
We correct the pre-existing compliance gap in batch applies within BRE-013:
- Every application path that produces ledger effects must validate the fiscal period (`assertActiveFiscalPeriod`) inside the same transaction.
- Rollback or compensation is rejected outright if any affected transaction falls into a closed or locked period.
- BRE-013 will not reopen periods or bypass the fiscal period guard.
- A single batch may span more than one fiscal period, so period association must be evaluated per transaction date, not assumed to be a single batch-level value.

### Decision 5: Covered Origins (First Slice)
- **In Scope**: Batch apply (`/api/bank-rules/apply-all`), single apply passing through `executeApplyAll`, and individual actions that can be safely linked to the same durable record and transactional contract.
- **Out of Scope**: Import-time classification (`import.service.ts`), auto-reconciliation (`reconciliation/auto`), retroactive migration of legacy runs lacking a durable batch, rollback of reconciliation states, and full import rollbacks.
- **Single-Rule Apply Action**: If `POST /api/bank-rules/[id]?action=apply` does not trigger `executeApplyAll` or generate journals, it must be documented and handled as classification-only rollback. We will not force an artificial unification.

### Decision 6: Re-apply and Idempotency Contract
- A reverted batch cannot be reverted again. The batch state acts as a hard transition guard.
- Retrying a revert command on an already reverted batch must be safe and idempotent (return success or current state, do not re-compensate).
- A rolled-back transaction is fully restored to the unmatched pool; a subsequent rule application to this transaction is treated as a fresh action, creating a new batch record and new journal IDs. It never reuses previous IDs.
- No duplicated journals or effects from technical retries.

### Decision 7: Audit of the Audit (Unidirectional)
- Rollback is unidirectional: there is no "rollback of a rollback".
- Reversing an application creates a new, distinct audit event (e.g., `RULE_REVERTED` / journal-void record). It does not alter or erase existing `RULE_APPLIED` logs.
- Forensic integrity is absolute: old events are never rewritten in normal flows.
- The administrative company purge exception (`deleteMany`) remains isolated from this safety contract and is documented as external to BRE-013.

---

## 4. Simulation Contract

A safe simulation must satisfy the following contract. It is limited, but it makes BRE-013 a simulation-and-rollback change rather than only "durable apply + rollback":

- **Read-only**: a simulation never writes transactions, journals, balances, or audit events, and never creates a batch record.
- **Same engine, same eligibility rules as apply**: the simulation must run the real matching/resolution logic and the same eligibility filter used by apply (`transaction-invariants.ts:3-17`), so it is a faithful forecast of classification, not an organic approximation.
- **No side effects**: no durable apply record is created, no journal or balance is touched.
- **Reproducible**: for the same rules and transaction set, the simulation must produce a deterministic result.
- **Scope warning**: simulation does not simulate postings, so it cannot guarantee accounting accuracy for ledger effect, journal lines, or balances. A full accounting dry-run that predicts exact debit/credit amounts is out of scope (explicitly restated in §9).

The exact reconciliation between the existing `/api/learning/rules/simulate` route and the real matching engine is left open for design; the contract above defines the guarantees it must meet.

---

## 5. Conceptual Durable Apply Record (Capabilities, not Physical Schema)

At proposal level we define the durable record by the capabilities it must provide; physical shape is decided in `sdd-design`:

- Identify one execution of rule application.
- Relate one batch to its transactions (N:M) and to the journals generated (N:M). Cardinality and nullability of these relations are open design questions.
- Store origin, rule (single only), user, and timestamp.
- Track lifecycle state.
- Support idempotency (retry-safe commands).
- Support auditable reversal.

**Period association**: a batch can contain transactions belonging to more than one fiscal period. Therefore period validation must run per transaction date; a single batch-level period value is NOT assumed.

### State Machine — Strict Atomicity (Option A)

BRE-013 adopts **strict atomicity** for rollback. Rollback runs inside a single atomic transaction, so no intermediate partial state is ever persisted. On failure the whole transaction rolls back and the batch remains `applied`.

```
            ┌──────────────┐
            │   applied    │
            └──────┬───────┘
                   │ Revert trigger (open-period validated)
                   ▼
            ┌──────────────┐
            │  reverting   │   (transient, in-transaction only)
            └──────┬───────┘
                   │
          ┌────────┴────────┐
          │ success         │ failure
          ▼                 ▼
   ┌──────────────┐   ┌──────────────┐
   │   reverted   │   │   applied    │
   └──────────────┘   └──────────────┘
```

- **`applied`**: initial state; the batch exists and all its transactions are classified with journals posted.
- **`reverting`**: transient marker during the rollback transaction. It is NOT a durable concurrency-exclusion mechanism: within a single transaction its value is not visible to other processes until commit. It is used only to document intent.
- **`reverted`**: terminal state. Transactions are unlinked, journals voided, balances recomputed, and a compensation audit event written.

There is **no `partially_failed` state** in the first slice. `partially_failed` would only be meaningful if the design adopted chunked processing, multiple transactions, or external side effects outside Prisma — all rejected for the first slice in favor of strict atomicity.

---

## 6. Transactional & Safety Contracts

### The Apply Transaction (Mutations & Guards)
Every apply invocation through `executeApplyAll` runs in a single atomic Prisma transaction. Because it is atomic, the batch record is only ever visible once the entire apply succeeded; nothing partial persists:
1. **Fiscal Guard**: validate every targeted transaction date with `assertActiveFiscalPeriod` inside the same transaction.
2. **Classification**: `bankTransaction.updateMany` setting `glAccountId`, `matchedRuleId`.
3. **Journal Generation**: create `JournalEntry` and `JournalLine` rows (status `'posted'`) for matched transactions.
4. **Batch Relations**: record the batch's links to affected transactions and generated journals.
5. **Balance Recalculation**: run `recalculateBalance` for affected GL accounts.
6. **Audit Log**: append `RULE_APPLIED` and policy audit entries.
7. **Batch Creation**: the durable batch row is created within the same transaction and is persisted as `applied` — it becomes visible only at commit. If any step fails, the transaction rolls back and no batch row exists.

### The Revert Transaction (Mutations & Guards)
A rollback request runs in a single atomic Prisma transaction:
1. **State Guard**: load the batch and assert its state is `applied`. If it is already `reverted`, abort idempotently (no re-compensation).
2. **Fiscal Guard**: validate all transaction dates from the batch relations with `assertActiveFiscalPeriod`. If any period is closed or locked, abort the whole transaction.
3. **Compensate Journals**: set linked `JournalEntry.status` to `'void'` and run `recalculateBalance` for affected GL accounts.
4. **Unlink Transactions**: set `glAccountId`, `matchedRuleId`, `journalEntryId`, and `journalLineId` to `null` on the linked `BankTransaction` rows.
5. **State Finalization**: set the batch state to `reverted`.
6. **Audit Event**: append a distinct compensation audit event referencing the batch.

On any failure the entire transaction rolls back; the batch remains `applied` and no partial compensation is persisted.

**Concurrency exclusion is an open design question.** The proposal does not claim a specific locking mechanism. `sdd-design` must resolve how a concurrent revert is excluded using a verifiable atomic mechanism, for example an atomic state-guarded update (`UPDATE ... WHERE state = 'applied'`), a row lock, or an optimistic version/constraint. The contract only requires that the mechanism be atomic and verifiable.

---

## 7. Risks & Open Design Questions

The following are explicitly handed off to `sdd-design` / `sdd-spec`:

| Risk / Question | Impact | Handed to |
|---|---|---|
| Exact schema entity name and physical shape of the durable batch record | Schema consistency | `sdd-design` |
| Cardinality and nullability of batch↔transaction and batch↔journal relations | Data model correctness | `sdd-design` |
| Period association when a batch spans multiple fiscal periods | Correctness of fiscal enforcement | `sdd-design` |
| Concurrency-exclusion mechanism for revert (atomic state-guarded update vs row lock vs optimistic versioning) | Integrity under concurrent operations | `sdd-design` |
| Whether `partially_failed`/resumable execution is ever needed (chunked or multi-transaction) | Future extension beyond atomicity | Deferred — out of first-slice scope; Option A assumed |
| Idempotency keying for retries of the revert command | Retry safety | `sdd-spec` |
| Bulk performance limits on large batches | DB timeouts | `sdd-design` |
| Whether simulation should reuse or replace the existing `/api/learning/rules/simulate` route | Contract coverage | `sdd-design` |

---

## 8. Alternatives Rejected

| Alternative | Reason for Rejection |
|---|---|
| **Hard-Delete Journals** | Rejected to protect accounting history and forensic auditability. Cascade deletion of financial entries violates ledger integrity. |
| **Reversing Entries (`reversalOfId`)** | Rejected for the first slice to maintain low complexity. It requires new columns and period-aware date adjustments that are unnecessary for open-period rollback. |
| **Depend only on `AuditLog.entityId`** | Rejected. The audit log is append-only in normal flows (with the documented administrative purge exception) and is not structured for transactional state, relations, or idempotency. A structured durable record is required. |
| **Resumable rollback (`partially_failed`)** | Rejected for the first slice. It requires chunked/multi-transaction processing or external side effects, which contradict the strict-atomicity safety model. |

---

## 9. Out of Scope

To prevent scope creep, the following items are explicitly marked out of scope for BRE-013:
- Reversing auto-reconciliation mutations.
- Reversing import-time classifications.
- Rollback or deletion of a complete `BankStatement` import.
- Reopening closed fiscal periods.
- Reversing entries for closed/locked periods (future change).
- Resumable/chunked rollback (`partially_failed`) — strict atomicity is the first-slice model.
- Any user interface (UI) components.
- Dry-run full accounting simulation showing exact debit/credit amounts (only read-only forecasts are in scope).

---

## Appendix A — Proposal Completeness

The proposal is complete when it presents all of the following, mapped to their sections here:
- problem and objective (§2);
- simulation contract (§4);
- durable apply contract (§6);
- rollback/compensation contract (§6);
- fiscal-period boundaries (§3 Decision 4, §6);
- conceptual durable apply record (§5);
- states and transitions (§5);
- idempotency (§3 Decision 6, §6);
- risks (§7);
- rejected alternatives (§8);
- scope and out-of-scope (§3 Decision 5, §9);
- questions still requiring a decision in design (§7).
