# Delta for rule-simulation-and-rollback

New behavior domain for BRE-013 (`bre-013-rule-simulation-rollback`). Introduces the durable-apply anchor, the rollback/compensation contract, the simulation contract, and the fiscal-period safety correction for the rule application and reversal behavior of the BankRules engine. There is no pre-existing main spec for this domain, so this is a full NEW spec written as a delta on an empty baseline.

Provenance: `bre-013-rule-simulation-rollback` `01-explore.md` §3 (mutation inventory), §8 (compensation vs rollback), `02-proposal.md` §3 Decision 1–7 (binding contract), §4 (simulation contract), §5 (conceptual durable record + state machine), §6 (apply/revert transactional contracts), §9 (out of scope).

## ADDED Requirements

### Requirement: Simulation is read-only and faithful to the apply engine

Simulation MUST NOT write transactions, journals, balances, or audit events, and MUST NOT create durable apply records. It MUST reuse the same matching/resolution logic and the same eligibility filter (`glAccountId`, `matchedRuleId`, `journalEntryId` null and `isReconciled=false`, per `transaction-invariants.ts`) as a real apply, so the forecast matches the classification the apply would produce. For the same inputs, rules, configuration, and data snapshot, the same simulation MUST yield the same semantic result with a deterministic canonical ordering; changes to the underlying data between a simulation and a subsequent apply MAY alter the outcome. Simulation MUST NOT guarantee ledger accounting accuracy (postings, journal lines, balances are NOT predicted); a full accounting dry-run is out of scope. (Provenance: proposal §4.)

#### Scenario: Simulation produces no side effects

- **GIVEN** a rule set and a set of unreconciled transactions eligible under the apply filter
- **WHEN** the user runs a simulation over them
- **THEN** no `JournalEntry`, `JournalLine`, `GlAccount.balance`, `BankTransaction` classification, audit event, or durable apply record is created or modified
- **AND** the returned classification forecast is identical to what the real apply engine would select

#### Scenario: Simulation is reproducible

- **GIVEN** the same rules, configuration, and data snapshot
- **WHEN** the simulation runs twice
- **THEN** both runs return the same semantic result with a deterministic canonical ordering
- **AND** an intervening data change between a simulation and a later apply MAY produce a different outcome, so the simulation does not promise to match a future apply

#### Scenario: Simulation refuses to claim accounting accuracy

- **GIVEN** a simulated match that will produce a posted journal
- **WHEN** the simulation returns its forecast
- **THEN** the result documents that postings, journal lines, and resulting balances are NOT simulated or guaranteed

### Requirement: A durable record anchors every covered application

BRE-013 MUST NOT rely on `AuditLog.entityId` as the permanent anchor for reversal. Every covered apply (batch apply, single apply routed through `executeApplyAll`, and individually applied actions linkable to the durable record + transactional contract) MUST be anchored by a durable apply record that: identifies a single execution; relates the affected transactions and the generated journals; records origin, single rule, user, and date; tracks lifecycle state; supports idempotent retry; and supports auditable reversal. (Provenance: proposal §3 Decision 3 & §5.) The record MUST distinguish this multiset of capabilities from any transient `batchId`.

#### Scenario: an apply creates exactly one anchored record

- **GIVEN** a batch apply executes successfully through `executeApplyAll`
- **WHEN** the apply transaction commits
- **THEN** exactly one durable apply record exists, referencing the classified transactions and the generated journals, with origin, user, date and state=`applied`

#### Scenario: an anchored record supports reversal

- **GIVEN** a durable apply record in state `applied`
- **WHEN** a revert is requested
- **THEN** the revert finds its affected transactions and journals THROUGH the durable record, and the reversal is recorded against it

Note: the physical name (`ApplyBatch`/`RuleApplication`/`RuleExecution`), column set, nullability, indexes, physical cardinality and representation of its relations to transactions and journals, and concurrency strategy for this record are OPEN and carried to design; this requirement fixes capability and that the record relates an execution to its affected transactions and journals, not schema or physical cardinality.

### Requirement: Rollback scope is dual — accounting when a journal exists, else classification-only

When an applied transaction has a generated journal entry, a rollback MUST revert classification fields (`glAccountId`, `matchedRuleId`) AND void the linked `JournalEntry` (status→`void`), recalculate the affected `GlAccount` balances, and unlink the journal from the transaction (`journalEntryId`, `journalLineId`→`null`). When no journal was generated, the rollback MUST revert only `glAccountId` and `matchedRuleId` and clear associated links. A rollback MUST NEVER leave an orphan journal entry and MUST NEVER break double-entry parity. (Provenance: proposal §3 Decision 1, §6.)

#### Scenario: Rollback of a journaled transaction fully compensates the ledger

- **GIVEN** a transaction initially applied with a posted journal entry, debit and credit accounts affected
- **WHEN** the user rolls back that transaction
- **THEN** the linked `JournalEntry` is set to `void`, both affected `GlAccount.balance` values are recalculated from posted lines, and `journalEntryId`/`journalLineId` are nulled, with no dangling journal remaining

#### Scenario: Rollback of a classification-only transaction

- **GIVEN** a transaction applied by single-rule `action=apply` that generated no journal
- **WHEN** it is rolled back
- **THEN** only `glAccountId` and `matchedRuleId` are cleared and any associated links nulled, and no journal is created or touched

### Requirement: Compensation is a void, never a destructive delete, in open periods

Single-slice compensation MUST soft-reverse via voiding the `JournalEntry`. It MUST NOT hard-delete `JournalEntry`/`JournalLine` rows in normal flows, and MUST NOT introduce reversing entries or a `reversalOfId` mechanism. Compensation MUST be limited to open periods: a void MUST be rejected when its affected transactions fall in a closed or locked period. (Provenance: proposal §3 Decision 2.)

#### Scenario: Void keeps accounting history and balance

- **GIVEN** a posted journal linked to a rolled-back transaction in an open period
- **WHEN** the journal is compensated
- **THEN** the `JournalEntry` status is updated to `void` (rows retained), its lines belong to its parity, and the derived GL balances drop its effect; no physical row is deleted

#### Scenario: Void is rejected in a closed period

- **GIVEN** a rolled-back transaction whose date falls in a closed or locked fiscal period
- **WHEN** a void compensation is attempted
- **THEN** the entire rollback is rejected and no classification or journal change is persisted

#### Scenario: No reversing entry is created in this slice

- **GIVEN** any open-period void compensation
- **WHEN** the journal is voided
- **THEN** no `reversalOfId` is written and no reversing entry exists; the original entry is only voided

### Requirement: Apply and rollback are atomic; never partially persisted

Each covered apply MUST run in a single atomic transaction such that either everything persists together or nothing persists: the durable record is only observable when the entire apply succeeded, and no classification, journal, balance, relation, audit event, or state change attributable to the operation is ever partially visible. Rollback MUST likewise be all-or-nothing: either the reversal fully completes (journals voided, balances recalculated, transactions unlinked, state finalized to `reverted`, compensation audit event written) or nothing of the operation persists, leaving the durable record in `applied`. Transactions MUST progress only `applied → reverting(transient) → reverted`, or roll back to `applied` on failure. The `reverting` state MUST NOT be a persistent or durable exclusion mechanism, and MUST NOT include a `partially_failed` state. (Provenance: proposal §5 statemachine, §6.)

#### Scenario: Commit is all-or-nothing for apply

- **GIVEN** an apply that classifies transactions, generates journals, recalculates balances, and records a durable record inside one transaction
- **WHEN** any step in the transaction fails
- **THEN** the transaction rolls back, no durable record exists, and no transaction exhibits a partial classification/journal/balance/audit state attributable to the operation

#### Scenario: Commit is all-or-nothing for rollback

- **GIVEN** a rollback transaction where a subsequent step fails after a journal has been voided
- **WHEN** the transaction fails
- **THEN** the whole transaction rolls back, the batch remains `applied`, and no compensation is partially persisted

#### Scenario: The concurrency exclusion mechanism is left open

- **GIVEN** two concurrent rollback requests against the same `applied` batch
- **WHEN** both attempt to revert simultaneously
- **THEN** exactly one succeeds (the winner), the loser observes the state already `reverted`, and the record remains consistent — through an atomic and verifiable mechanism chosen in design (state-guarded update, row lock, or optimistic versioning), any of which MAY be used

### Requirement: Fiscal period guard applies per-transaction

Any apply that produces accounting effect MUST validate the fiscal period, inside the same transaction. A rollback/void MUST be rejected if any affected transaction is in a closed or locked period. The system MUST NOT reopen periods or bypass the guard. Because a batch may span multiple periods, period validity MUST be evaluated per transaction-date, not as a single batch-level value. If ANY target transaction of an apply or ANY transaction related to the durable record in a rollback belongs to a closed or locked period, the ENTIRE apply or rollback MUST abort with no partial apply or reversion of any subset. (Provenance: proposal §3 Decision 4, §6.)

#### Scenario: A single batch spanning two periods aborts wholly on a locked period

- **GIVEN** a batch containing transactions in two fiscal periods, one active and one locked
- **WHEN** the batch applies
- **THEN** period validation is evaluated per transaction date, the presence of the locked-period transaction causes the ENTIRE apply to abort, and no subset of transactions is applied while another is skipped
- **AND** no period is reopened

#### Scenario: Rollback aborts wholly when any transaction is in a closed period

- **GIVEN** a revert request whose durable record relates any transaction in a closed/locked period
- **WHEN** the rollback is attempted
- **THEN** the ENTIRE rollback is rejected and none of its transactions are reverted, and the period guard is never bypassed

### Requirement: Re-apply and idempotency for covered actions

A already-`reverted` batch MUST NOT be reverted again. Retrying the same revert command MUST be idempotent: it returns success/current state and performs no re-compensation. A restored transaction that is re-applied MUST create a new durable record and new journal IDs, never reusing previous IDs. Technical retries MUST NOT duplicate journals or effects. (Provenance: §3 Decision 6, §6.)

#### Scenario: Reverting an already-reverted batch is a no-op

- **GIVEN** a batch already in state `reverted`
- **WHEN** the revert is requested again
- **THEN** the revert command returns success reflecting the current `reverted` terminal state and no journal is re-voided and no balance is re-recalculated

#### Scenario: A re-applied transaction starts fresh

- **GIVEN** a rolled-back transaction is back in the unmatched pool
- **WHEN** it is re-applied by a rule
- **THEN** apply creates a new durable record and new journal IDs, and no duplicate journals or effects from the prior run appear

### Requirement: Rollback is unidirectional and append-only

A reversal MUST create a new audit event (e.g., `RULE_REVERTED` / void record) and MUST NOT rewrite, delete, or revert a previous event in normal flows; there is no rollback-of-a-rollback. The admin company purge exception is external to BRE-013. (Provenance: §3 Decision 7.)

#### Scenario: Reversal appends a new audit and preserves history

- **GIVEN** a previously applied transaction with a `RULE_APPLIED` event
- **WHEN** it is rolled back
- **THEN** a distinct `RULE_REVERTED`/compensation action is appended, and the original applied event is left unchanged

#### Scenario: No rollback-of-rollback is defined

- **GIVEN** a batch in `reverted` state
- **WHEN** the rollback is re-requested
- **THEN** no reversing audit is produced (the rule guard rejects it) and the history remains append-only

### Requirement: Coverage — batch/single covered, import/reconciliation excluded

BRE-013 MUST support reversal of batch apply (`/api/bank-rules/apply-all`) and single apply routed through `executeApplyAll` plus individually applicable actions. It MUST NOT support reintroduction or move of import-time classification, auto-reconciliation, retroactive migration of legacy executions, reconciliation-state rollback, or full import rollback. Single-rule `action=apply` is DECIDED as in-scope for the first slice: because it generates no journal, its reversal is classification-only; to honor the durable-anchor invariant it MUST create a durable apply record, even though it creates no journal. The system MUST NOT leave this integration unresolved and MUST NOT force an artificial unification with the journaled path. (Provenance: §3 Decision 5, §9.)

#### Scenario: In-scope reversals honor the durable record

- **GIVEN** a batch apply plus an individually applied action
- **WHEN** either is rolled back
- **THEN** it is reversed under the durable record and transactional contract as required by the durable-anchor requirement

#### Scenario: Out-of-scope origins are not reversed

- **GIVEN** a transaction classified by an import or by auto-reconciliation against the durable record
- **WHEN** the rollback is invoked
- **THEN** the action is not the topic of the durable reversal path and the import/reconciliation classification remains, per scope

#### Scenario: Classification-only single-apply creates a durable record

- **GIVEN** a single-rule `action=apply` that generated no journal
- **WHEN** it is applied and later rolled back
- **THEN** the apply creates a durable apply record (no journal), the rollback clears `glAccountId` and `matchedRuleId` and associated links as classification-only, and no journal is created or touched
- **AND** the reversal remains anchored to the durable record rather than left as an unresolved half-state

## Out of scope

Imports, auto-reconciliation, UI, reversing entries, closed-period compensation, resumable/chunked rollback (`partially_failed`), and a full accounting dry-run are out of scope for this slice. (Provenance: proposal §3, §9.)

## Open decisions

Carried to `sdd-design`; the spec does not constrain them:

1. ~~Durable apply record concrete name (`ApplyBatch`/`RuleApplication`/`RuleExecution`) and physical schema.~~ **Resolved**: `RuleApplyRecord`, 1-table model with FKs on `BankTransaction` and `JournalEntry`.
2. ~~Physical cardinality and representation of the record's relations to transactions and journals, nullability, and indexes.~~ **Resolved**: FK nullable on BankTransaction and JournalEntry. No join table. Re-apply overwrites FKs; history via AuditLog.
3. Concurrency-exclusion mechanism (atomic `UPDATE ... WHERE state = 'applied'`, row lock, or optimistic versioning).
4. Whether simulation replaces or coexists with `/api/learning/rules/simulate`.
5. Closed-period compensating-by-reversing as a replication note: explicitly out of scope here, `reversalOfId` deferred.
6. Bulk batch performance limits and idempotency-key strategy for revert retries.

## Architectural Note: 1-Table Decision

The durable apply record is a single table `RuleApplyRecord`. FKs on `BankTransaction` and `JournalEntry` point to the currently active record. Re-apply overwrites these FKs. Historical audit trail is preserved via `AuditLog` events, not via relational navigation from old records. This decision was validated by demonstrating that no business process requires querying which transactions were affected by a specific reverted execution after those transactions have been re-applied. If such a process emerges, it should be opened as a separate change with concrete business evidence.
