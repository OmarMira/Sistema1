# Design: BRE-013 — Rule Simulation and Rollback Safety

## Technical Approach

Anchor every covered apply with a durable **`RuleApplyRecord`** created inside the same atomic Prisma transaction that already performs classification and journaling (`executeApplyAll`, `apply-all-engine.ts:358`). Rollback is a second single atomic transaction that voids generated journals, recalculates GL balances, unlinks transactions, and flips the record to a terminal `reverted` state, guarded per-transaction by the existing fiscal-period guard and excluded concurrently by an atomic state-guarded update. Simulation is a read-only forecast reusing the same matching engine and eligibility filter.

## Architecture Decisions

### Decision: Durable record name and capabilities

| Option | Tradeoff | Decision |
|---|---|---|
| `RuleApplyRecord` | Single term covering batch and single-rule apply; not limited to a "batch" concept | **Chosen** |
| `ApplyBatch` | Misleading for single-rule `action=apply` and single-mode `executeApplyAll` runs | Rejected |
| `RuleExecution` | Collides conceptually with `RuleExecutionAudit` (`schema.prisma:274`) | Rejected |

`RuleApplyRecord` is the design-level name; physical schema/migration naming stays open. It carries: `origin` (`batch` \| `single` \| `single-rule`), single `ruleId` (null for mixed batch), `userId`, `companyId`, `appliedAt`, `state`, `idempotencyKey`. Logically it relates to N affected `BankTransaction` rows and N generated `JournalEntry` rows — physically this is implemented via nullable FKs on `BankTransaction` and `JournalEntry` pointing to the active record (1-table model; re-apply overwrites FKs). This is the durable anchor that satisfies the spec's "identifies one execution, relates transactions and journals" requirement (spec:34). It does NOT replace `AuditLog`; it complements it as a structured transactional state record.

### Decision: State machine (strict atomicity)

```
applied ──revert trigger (open-period validated)──► reverting ──commit──► reverted
                                                     │
                                                     └── failure ──► applied (rolled back)
```

- `applied`: initial; record + relations visible only at commit.
- `reverting`: transient intent marker, in-transaction only; never used for recovery or resume (proposal §5).
- `reverted`: terminal; no `partially_failed` in this slice.

Every transition is all-or-nothing: apply failure leaves no record; revert failure leaves the record `applied` (spec:91-104).

### Decision: Concurrency exclusion — atomic state-guarded update

| Option | Tradeoff | Decision |
|---|---|---|
| State-guarded update (`UPDATE ... WHERE state='applied'`) | No long-held row locks; loser detects 0 rows at finalize and aborts; correct only because all compensation writes are idempotent | **Chosen** |
| Row lock (`SELECT ... FOR UPDATE`) | Blocks concurrent reverters during a potentially long compensation; adds deadlock surface; needs raw SQL via `$queryRaw` | Rejected |
| Optimistic versioning (version column) | Extra column; retry logic; no advantage over CAS for a one-shot terminal transition | Rejected |

Mechanism: the revert transaction reads the record and asserts `state='applied'`, performs compensation, then finalizes via a guarded `updateMany({ where: { id, state: 'applied' }, data: { state: 'reverted' } })`. Count 0 ⇒ another transaction won ⇒ throw so this transaction rolls back and the caller gets the current `reverted` state (idempotent, per Decision 6). This matches the proposal's "atomic and verifiable" contract (proposal §6) and the codebase's `updateMany` idiom (`apply-all-engine.ts:406-421`, `bank-rules/[id]/route.ts:464-477`). `reverting` alone cannot exclude concurrent work because uncommitted writes are not visible to other processes until commit — hence the CAS at finalize is the real arbiter.

### Decision: Fiscal-period guard per transaction date, inside the same transaction

`assertActiveFiscalPeriod` (`fiscal-period-guard.ts:9`) already accepts an optional transaction client, so it can run inside the apply and revert transactions without TOCTOU. Apply currently skips it (`executeApplyAll` never imports it — exploration fact); BRE-013 closes this by validating every targeted transaction date inside the apply transaction. Revert validates every related transaction date; if ANY falls in a closed/locked period, the ENTIRE transaction aborts (spec:111-127). Periods are never reopened; no batch-level single period value is assumed.

### Decision: Simulation reuses the real engine, as a new read-only path

| Option | Tradeoff | Decision |
|---|---|---|
| New read-only simulation reusing `executeMatching`/`matchTransactions` (`apply-all-engine.ts:126,324`) | Faithful forecast; same eligibility + resolver; no side effects | **Chosen** |
| Replace/modify `/api/learning/rules/simulate` | Legacy route is a condition-only organic tester; changing it risks existing consumers | Rejected (left as-is, documented as not the simulation contract) |
| Keep legacy route only | Not faithful to apply | Rejected |

The simulation service calls `matchTransactions` with `{ shadow: 'disabled' }` and returns a deterministic canonical ordering (rules by `priority asc`, `txIds` sorted — the same sorting already applied in `executeApplyAll` at `apply-all-engine.ts:402-403`). It writes nothing and never creates a record. It documents that postings/journals/balances are NOT predicted (spec:11).

### Decision: Rollback entry point

New route `POST /api/bank-rules/applications/[applicationId]/rollback` delegating to a new `revertApplyRecord(companyId, applicationId, userId)` service. Kept separate from `bank-rules/[id]` (rule CRUD) and from the `apply-all` funnel. The existing journal `void` handler (`journal/[id]/route.ts`) is NOT reused because it does not unlink `journalEntryId` — compensation here must also null the links (exploration fact).

### Decision: Acquisition is the single source of truth (apply-vs-apply concurrency)

Post-implementation corrective (`e1ffff7`). Two concurrent applies over the same disputed
row could persist a spurious `RuleApplyRecord`: the engine treated pre-transaction
candidate IDs as acquired, so a loser that acquired ZERO rows (the winner already claimed
them via the eligibility-filtered UPDATE) still created a record and re-pointed the disputed
row's `ruleApplyRecordId` at its empty record.

| Option | Tradeoff | Decision |
|---|---|---|
| `updateManyAndReturn` returning ACTUAL acquired ids; record only when acquired > 0 | Winner claims rows atomically and is the only writer of `ruleApplyRecordId`; loser acquires 0 → writes nothing; no long-held row locks | **Chosen** |
| Keep `updateMany` + candidate ids, gate on in-transaction eligibility recompute | Recomputation is a second read that still drifts from the atomic claim; empty loser record remains possible | Not selected for this implementation |
| `SELECT ... FOR UPDATE` on candidate rows | Serializes applies; raw SQL; deadlock surface; overkill for the loser-writes-nothing contract | Not selected for this implementation |

Mechanism: `executeApplyAll` and `executeSingleRuleClassificationApply` claim rows with
`updateManyAndReturn({ where: eligibleForClassificationWhere(...), data: {...}, select: { id: true } })`
and collect the RETURNED ids. The durable record and the `ruleApplyRecordId` link are created
only when rows were actually acquired. The record's existence and the row's FK become a direct
consequence of the atomic claim, closing the apply-vs-apply race.

## Data Flow

```
Apply (executeApplyAll, single tx):
  matchResult ──► [1] assertActiveFiscalPeriod(each tx date)
              ──► [2] bankTransaction.updateMany(glAccountId, matchedRuleId)   :406-421
              ──► [3] JournalEntryService.createFromBankTransaction(per tx)    :451   (posted JE + 2 lines + recalc)
              ──► [4] RuleApplyRecord.create(state='applied') + relations to txs & journals
              ──► [5] RULE_APPLIED / policy audits (existing best-effort, outside core where noted)
              ──► commit ──► record observable

Revert (revertApplyRecord, single tx):
  applicationId ──► [1] load record; state must be 'applied' (else idempotent return)
               ──► [2] assertActiveFiscalPeriod(each related tx date)  ── any locked ⇒ abort all
               ──► [3] for each related journal: status→'void'; recalculateBalance(debit, credit GL)
               ──► [4] related BankTransaction: glAccountId/matchedRuleId/journalEntryId/journalLineId→null
               ──► [5] guarded updateMany state 'applied'→'reverted' (CAS; 0 rows ⇒ rollback)
               ──► [6] RULE_REVERTED audit event
               ──► commit
```

Rollback point: the whole revert is one transaction; no savepoints needed because nothing outside Prisma is touched.

## Exact links cleared

| Rollback type | BankTransaction fields cleared | JournalEntry / GL effects |
|---|---|---|
| Classification-only (single-rule `action=apply`) | `glAccountId→null`, `matchedRuleId→null` | None created; none touched |
| Journaled (batch / single-mode via `executeApplyAll`) | `glAccountId→null`, `matchedRuleId→null`, `journalEntryId→null`, `journalLineId→null` | `JournalEntry.status→'void'`; `GlAccount.balance` recalculated on affected debit & credit accounts |

Post-revert, transactions satisfy `eligibleForClassificationWhere` again (`transaction-invariants.ts:3-17`), so re-apply starts fresh with new IDs (spec:138-143). A reverted transaction is only unlinked if it is still `isReconciled=false` and not re-classified by an out-of-scope origin (import/reconciliation).

## File Changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `RuleApplyRecord` model + relations to `BankTransaction`/`JournalEntry` (physical shape open — see Open Questions). Read-only here; migration deferred to apply |
| `src/lib/services/apply-all-engine.ts` | Modify | `executeApplyAll`: add fiscal guard + create record/relations inside the same `tx`; return record id in `ApplyResult` |
| `src/lib/services/apply-all-use-case.ts` | Modify | Pass `userId`/origin into `executeApplyAll`; surface record id; keep policy gate unchanged |
| `src/lib/services/rollback-apply.service.ts` | Create | `revertApplyRecord` — the full revert transaction per Data Flow |
| `src/app/api/bank-rules/applications/[id]/rollback/route.ts` | Create | Revert entry point; idempotent success on already-reverted |
| `src/app/api/bank-rules/[id]/route.ts` | Modify | `action=apply`: create `RuleApplyRecord` (state `applied`, no journal) inside the existing transaction |
| `src/lib/services/rule-simulation.service.ts` | Create | Read-only forecast reusing `matchTransactions`; deterministic canonical ordering |
| `src/app/api/bank-rules/simulate/route.ts` | Create | Simulation endpoint (read-only) |
| `src/lib/fiscal-period-guard.ts` | Use (no change) | Already accepts a transaction client |
| `src/lib/services/transaction-invariants.ts` | Use (no change) | Eligibility filter reused for apply, simulation, and post-revert eligibility |

## Interfaces / Contracts

```ts
// RuleApplyRecord (design-level; physical schema open)
interface RuleApplyRecord {
  id: string; companyId: string; origin: 'batch' | 'single' | 'single-rule';
  ruleId: string | null; userId: string; state: 'applied' | 'reverting' | 'reverted';
  appliedAt: Date; idempotencyKey: string;
  affectedTransactions: string[];   // BankTransaction ids
  generatedJournals: string[];      // JournalEntry ids
}

// apply-all-engine.ts
executeApplyAll(companyId, tx, matchResult, ctx: { userId: string; origin: 'batch' | 'single' })
  : Promise<ApplyResult & { applyRecordId: string }>

// rollback-apply.service.ts
revertApplyRecord(companyId: string, applicationId: string, userId: string)
  : Promise<{ status: 'reverted' | 'already-reverted' }>

// rule-simulation.service.ts
simulateApply(companyId: string, opts?: { limit?: number }): Promise<SimulationResult> // read-only
```

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | State transitions; CAS finalize (0-row → abort); link-clearing field sets; post-revert re-eligibility | Vitest on `rollback-apply.service.ts` + `transaction-invariants` reuse |
| Unit | Idempotent revert retry; no re-compensation, no re-audit | Service-level double-invoke |
| Integration | Apply all-or-nothing (fault injection mid-tx ⇒ no record, no partial journal) | Prisma tx spy/rollback test |
| Integration | Revert all-or-nothing (fail after void ⇒ record stays `applied`, balances unchanged) | Tx failure injection |
| Integration | Journaled rollback: void + recalc + unlink (`journalEntryId`/`journalLineId` null) | DB assertions |
| Integration | Per-transaction fiscal guard: batch spanning two periods, one locked ⇒ whole abort | Two-period fixture |
| Integration | Concurrency: two parallel reverts ⇒ exactly one winner, loser returns `already-reverted` | `Promise.all` on real DB |
| Integration | `action=apply` creates record (no journal); classification-only revert clears only GL fields | Route + DB assertions |
| E2E | API: apply-all → rollback → re-apply (fresh record, fresh journal IDs) | Route-level flow |

## Migration / Rollout

Requires a schema migration adding the durable record (new model + relations) — deferred to implementation. No backfill of legacy runs (out of scope, spec:160-182); only new applies produce records. No feature flag required; rollout is additive.

## Architectural Decision: 1-Table Model (Resolved)

After evaluating alternatives (join table N:M, reuse AuditLog, reuse JournalEntry, no persistence), the architecture settled on **1 table + FK directa**:

- `RuleApplyRecord` as the sole durable table (execution header).
- `BankTransaction.ruleApplyRecordId` nullable → points to the ACTIVE apply record.
- `JournalEntry.ruleApplyRecordId` nullable → points to the ACTIVE apply record when a journal exists.
- Re-apply overwrites FKs to the new record; old record's transaction/journal links are lost.
- Historical audit trail is preserved via `AuditLog` events (RULE_APPLIED, RULE_REVERTED).
- BRE-013 does NOT guarantee relational navigation from a reverted record to its original transactions after re-apply.
- Classification-only `action=apply` creates a `RuleApplyRecord` even without a journal.

**Rejected alternative**: join table `RuleApplyRecordItem` — adds schema complexity for historical relational navigation that no current business process requires. Re-open if a concrete forensic query demand emerges.

## Open Questions (Resolved)

- [x] Physical schema: `RuleApplyRecord` model with FKs on `BankTransaction` and `JournalEntry` (1-table model).
- [x] `idempotencyKey` gets a `@unique` constraint (retry guard).
- [x] Physical cardinality: FK nullable on BankTransaction and JournalEntry (1:N per active record).
- [x] Simulation coexistence: `/api/bank-rules/simulate` coexists with `/api/learning/rules/simulate`. The former is the faithful BRE-013 simulation over the real matcher (`simulateApply` → `matchTransactions`); the latter remains the legacy conditions simulator. Neither route is replaced or removed in this slice (implemented and validated in 3.2).
- [x] Bulk performance cap: documented as the **current implemented cap** — `MAX_PER_BATCH = 200` is the single source of truth enforced by `parseSimulateLimit` and the batch limit. This is NOT a definitive future-scalability decision; chunking / resumable execution strategies are explicitly out of scope for this slice.
