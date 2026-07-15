# rule-engine-integration Specification

## Purpose

Define the adapter between Import Service and Rule Engine v2, gated by `RULE_ENGINE_V2_ENABLED`. The adapter handles type mapping, engine invocation, and decision mapping — returning `MatchResult` for the Import Service. It contains zero accounting logic.

## Requirements

### Requirement: Legacy flag-off behavior
When the flag is off, MUST delegate to `findMatchingRule()` with behavior identical to production.

#### Scenario: Flag OFF delegates to legacy
- GIVEN `RULE_ENGINE_V2_ENABLED=false` and a transaction ready for matching
- WHEN the import service processes the transaction
- THEN `findMatchingRule()` is invoked and the legacy path executes unchanged

### Requirement: Winner auto-applies with valid glAccountId
Engine returns `winner` with a valid `classification.glAccountId` — adapter MUST return the `MatchResult`; Import Service creates the journal entry.

#### Scenario: Winner with valid glAccountId
- GIVEN `RULE_ENGINE_V2_ENABLED=true` and engine returns `winner` with a valid `classification.glAccountId`
- WHEN the adapter processes the result
- THEN the adapter returns the result with full `classification` available downstream, and the Import Service creates the journal entry

### Requirement: Winner without glAccountId returns pending
Engine returns `winner` without a valid `classification.glAccountId` — including empty `classification: {}` or partial with only `entityId`/`category` — adapter MUST return `outcome: 'pending'` with the full classification preserved; Import Service persists with no journal entry.

#### Scenario: Winner without glAccountId
- GIVEN `RULE_ENGINE_V2_ENABLED=true` and engine returns `winner` without a valid `classification.glAccountId` (empty `{}` or partial without `glAccountId`)
- WHEN the adapter processes the result
- THEN adapter returns `outcome: 'pending'` with full classification preserved; Import Service persists `glAccountId=null`, `matchedRuleId=null`, no journal entry

### Requirement: Pending state contract
A pending transaction MUST have `glAccountId=null`, `matchedRuleId=null`, and no associated journal entry. This applies to: `ambiguous`, `no_match`, `engine_error`, and `winner` without `glAccountId`.

#### Scenario: Pending invariants
- GIVEN any engine result that produces a pending outcome
- WHEN the adapter returns the result
- THEN adapter returns `outcome: 'pending'`; Import Service persists `glAccountId=null`, `matchedRuleId=null`, no journal entry

### Requirement: Ambiguous returns pending
Engine returns `ambiguous` — adapter MUST return `outcome: 'pending'`; Import Service persists per the pending state contract.

#### Scenario: Ambiguous decision
- GIVEN `RULE_ENGINE_V2_ENABLED=true` and engine returns `ambiguous`
- WHEN the adapter processes the result
- THEN adapter returns `outcome: 'pending'`; Import Service persists (`glAccountId=null`, `matchedRuleId=null`, no journal entry)

### Requirement: No-match returns pending
Engine returns `no_match` — adapter MUST return `outcome: 'pending'`; Import Service persists per the pending state contract.

#### Scenario: No match
- GIVEN `RULE_ENGINE_V2_ENABLED=true` and engine returns `no_match`
- WHEN the adapter processes the result
- THEN adapter returns `outcome: 'pending'`; Import Service persists (`glAccountId=null`, `matchedRuleId=null`, no journal entry)

### Requirement: Engine error degrades without legacy fallback
Engine throws — adapter MUST catch, log warning, return `outcome: 'pending'`, and NOT call `findMatchingRule()`.

#### Scenario: Engine failure
- GIVEN `RULE_ENGINE_V2_ENABLED=true` and engine throws an exception
- WHEN the adapter processes the result
- THEN warning logged, adapter returns `outcome: 'pending'`; Import Service persists (`glAccountId=null`, `matchedRuleId=null`), and `findMatchingRule()` is called exactly zero times

### Requirement: Valid BankRule conditions transform
`BankRule.conditions` in a recognized v1-compatible format — adapter MUST normalize into the Rule Engine v2 input contract. If already in v2 format, MUST pass through unchanged.

#### Scenario: Valid v1 conditions
- GIVEN a `BankRule` with conditions in a known v1 format
- WHEN the adapter prepares the rule for the engine
- THEN the adapter normalizes the conditions into the exact Rule Engine v2 input contract

### Requirement: Invalid BankRule conditions rejected
`BankRule.conditions` in an unrecognized or corrupt format — adapter MUST reject with a clear error, skip the rule, and return `outcome: 'pending'`.

#### Scenario: Invalid conditions rejected
- GIVEN a `BankRule` with conditions in an unrecognized or corrupt format
- WHEN the adapter attempts to normalize the conditions
- THEN the adapter rejects with an explicit error, the rule is skipped, and returns `outcome: 'pending'`; Import Service persists

### Requirement: Mixed-format BankRule conditions
`BankRule.conditions` contains a mix of valid and invalid entries — adapter MUST reject the entire rule. Valid entries may be identified during validation but MUST NOT be applied or sent to the engine.

#### Scenario: Mixed valid and invalid
- GIVEN a `BankRule` with a mix of valid and invalid conditions
- WHEN the adapter processes the conditions
- THEN the adapter rejects the complete rule; valid conditions are identified during validation but NOT applied or sent to the engine

### Requirement: No fallback to legacy engine
Flag ON — adapter MUST NOT call `findMatchingRule()`. Valid outcomes: `winner`, `ambiguous`, `no_match`, `pending-with-error`.

#### Scenario: Legacy never invoked
- GIVEN `RULE_ENGINE_V2_ENABLED=true` and any engine result
- WHEN the adapter completes processing
- THEN `findMatchingRule()` is called exactly zero times

### Requirement: Trace and audit are in-memory only
Trace/audit data SHALL live in memory only, MAY emit diagnostic logs. Persistence is Sprint 5 scope.

#### Scenario: Audit not persisted
- GIVEN any engine execution with `RULE_ENGINE_V2_ENABLED=true`
- WHEN the adapter captures trace data
- THEN data MAY emit diagnostic logs and is NOT written to any database or persistent store

### Requirement: Adapter contains zero accounting logic
Adapter MUST contain only mapping, invariants, orchestration, and error handling — not accounting rules, classification, or journal entry business logic.

#### Scenario: No accounting logic
- GIVEN the adapter codebase
- WHEN reviewed for business logic
- THEN it contains zero accounting rules, classification algorithms, or journal entry business rules — only mapping, invariants, orchestration, error handling

## Deferred Requirements

The following requirements are part of the long-term contract but are not yet implemented. They remain in this spec as future scope and will be activated when implemented in Sprint 5.

### S5-01: Protected persisted transaction invariants

Status: Deferred — not implemented.

Transactions that are reconciled, journal-linked, classified, ignored, or manually-edited MUST be skipped before engine invocation. The import flow receives only new, unpersisted transactions, so this invariant is structurally inapplicable at the current boundary. Applies to downstream consumers (apply-all, reconciliation, manual categorization) that operate on persisted records.

No scenario defined — deferred until implementation.

### S5-02: Pending classification persistence and exposure

Status: Deferred — not implemented.

The adapter returns the full `classification` object in `MatchResult` (this is already implemented and covered by the active requirements above). However, the Import Service only persists `glAccountId=null` and `matchedRuleId=null` for pending outcomes. The classification is available at the adapter return boundary (in-memory) but is not persisted or exposed downstream to UI for manual review.

Persistence requires a new DB field. Exposure requires UI work. Both deferred to Sprint 5.

No scenario defined — deferred until implementation.
