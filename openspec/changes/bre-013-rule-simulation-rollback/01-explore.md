# Explore — BRE-013 Rule Simulation and Rollback Safety

- **Change**: BRE-013 Rule Simulation and Rollback Safety
- **Date**: 2026-08-03
- **Base commit under exploration**: 257c194 → decf75d (HEAD at decf75d, clean tree)
- **Artifact store**: openspec (file-based)

---

## Change: BRE-013 Rule Simulation and Rollback Safety

## Problem

The system has read-only `preview` and `simulate` routes but **no rollback/compensation** for incorrectly applied bank rules. Concretely:

- `src/app/api/bank-rules/apply-all/preview/route.ts` is read-only: it only estimates totals via `matchTransactions` (estimated transaction counts, `totalAmount`, `remaining`) — it never predicts GL/journal effects.
- `src/app/api/learning/rules/simulate/route.ts` only evaluates *conditions* against unreconciled transactions in memory — it ignores precedence, transaction-direction, and GL setup.
- There is no mechanism to reverse a rule-generated classification or its journal entries.
- The only existing `rollback` route is `src/app/api/learning/auto-assignments/[id]/rollback/route.ts`, which is unrelated to BankRules (it only reverts an auto role-assignment context).

A user can mis-apply a rule (wrong GL account, wrong precedence winner, or a mistake from a forced single-apply), and there is no safe, auditable way to undo it without corrupting accounting history or audit.

## Current State (how rule application works today)

### Entry points that mutate data

1. **Apply All (batch)** — `src/app/api/bank-rules/apply-all/route.ts`
   - Calls `executeApplyAllUseCase` (`src/lib/services/apply-all-use-case.ts:456`).
   - Batch path: `matchTransactionsWithShadow` (matching + shadow) → `evaluatePolicy` (S7-07/S7-11 enforcement gate: `CONFIRM`/`BLOCK`) → `db.$transaction(executeApplyAll)` → `persistShadowSummaryBestEffort` → optional `OPERATIONAL_POLICY_OBSERVATION` audit.
   - Single (mode='single') path: `executeSingleUseCase` (`apply-all-use-case.ts:426`) validates `verifyNotAlreadyApplied` and `verifyPeriodNotLocked`, then applies.

2. **Single rule "apply" action** — `src/app/api/bank-rules/[id]/route.ts:389` (`POST ...?action=apply`)
   - Calls `assertActiveFiscalPeriod` for each matched tx date (`[id]/route.ts:442`), then in a `$transaction` sets `BankTransaction.glAccountId` + `matchedRuleId` and writes a `RULE_APPLIED` AuditLog. Note: **this path does NOT create journal entries.**

3. **Import classification** — `src/lib/services/import.service.ts:498` (`importTransactions`)
   - Creates `BankStatement`, creates `BankTransaction` rows with `glAccountId`/`matchedRuleId` resolved by `resolveImportRule`, then `JournalEntryService.createFromBankTransaction` for each auto-classified tx, then `recalculateBalances` on the `BankAccount`. Writes `RULE_PRECEDENCE_SHADOW_SUMMARY` and `OPERATIONAL_POLICY_OBSERVATION` AuditLogs.

4. **Auto-reconciliation** — `src/app/api/reconciliation/auto/route.ts` (approx 202-249): updates `BankTransaction` (`glAccountId`, `isReconciled`, `matchedRuleId`, `reconciledAt`, `reconciliationPeriodId`) and creates posted journal entries for rule-matched txs; guarded by `assertActiveFiscalPeriod`.

### The mutation core: `executeApplyAll` (`src/lib/services/apply-all-engine.ts:358-468`)

Within a Prisma transaction it:
- Loads GL identities per rule (`BankRule.debitGlAccountId || glAccountId`, `creditGlAccountId || glAccountId`).
- `bankTransaction.updateMany` sets `{ glAccountId, matchedRuleId }` for debit and credit txs (`apply-all-engine.ts:406-421`).
- Reads those matched txs where `glAccountId != null AND journalEntryId == null` (`:424-427`).
- For each, `JournalEntryService.createFromBankTransaction` (`:451-459`).
- Discovers the bank's GL per statement (`bankGlByStatement`) and doubles the batches by splitting debit/credit.

### The journal creation core — `JournalEntryService.createFromBankTransaction` (`src/lib/services/journal-entry.service.ts:18`)

Inside the same transaction, for each bank tx it:
1. Inserts a `JournalEntry` (status **'posted'**, description `Bank: ...`) with two `JournalLine` rows (`debit`/`credit` split based on deposit/withdrawal).
2. Sets `BankTransaction.journalEntryId` to the new entry id (`journal-entry.service.ts:58-62`).
3. `recalculateBalance` for both affected `GLAccount.balance` (`journal-entry.service.ts:64-66`): `balance = debit-normal ? SUM(debit) - SUM(credit) : SUM(credit) - SUM(debit)` over *posted* lines only (`journal-entry.service.ts:76-108`).

### Audit log writes by a rule application

- `RULE_APPLIED` (`bank-rules/[id]/route.ts:480`)
- `RULE_AMBIGUITY_RESOLUTION` (`apply-all-use-case.ts:403-416`)
- `RULE_PRECEDENCE_SHADOW_SUMMARY` (`rule-precedence-shadow.ts:349`, via `audit.ts` `createAuditLogWithRetry`)
- `OPERATIONAL_POLICY_OBSERVATION` (`apply-all-use-case.ts:222`, import.service.ts:780)
- `RuleExecutionAudit` (`src/lib/rule-engine/audit.ts:12`) when the adapter/v2 engine is enabled (`src/lib/rule-engine/index.ts:84`). Not written by the current precedence engine path.

The **preview** route (`/api/bank-rules/apply-all/preview`) and the **simulate** route (`/api/learning/rules/simulate`) are both read-only and write nothing.

## Affected Areas (file:line)

- `src/app/api/bank-rules/apply-all/route.ts` — POST handler; orchestrates batch apply; returns `EXECUTED | CONFIRMATION_REQUIRED | BLOCKED`.
- `src/lib/services/apply-all-use-case.ts` — orchestrator of matching + policy gate + apply transaction + audits.
- `src/lib/services/apply-all-engine.ts` — `matchTransactions` (preview), `matchTransactionsWithShadow` (shadow), `executeApplyAll` (all mutations).
- `src/lib/services/rule-precedence-apply-all-resolver.ts` — winner resolution per transaction (adapter vs legacy).
- `src/lib/services/rule-precedence-import-resolver.ts` — import-time resolution (`resolveImportRule`).
- `src/lib/services/import.service.ts` — import classification + journal creation + `AssetDefinition.recalculateBalances`.
- `src/app/api/bank-rules/[id]/route.ts` — single-rule apply + `RULE_APPLIED` audit.
- `src/lib/services/journal-entry.service.ts` — journal/lines/balance mutations and `recalculateBalance`.
- `src/app/api/journal/[id]/route.ts` — existing 'void'/'post' journal actions (230-327) that assert fiscal period and recalc balances.
- `src/lib/fiscal-period-guard.ts` — `assertActiveFiscalPeriod`.
- `src/lib/services/transaction-invariants.ts` — the eligibility filter (`glAccountId = null`, `journalEntryId = null`, `matchedRuleId = null`, `isReconciled = false`).
- `src/lib/operational-policy/*` — policy evaluation (S7-07) and apply-all/importer observers (S7-08); drives enforcement gating (S7-11).
- `prisma/schema.prisma` — models mutated: `BankTransaction` (185), `BankRule` (245), `GlAccount` (111), `JournalEntry` (293), `JournalLine` (311), `FiscalPeriod` (327), `AuditLog` (340), `RateExecutionAudit` (274), `BankAccount` (140), `BankStatement` (164).

## Data Mutation Inventory (classify each)

A single rule apply (regardless of origin) can mutate:

1. **`BankTransaction.glAccountId`** — set. Reversible (with guard).
2. **`BankTransaction.matchedRuleId`** — set. Reversible.
3. **`BankTransaction.journalEntryId`** — set (unique). Requires void+unlink to reverse.
4. **`BankTransaction.journalLineId`** — set (unique); companion to the journal line.
5. **`JournalEntry` row** (status='posted') — created. Void-compensable.
6. **Two `JournalLine` rows** — created per entry. Cascade-deleted with the entry, or remain if voided.
7. **`GLAccount.balance`** — recomputed (`recalculateBalance`) for the debit and credit accounts. Reversible by re-running `recalculateBalance` after void/delete.
8. **`AuditLog`** — appended; **immutable** (append-only, never reverted). Appending a compensation log is the accepted approach.
9. **`RuleExecutionAudit`** — appended (adapter mode only). Irreversible/append-only.
10. (Import path) **`BankStatement`**, **`BankTransaction` rows**, **`BankAccount.balance/initialBalance`** (`ImportService.recalculateBalances`).
11. (Auto-reconciliation path) **`BankTransaction.isReconciled/reconciledAt/reconciliationPeriodId`** and **`ReconciliationPeriod.transactionCount`**.

### Classify each

| Mutation | Classification | Notes |
|---|---|---|
| `BankTransaction.glAccountId / matchedRuleId` | **Reversible** (classification-only undo) | Only if the tx hasn't been re-applied/reconciled; requires the tx to be re-eligible. |
| `BankTransaction.journalEntryId/journalLineId` | **Compensable** (void + unlink) | Existing `journal/[id]` 'void' path sets status only and **does not** unlink the bank tx. A rollback must also null the link. |
| `JournalEntry` + `JournalLine` rows | **Compensable** | Either void (soft) or delete (hard) + recalc balance. Never legally reapply while the entry is pending. |
| `GLAccount.balance` | **Compensable** | Recompute via `recalculateBalance` after void/delete. |
| `AuditLog`, `RuleExecutionAudit` | **Irreversible / append-only** | Never delete or mutate; a rollback itself must be a new AuditLog row. |
| Import artifacts ($Statement, $Transaction rows, bank balance) | **Irreversible in practice** (import is the source of truth) | Reverting an import is out of the rule-safety scope. |
| Reconciliation (`isReconciled`, `matchedRuleId`, journal) — rule-matched | **Partially reversible but coupled** | Requires joint rollback of reconciliation state + journal. Different origin, shared mutation set. |

## Flow map (with file:line)

```
GET /api/bank-rules/apply-all/preview  (READ-ONLY)
  └ matchTransactions (apply-all-engine.ts:324) → executeMatching (126)
      └ resolveApplyAllRule per tx (rule-precedence-apply-all-resolver.ts:118)
POST /api/learning/rules/simulate  (READ-ONLY)
  └ condition-only matcher on unreconciled txs (simulate/route.ts:100)

POST /api/bank-rules/apply-all  (batch | single)
  └ apply-all-use-case.ts:456
      ├ matchTransactionsWithShadow (apply-all-engine.ts:334)
      ├ evaluatePolicy → EnforcementResult (apply-all-use-case.ts:129)   [S7-11 gate]
      ├ db.$transaction(executeApplyAll)  (apply-all-engine.ts:358)     <- ALL mutations
      │      ├ BankTransaction.updateMany (glAccountId, matchedRuleId)  (406-421)
      │      └ JournalEntryService.createFromBankTransaction (451)      <- JE+lines+balances
      ├ persistShadowSummaryBestEffort (497-505)                        <- AuditLog
      └ observePolicy / persist OPERATIONAL_POLICY_OBSERVATION (512-535) <- AuditLog
      (single mode) additionally: RULE_AMBIGUITY_RESOLUTION AuditLog (403)

POST /api/bank-rules/[id] action=apply   (single rule, no JE)
  └ bank-rules/[id]/route.ts:389
        └ assertActiveFiscalPeriod → BankTransaction.updateMany → RULE_APPLIED AuditLog

POST /api/import/...  → ImportService.importTransactions (import.service.ts:498)
        └ resolveImportRule (rule-precedence-import-resolver.ts:122)
           + BankStatement/BankTransaction.createMany + createFromBankTransaction loop
           + ImportService.recalculateBalances (630) + shadow/policy AuditLogs

Auto-reconciliation
  └ reconciliation/auto/route.ts → BankTransaction.update … + journalEntry.create (posted)
```

## Simulation vs Rollback vs Compensation vs Preview

- **Simulation (S7-? )** — `learning/rules/simulate`: a calculator of condition matches. It does not run the real resolver (precedence, direction, GL), and it returns sample transactions only. It is *organic*, in-memory, and not a reliable forecast of actual classification.
- **Preview (bank-rules/apply-all/preview)** — uses the real `matchTransactions` engine against real active rules and precedence; returns matched-rule counts, totals, and `remaining`. It does **not** reflect GL accounts, journal lines, or balances. It is a forecast, not a dry-run of the ledger effects.
- **Rollback** — what BRE-013 is fundamentally about: revert an applied rule's effects on `BankTransaction` back to the pre-apply, unmatched state (i.e., glAccountId + matchedRuleId + journalEntryId all null). Corresponds to restoring the state *without* touching history for auditability.
- **Compensation** — when a rule has posted a `JournalEntry`, a true "reverse" of a classification in an accounting system must **void or reverse** the journal (never silently delete), recompute `GLAccount.balance`, and add an audit record. Compensation preserves the accounting ledger; a plain "rollback" of the classification would leave a dangling posted journal. These are two sides of the same correctness guarantee.

In this codebase: **Preview** = read-only matched preview. **Simulate** = raw condition tester. **Rollback** = classification-state revert (safe, no audit history mutation). **Compensation** = void/restore the journaled accounting effect + balance + audit. A complete undo solution must combine both Compensation and Rollback semantics, and must never mutate the immutable AuditLog.

## Relationship analysis

- **S7-05b Shadow Metrics** — read-only aggregator over AuditLog `RULE_PRECEDENCE_SHADOW_SUMMARY` from Import/Apply All. Provides divergence/confidence signals that *inform* whether an apply should be confirmed (S7-07 policy). Not a design or rollback mechanism. A rollback must NOT depend on shadow-metrics health, but it can use the same AuditLog store for provenance.
- **S7-07 Operational Policy Service** — consultative (`ALLOW|WARN|CONFIRM|BLOCK`), now enforced in the apply-all use case (S7-11 `evaluatePolicy`, `apply-all-use-case.ts:129`). It can block/confirm applies. Rollback does not need policy evaluation, but a rollback of a *confirmed* apply should itself carry a confirmation if the period is POSTED (to avoid undermining S7-11).
- **`rule-precedence-apply-all-resolver`** — winner determination per tx; defines which rule and which GL a revert must void. Not mutating.
- **`apply-all-engine` / `matchTransactions`** — read-only matching for preview; `executeApplyAll` is the single mutation funnel all applies pass through. This is the natural choke point for a future "apply batch" anchor (currently there is no durable apply-batch linkage — `batchId` is only the shadow AuditLog entityId).
- **Period locks** — `assertActiveFiscalPeriod` (`fiscal-period-guard.ts`) is enforced on journal post/void, single-rule apply, and auto-reconciliation; **it is MISSING from the batch apply path** (`executeApplyAll` in `apply-all-engine.ts` never calls it). The single mode uses a separate `verifyPeriodNotLocked` (`apply-all-use-case.ts:324`). This inconsistency means a batch apply may post transactions into a locked period — a critical rollback/compliance concern.
- **Journal entries** — created only via `JournalEntryService.createFromBankTransaction`; `recalculateBalance` recomputes from *posted* lines only, so voiding an entry naturally drops its effect on balances. A rollback can reuse this.

## Risks & Invariants matrix

| Invariant / Risk | Status | Mitigation needed |
|---|---|---|
| A bank tx becomes matched/classified **once** (eligibility filter: `isReconciled=false, isIgnored=false, journalEntryId=null, matchedRuleId=null, glAccountId=null`) | Strong for apply; broken by compensation if the tx is re-classified after a partial revert. | Rollback must then non-idempotent; re-apply of the same rule must yield a safe, distinct journal. |
| Double-entry parity: **posted** entries always have balanced debit == credit. | Ensured at authoring (`2 lines` each). A hard-delete must delete all lines atomically. Voiding keeps parity (entry stays but excluded from balances). | Prefer void + recalc, not delete. |
| GL balance is derived (aggregate of posted lines). | Recomputable deterministically. | After any rollback/clean unknown, run `recalculateBalance` on the two affected GL accounts. |
| AuditLog (incl. shadow + policy + rule audits) is append-only. | Cannot be rolled back; must be preserved. | Rollback = new audit record (`RULE_REVERTED` / `JournalEntry` void log). Manual reversal of audit data must never be allowed. |
| A transaction can belong to a number of classification & journaling domains (import, reconciliation, apply-all). | Applying the same (e.g., reconciliation auto) sets `isReconciled`. | Rollback must reject reverting txs that are `isReconciled=true` or linked to a non-rule journal (PostM movement). |
| Period-lock coverage is inconsistent (missing on batch apply). | — | Before a rollback/compensation path ships, enforce fiscal-period guard on apply AND on any void in a locked period (mirror of `journal/[id]` 'void'). |

## Abort conditions (conditions that would abort an apply — current behavior)

- **`matchResult` empty** applies nothing (`apply-all-use-case.ts:473`).
- **Policy gate `BLOCKED`** → no apply (`apply-all-use-case.ts:484-490`).
- **`CONFIRMATION_REQUIRED`** without user `confirmed` → no apply.
- **Single mode** validators: `NOT_FOUND`, `RULE_INACTIVE`, `RULE_NOT_CANDIDATE`, `TRANSACTION_ALREADY_MATCHED` (`journalEntryId != null`, `verifyNotAlreadyApplied`), `PERIOD_LOCKED` (`verifyPeriodLocked`), timeout/exception from `applyAllEngine`.
- **Single-rule apply** missing where GL account GL missing → the apply still sets classification but (any write of a journal is skipped when tx has no bank GL mapped).
- Abort note: The **batch apply path currently does not call `assertActiveFiscalPeriod`**; this is a gap, not an enforced abort.

### Additional abort candidates to design later (for rollback)
- A tx is `isReconciled=true` → abort the revert.
- A tx is in an untouched immutable AuditLog → keep history, only add compensation log.
- Target period is locked → abort unless compensation path accepts.

## Blocking business questions (must be answered before a solution can be proposed)

1. **Rollback scope**: must a revert undo only the classification (`glAccountId`/`matchedRuleId`) or also the posted journal entry + balance? These need two distinct semantics (classification-only rollback vs accounting compensation).
2. **Journal compensation form**: For reverted posted entries, should we **void** (soft, keep lines, ex-cluded from balance) or **hard-delete** (cascade lines) or create a proper **reversing entry**? Voiding is existing behavior and balances immediately; deleting is more destructive; reversing is period-correct `/Account` but adds columns.
3. **Forensic integrity**: must we allow deletion of any posted journal during a revert, or must all reverts of posted entries be via a compensating entry so the original is never lost? (This changes data model: add `reversalOfId`.)
4. **Period-lock interaction**: Can a user revert a rule applied in a **closed/locked fiscal period**? Current `journal/[id]` 'void' is also guarded by `assertActiveFiscalPeriod`. Do we allow voiding a locked period (needs a justification) — and should apply itself also enforce `assertActiveFiscalPeriod` (missing today in batch)? 
5. **Revert anchoring**: How is a revert scoped — by a single rule, by a date window, by a specific list of transactions, or by a durable **apply-batch**? Today there is **no durable batch record** (only a random `batchId` used as an AuditLog `entityId`). This is the biggest blocker for a "revert last apply" feature.
6. **Re-apply idempotency**: After a revert, if a rule is re-applied to the restored txs, must it reproduce the identical journal entries and no duplicate? (The eligibility filter must be satisfied again.)
7. **Audit of the audit**: Should a revert be reversible too, or one-directional? Do we guard against a "cat and mouse" of double undo?
8. **Which apply origins**: Should rollback cover batch/single apply, single-rule `action=apply` (no journal anyway), import-time classification, and auto-reconciliation rule matches? They all write the same journal/classification path but have different anchors and side effects.

## Evidence vs Inference matrix

Separates verified facts (direct repository evidence), inferences (conclusions drawn from evidence), and assumptions (design hypotheses not yet established by either). Anything marked Inference or Assumption is open to challenge before design.

| Finding | Direct evidence | Inference | Assumption | Level |
|---|---|---|---|---|
| Batch apply has no durable model (batchId is only an AuditLog entityId) | ✅ `apply-all-engine.ts:350` (`apply-all-${crypto.randomUUID()}`); no Batch model in `prisma/schema.prisma` | — | — | Fact |
| `assertActiveFiscalPeriod` does not participate in the batch apply path | ✅ Not imported in `apply-all-engine.ts` / `apply-all-use-case.ts` (imports only in bank-rules/[id], journal/[id], journal.service, reconciliation) | — | — | Fact |
| Single mode guards the period (`verifyPeriodNotLocked`) | ✅ `apply-all-use-case.ts:324`, used at :437 | — | — | Fact |
| Journal `void` does not clear `bankTransaction.journalEntryId` | ✅ `journal/[id]/route.ts:281-327` updates only `status: 'void'` | — | — | Fact |
| `recalculateBalance` recomputes balance from posted lines | ✅ `journal-entry.service.ts:76`, invoked at :65-66 and void route :314-316 | — | — | Fact |
| Eligibility filter requires glAccountId/matchedRuleId/journalEntryId null, unreconciled | ✅ `transaction-invariants.ts:3-17` | — | — | Fact |
| AuditLog is normally append-only | ✅ `audit.ts:18` create-only in rule flows | — | — | Fact |
| AuditLog has an admin exception (`auditLog.deleteMany`) | ✅ `admin/companies/[id]/route.ts:141` (company purge) | — | — | Fact (qualifies previous row) |
| The missing batch period guard blocks safe rollback/compensation | — | ✅ No atomic path to identify/revert a batch without period enforcement | — | Inference |
| No durable batch record is the biggest blocker for "revert last apply" | — | ✅ Revert anchoring requires a durable apply identity | — | Design judgment |
| Void without unlinking leaves the bank tx in a journaled-but-voided state | — | ✅ The tx keeps `journalEntryId` pointing at a voided entry | — | Inference |
| All inspected batch/single apply paths currently invoke `executeApplyAll` | ✅ Single/apply-all routes call it (`apply-all-use-case.ts:398,493`) | — | — | Fact (qualified: only inspected paths) |
| Rollback will probably reuse `JournalEntryService` primitives | — | — | ✅ Design hypothesis; not established by exploration | Assumption |
| Ready for proposal | — | ✅ Blocking business questions must be answered first | — | Methodological decision |

## Out of scope (restated)

- Import statement deletion / data restore.
- Reversing a reconciliation period or its non-rule matches.
- `auto-assignments/[id]/rollback` (Entity role assignment).
- Any UI.
- Actual simulation as a full dry-run of ledger effects: the granularity here is that a reversal will reuse existing compensation primitives, but a **full accounting simulation** is a separate effort.

## Recommendation / readiness for proposal (methodological decision, not a fact)

Exploration fully mapped: **state mutated = `BankTransaction` (glAccountId, matchedRuleId, journalEntryId, journalLineId) + `JournalEntry` + 2 `JournalLine` + `GLAccount.balance` + AuditLog** (+ the apply paths side effects on `BankStatement`/`BankAccount`). The existing `JournalEntryService.recalculateBalance` and the `journal/[id]` 'void' action are the correct compensation primitives to reuse. See the `Evidence vs Inference matrix` above: which of these are verified facts vs. agent judgment.

The `sdd-propose` phase can proceed, **but it must first resolve the 8 blocking business questions above** — especially **#5 (durable apply-batch anchor)** and **#2/#3 (void vs delete vs reversing entry + period-lock)**, since they decide the data model and the safety contract. This readiness call is a **methodological decision** by the exploring agent, not a repository fact.
