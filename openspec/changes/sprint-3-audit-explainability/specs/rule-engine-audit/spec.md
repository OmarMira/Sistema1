# Rule Engine Audit Specification

## Purpose

Define the structured audit trail and explainability contract for Rule Engine v2.1.0. Covers execution tracing, audit records, truncation, error trace capture, serialization, and sensitivity guarantees — enabling observability without I/O.

## Requirements

### Requirement: Execution Return Type

`evaluateRules()` MUST always return `RuleEngineExecution` regardless of feature flag state. When the flag is OFF, `trace` and `audit` MUST be omitted from the result. This is a **deliberate breaking change** from Sprint 2: the signature changes from `RuleOutput` to `RuleEngineExecution`. All callers MUST be updated to access `output` for the result. The benefit is a single stable public contract that does not vary by configuration.

- GIVEN the rule engine evaluates a transaction
- WHEN `evaluateRules()` completes
- THEN the return type MUST be `{ output: RuleOutput; trace?: DecisionTrace; audit?: AuditRecord }`
- AND when feature flag is ON, `trace` and `audit` MUST be populated
- AND when feature flag is OFF, `trace` and `audit` MUST be omitted (properties absent, not `undefined`), `output` matches Sprint 2 behavior exactly

#### Scenario: Feature flag OFF omits trace and audit

- GIVEN `RULE_ENGINE_V2_ENABLED` is false
- WHEN `evaluateRules()` is called with any input
- THEN it MUST return `{ output: RuleOutput }` (no `trace` or `audit` keys)
- AND `output` MUST match Sprint 2 behavior exactly (`{ candidates, decision }`)

### Requirement: TraceEvent Discriminated Union

The engine MUST emit `TraceEvent` objects as a CLOSED discriminated union with NO generic payload fields.

#### Scenario: Happy path — stage event emission

- GIVEN a rule evaluation progresses through stages
- WHEN each internal stage (pipeline, scoring, ranking, decision) completes
- THEN it MUST emit a typed `TraceEvent` with fields limited to: `stage`, event discriminator, `ruleId`, `conditionType`, `score`, `matched`, and numeric counts
- AND the event MUST NOT contain `value`, `payload`, or `metadata: unknown`

#### Scenario: JSON determinism

- GIVEN any `TraceEvent` instance
- WHEN serialized via `JSON.stringify()`
- THEN the output MUST be deterministic for identical inputs

### Requirement: DecisionTrace

`evaluateRules()` MUST produce a `DecisionTrace` with ordered events, engine version, and truncation metadata. The order of `events[]` IS part of the contract: MUST be strict chronological execution order.

#### Scenario: Full trace (no truncation)

- GIVEN an invocation produces fewer than `MAX_TRACE_EVENTS` events
- WHEN execution finishes
- THEN `DecisionTrace` MUST have `truncated: false`, `totalEvents === emittedEvents`, and events in strict execution order
- AND `engineVersion` MUST equal `RULE_ENGINE_VERSION`

#### Scenario: Truncated trace

- GIVEN an invocation would produce more than `MAX_TRACE_EVENTS` events
- WHEN execution finishes
- THEN the engine MUST keep the first `MAX_TRACE_EVENTS - 1` events and reserve the last slot for the final decision or error event
- AND `truncated` MUST be `true`, `emittedEvents === MAX_TRACE_EVENTS`, `totalEvents` reflects the actual count
- AND events in positions 0 through `MAX_TRACE_EVENTS - 2` are the earliest emitted events (head), position `MAX_TRACE_EVENTS - 1` is the final event — middle events are dropped
- AND the dropped events are unrecoverable from the trace (they are not stored or referenced)
- AND the final event in position `MAX_TRACE_EVENTS - 1` MUST be a structured terminal event (`{ stage: 'execution', event: 'complete' | 'error', errorCode?: string }`) — no message, no stack, no condition values, no sensitive data

### Requirement: AuditRecord

`evaluateRules()` MUST generate an `AuditRecord` per invocation, never persisted by the engine.

#### Scenario: Audit record construction

- GIVEN a completed evaluation with a winner
- WHEN `AuditRecord` is built
- THEN it MUST contain `engineVersion`, `transactionId`, `companyId`, `result`, `winnerRuleId`, `candidateCount`, and `trace`
- AND `engineVersion` MUST equal `RULE_ENGINE_VERSION` (single constant source of truth)
- AND `trace` is a snapshot (value copy), not a reference — the `DecisionTrace` is a plain object, safe to serialise independently

#### Scenario: No-match audit

- GIVEN an evaluation where no rule matched
- WHEN `AuditRecord` is built
- THEN `result` MUST be `'no_match'`, `winnerRuleId` MUST be absent
- AND `candidateCount` MUST be `0`

### Requirement: Error Trace Capture

All errors thrown by `evaluateRules()` MUST carry the partial trace when events were emitted before the failure. The behavior differs by error type but the trace MUST be attached whenever it exists.

#### Scenario: Partial trace on typed error

- GIVEN a `ConditionEvalError` occurs during scoring
- WHEN the error propagates to `evaluateRules()`
- THEN the thrown `RuleEngineError` MUST have `trace` containing all events emitted before the failure point
- AND the last event in the partial trace MUST be a terminal `{ stage: 'execution', event: 'error', errorCode?: string }` event recording the failure
- AND error events MUST survive in the partial trace

#### Scenario: Partial trace on untyped error with prior events

- GIVEN a native `TypeError` occurs after pipeline events were already emitted
- WHEN the error propagates
- THEN the engine MUST preserve the original error type and prototype (NOT convert to `RuleEngineError`)
- AND the engine MUST attach the partial `DecisionTrace` as a `trace` property on the error object only if it is extensible
- AND the last event MUST be a terminal `{ stage: 'execution', event: 'error' }` (without `errorCode` for native errors)
- AND the engine MUST still rethrow, never swallow

### Requirement: Zero I/O

The engine MUST NOT persist, queue, or write any audit or trace data to an external system.

#### Scenario: No side effects

- GIVEN any invocation of `evaluateRules()`
- WHEN execution completes (success or error)
- THEN no DB writes, queue pushes, filesystem operations, or network calls MUST occur
- AND `AuditRecord` is returned in-memory only

### Requirement: AuditLogEntry Removal

The existing `AuditLogEntry` type at `src/lib/rule-engine/types.ts:121` MUST be removed and replaced by `AuditRecord`.

#### Scenario: No aliasing

- GIVEN `AuditLogEntry` exists at the specified location
- WHEN the change is applied
- THEN `AuditLogEntry` MUST be deleted (not aliased to `AuditRecord`)
- AND all references to `AuditLogEntry` in tests and docs MUST be updated to `AuditRecord`

### Requirement: Sensitivity Policy

`TraceEvent` MUST NOT expose sensitive data from the transaction or rule configuration. Technical identifiers (`ruleId`, `transactionId`, `companyId`) ARE permitted as references. Original text, condition parameters, and personal data are NOT.

#### Scenario: No sensitive fields

- GIVEN any `TraceEvent` instance
- WHEN inspected
- THEN it MUST NOT contain bank transaction descriptions, condition regex patterns, amount thresholds, condition configuration values, API keys, or personal identifiable data
- AND the closed union type design MUST enforce this by omitting generic `value`/`payload`/`metadata`
- AND `ruleId`, `transactionId`, `companyId` ARE permitted because they are technical references, not user data

### Requirement: Serialization

All new types MUST be JSON-serializable deterministically. The order of `events[]` is part of the contract, not an implementation detail.

#### Scenario: No non-serializable types

- GIVEN `JSON.stringify()` on any `DecisionTrace` or `AuditRecord`
- WHEN the result is parsed back
- THEN it MUST produce an equivalent object (no `Date`, `Map`, `Set`, or `undefined` values)

#### Scenario: Deterministic event order

- GIVEN the same input twice
- WHEN both `DecisionTrace` instances are serialized via `JSON.stringify()`
- THEN the JSON output MUST be byte-identical (deterministic event order)
- AND events MUST NOT be reordered by timestamp, stage name, or any secondary key — only execution order is valid
