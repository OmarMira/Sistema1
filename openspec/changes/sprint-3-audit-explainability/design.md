# Design: Sprint 3 — Audit + Explainability

## Technical Approach

**Pipeline-as-Weave.** Each stage function returns `[Result, TraceEvent[]]`. The orchestrator in `index.ts` calls stages sequentially, concatenates all `TraceEvent[]` arrays into a `DecisionTrace`, applies truncation (head + terminal slot), and builds the `AuditRecord` only on success. Each stage catches its OWN errors, attaches partial events to the error, and rethrows — so events emitted before a stage failure are never lost. The orchestrator combines completed-stage events + partial events from the failed stage + terminal error event.

## Architecture Decisions

### Decision: Pipeline-as-Weave over Collector pattern

| Option | Tradeoff |
|--------|----------|
| **Pipeline-as-Weave** (chosen) | Stage signatures change; event emission is explicit per stage; no global side-channel |
| Collector pattern (global accumulator) | No signature changes; hidden coupling via shared mutable state; harder to test |

**Rationale:** Explicit return types make trace generation testable per stage. The tuple `[Result, TraceEvent[]]` is self-documenting. No global state, no DI.

### Decision: Truncation at orchestrator level

**Choice:** Index.ts applies truncation AFTER collecting all events, just before building `DecisionTrace`.
**Alternatives:** Per-stage truncation (complex, mid-stage dropping breaks event ordering).
**Rationale:** Single responsibility — stages emit, orchestrator shapes. Head drop + terminal slot in one place.

### Decision: Terminal event owned by orchestrator, not by stages

**Choice:** A `buildDecisionTrace(nonTerminalEvents, terminalEvent)` function owned by the orchestrator concatenates and truncates. Stages only emit their own events.
**Rationale:** Stages never know about terminal events. The orchestrator owns lifecycle. The function signature `nonTerminalEvents` + `terminalEvent` prevents accidental duplication or loss of the terminal event.

### Decision: Closed TraceEvent union (no generic fields)

**Choice:** A discriminated union `{ stage, ...fields }` with zero `value`/`payload`/`metadata`.
**Rationale:** Type-level enforcement of the sensitivity policy. Impossible to accidentally leak data. Deterministic serialization by construction.

### Decision: Feature flag OFF → single return type

**Choice:** `evaluateRules()` always returns `RuleEngineExecution`. Flag OFF sets `trace: undefined, audit: undefined`.
**Rationale:** One stable contract. Callers don't switch on the flag type. Deliberate breaking change: all callers update to `result.output.*`.

## Data Flow

### Success path

```
evaluateRules(input)
  │
  ├─ flag OFF → return { output: { candidates, decision } }  // trace and audit omitted, no undefined keys
  │
  ├─ validate input → throw on invalid (no events yet)
  │
  ├─ [artifacts, pipelineEvents] = runPipeline(input)
  ├─ [scored,    scoringEvents]   = scoreCandidates(artifacts)
  ├─ [ranked,    rankingEvents]   = rankCandidates(scored)
  ├─ [decision,  decisionEvents]  = makeDecision(ranked)
  │
  ├─ nonTerminalEvents = [...pipelineEvents, ...scoringEvents, ...rankingEvents, ...decisionEvents]
  ├─ terminal = { stage: 'execution', event: 'complete' }
  │
  ├─ trace = buildDecisionTrace(nonTerminalEvents, terminal)
  │   • total <= MAX → emit all nonTerminal + terminal
  │   • total > MAX  → keep first MAX-1 nonTerminal + terminal (last slot)
  │   • MAX=1        → only terminal event
  │
  ├─ audit = { transactionId, companyId, result, winnerRuleId?, candidateCount, trace: cloneDecisionTrace(trace), engineVersion: RULE_ENGINE_VERSION }
  │   • buildDecisionTrace returns fresh objects — no shared references
  │
  └─ return { output: { candidates, decision }, trace, audit }
```

### Error path

Each stage is self-guarded: if it partially emits events before throwing, it catches, attaches them to the error, and rethrows. The orchestrator combines all available events:

```
evaluateRules(input)
  │
  ├─ validate → OK
  ├─ [artifacts, pipelineEvents] = runPipeline(input)
  │
  ├─ TRY: [scored, scoringEvents] = scoreCandidates(artifacts)
  │   ├─ emits 3 scoring events
  │   └─ CATCH: attach scoringEvents to error, rethrow
  │
  ├─ orchestrator catches:
  │   • accumulated: pipelineEvents + partial scoringEvents
  │   • terminal: { stage: 'execution', event: 'error', errorCode?: err.code }
  │   • trace = { engineVersion, events: accumulated + [terminal], truncated: ?, totalEvents, emittedEvents }
  │   • attach trace to error.trace
  │   • rethrow (NO AuditRecord on error)
  │
  └─ caller catches typed RuleEngineError with partial trace
```

### Stage self-guard pattern (applied in pipeline.ts, scoring.ts, ranking.ts, decision.ts)

Each stage emits `TraceEvent[]` only — never builds a `DecisionTrace`. On error, it attaches raw `TraceEvent[]` via the `attachTraceToError()` helper. The orchestrator is the sole builder of `DecisionTrace`.

```ts
function scoreCandidates(artifacts: PipelineArtifacts): [ScoredCandidate[], TraceEvent[]] {
  const events: TraceEvent[] = [];
  try {
    // ... compute, push to events ...
    return [scored, events];
  } catch (err) {
    // attach partial TraceEvent[] before rethrowing — orchestrator builds DecisionTrace
    attachTraceToError(err, events);
    throw err;
  }
}
```

```ts
// trace.ts — helper
function attachTraceToError(err: unknown, events: TraceEvent[]): void {
  if (err instanceof RuleEngineError || (typeof err === 'object' && err !== null)) {
    Object.defineProperty(err, 'events', { value: events, writable: false });
  }
}
```

The orchestrator catches and builds the partial `DecisionTrace` from `error.events`:

```ts
catch (err) {
  const partialEvents: TraceEvent[] = [
    ...accumulatedEvents,
    ...(err.events ?? []),
    { stage: 'execution', event: 'error', errorCode: err.code },
  ];
  (err as RuleEngineError).trace = buildDecisionTrace([], partialEvents[partialEvents.length - 1], MAX_TRACE_EVENTS);
  throw err;
}
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/rule-engine/types.ts` | Modify | Add `TraceEvent` union, `DecisionReason`, `DecisionTrace`, `AuditRecord`, `RuleEngineExecution`. **Remove `AuditLogEntry` and all references.** |
| `src/lib/rule-engine/version.ts` | Create | `RULE_ENGINE_VERSION = '2.1.0'` and `MAX_TRACE_EVENTS = 500` |
| `src/lib/rule-engine/index.ts` | Modify | Orchestrator: call stages with destructure, collect events, `buildDecisionTrace()`, `cloneDecisionTrace()`, build audit on success, catch errors with stage-guarded partial events + terminal error event + rethrow. New return type `RuleEngineExecution`. |
| `src/lib/rule-engine/pipeline.ts` | Modify | Return `[PipelineArtifacts, TraceEvent[]]`. Self-guard: catch, attach partial events, rethrow. Emit `candidates_collected`, `condition_evaluated`, `candidate_valid`, `candidate_discarded`. |
| `src/lib/rule-engine/scoring.ts` | Modify | Return `[ScoredCandidate[], TraceEvent[]]`. Self-guard. Emit `candidate_scored`. |
| `src/lib/rule-engine/ranking.ts` | Modify | Return `[ScoredCandidate[], TraceEvent[]]`. Self-guard. Emit `final_order`. |
| `src/lib/rule-engine/trace.ts` | Create | `buildDecisionTrace()`, `cloneDecisionTrace()`, `deepCopyTraceEvent()`, `attachTraceToError()`. |
| `src/lib/rule-engine/decision.ts` | Modify | Return `[EngineDecision, TraceEvent[]]`. Self-guard. Emit `outcome` with `DecisionReason` (no free-text). |
| `src/lib/rule-engine/errors.ts` | Modify | Add `events?: TraceEvent[]` field to `RuleEngineError` for partial stage events. |
| `*/**/*.ts` (all callers of `evaluateRules()`) | Modify | Update from `result.candidates` to `result.output.candidates`, `result.decision` to `result.output.decision`. Audit all production callers, not just tests. |
| `src/lib/rule-engine/__tests__/*.test.ts` | Modify | Update callers to new return shape. Add trace/audit assertions. Add `MAX_TRACE_EVENTS = 1` test. Add stage-self-guard tests. |

## Interfaces / Contracts

```ts
// version.ts — single source of truth
export const RULE_ENGINE_VERSION = '2.1.0';
export const MAX_TRACE_EVENTS = 500;

// ===== NEW TYPES (added to types.ts) =====

// Closed reason codes — never free-text
type DecisionReason =
  | 'no_candidates'
  | 'single_candidate'
  | 'higher_specificity_tier'
  | 'higher_specificity_weight'
  | 'delta_above_threshold'
  | 'delta_below_threshold';

type TraceEvent =
  | { stage: 'pipeline'; event: 'candidates_collected'; count: number }
  | { stage: 'pipeline'; event: 'condition_evaluated'; ruleId: string; conditionType: RuleConditionType; score: number; matched: boolean }
  | { stage: 'pipeline'; event: 'candidate_valid'; ruleId: string; conditionCount: number }
  | { stage: 'pipeline'; event: 'candidate_discarded'; ruleId: string }
  | { stage: 'scoring'; event: 'candidate_scored'; ruleId: string; highestTier: number; weightWithinTier: number; matchQuality: number }
  | { stage: 'ranking'; event: 'final_order'; rankedRuleIds: string[] }
  | { stage: 'decision'; event: 'outcome'; result: DecisionResult; reason: DecisionReason; winnerRuleId?: string; delta?: number; threshold: number }
  | { stage: 'execution'; event: 'complete' }
  | { stage: 'execution'; event: 'error'; errorCode?: string };

// No value / payload / metadata fields anywhere in TraceEvent.
// No free-text explanation. DecisionReason is a closed enum.

interface DecisionTrace {
  events: TraceEvent[];
  engineVersion: string;
  truncated: boolean;
  totalEvents: number;
  emittedEvents: number;
}

interface AuditRecord {
  engineVersion: string;
  transactionId: string;
  companyId: string;
  result: DecisionResult;
  winnerRuleId?: string;
  candidateCount: number;
  trace: DecisionTrace;
}

interface RuleEngineExecution {
  output: RuleOutput;
  trace?: DecisionTrace;
  audit?: AuditRecord;
}

// ===== HELPER FUNCTIONS (in src/lib/rule-engine/trace.ts) =====

function buildDecisionTrace(
  nonTerminalEvents: TraceEvent[],
  terminalEvent: TraceEvent,
  maxEvents: number = MAX_TRACE_EVENTS,
): DecisionTrace {
  if (maxEvents < 1) throw new RangeError('maxEvents must be >= 1');
  const totalEvents = nonTerminalEvents.length + 1; // +1 for terminal
  let emitted: TraceEvent[];
  let truncated: boolean;

  if (totalEvents <= maxEvents) {
    emitted = [...nonTerminalEvents, terminalEvent];
    truncated = false;
  } else {
    // Keep first maxEvents-1 non-terminal events, last slot = terminal
    const head = nonTerminalEvents.slice(0, maxEvents - 1);
    emitted = [...head, terminalEvent];
    truncated = true;
  }

  return {
    engineVersion: RULE_ENGINE_VERSION,
    events: emitted,
    truncated,
    totalEvents,
    emittedEvents: emitted.length,
  };
}

function cloneDecisionTrace(trace: DecisionTrace): DecisionTrace {
  return {
    ...trace,
    events: trace.events.map(e => deepCopyTraceEvent(e)),
  };
}

// Deep copy every composite field to prevent shared references
function deepCopyTraceEvent(e: TraceEvent): TraceEvent {
  if (e.stage === 'ranking' && e.event === 'final_order') {
    return { ...e, rankedRuleIds: [...e.rankedRuleIds] };
  }
  // All other events contain only primitives — shallow spread is safe
  return { ...e } as TraceEvent;
}

// Invariants after clone:
//   execution.trace !== execution.audit.trace
//   execution.trace.events !== execution.audit.trace.events
//   execution.trace.events[i].rankedRuleIds !== execution.audit.trace.events[i].rankedRuleIds

// Optional fields MUST be omitted when absent (no undefined values):
// Correct:  result === 'no_match' ? { result: 'no_match' } : { result: 'winner', winnerRuleId: id }
// Incorrect: { result: 'winner', winnerRuleId: undefined }
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit — per stage | Stage emits correct `TraceEvent[]` for given input | Call each stage directly, assert `events[1]` structure |
| Unit — stage self-guard | Stage error preserves partial trace | Force error mid-stage, assert error has `trace` with events emitted before failure |
| Unit — truncation normal | Head kept (first MAX-1), terminal slot preserved, mid dropped | `buildDecisionTrace(stageEvents, terminal, 500)` → `truncated: true`, last event is `complete` |
| Unit — truncation MAX=1 | Only terminal event in trace | `buildDecisionTrace(stageEvents, terminal, 1)` → `events.length === 1`, event is `execution/complete` |
| Unit — error trace typed | Partial `DecisionTrace` on `ConditionEvalError` | Force error in scoring with prior events, assert `error.trace.events` ends with `execution/error` with `errorCode` |
| Unit — error trace untyped | Native error — same prototype, not converted | Force TypeError after pipeline events, assert `error` is still `TypeError`, `trace` attached if extensible, ends with `execution/error` (no errorCode), always rethrown |
| Unit — closed union | No `value`/`payload`/`metadata` in any event | Exhaustive type check (compile-time) + runtime scan test |
| Unit — DecisionReason | Only closed reason codes emitted | Exhaustive switch in test: every reason variant is a valid `DecisionReason` |
| Unit — audit snapshot | `AuditRecord.trace` independent copy | Assert `execution.trace !== execution.audit.trace`, `execution.trace.events !== execution.audit.trace.events`, and `execution.trace.events[i].rankedRuleIds !== execution.audit.trace.events[i].rankedRuleIds` |
| Unit — version constant | No literal `'2.1.0'` in tests | All tests import `RULE_ENGINE_VERSION` — version change never breaks assertions |
| Unit — serialization | Deterministic JSON, no undefined, no Date/Map/Set | Round-trip: `expect(JSON.parse(JSON.stringify(v))).toEqual(v)`. Byte-identical for same input. Flag OFF omits keys, does NOT set them to `undefined` |
| Integration — flag OFF | `trace` and `audit` keys absent | `RULE_ENGINE_V2_ENABLED=false` → `expect('trace' in result).toBe(false)`, `expect('audit' in result).toBe(false)`, `result.output` matches Sprint 2 |
| Integration — no AuditRecord on error | Error path never returns audit | Force error, assert caught error has `trace` but no `audit` property |
| Caller audit | All `evaluateRules(` call sites found | Search across codebase pre-commit, verify each is updated |

## Migration / Rollout

**Breaking change** — `evaluateRules()` now returns `{ output, trace?, audit? }` instead of `RuleOutput`. All callers (production AND tests) must be updated:
- `result.candidates` → `result.output.candidates`
- `result.decision` → `result.output.decision`

**Caller audit required:** Search `evaluateRules(` across the entire codebase before implementation. Flag every call site. The change is mechanical and gated by TypeScript — the old return type produces compile errors on `result.candidates` access, so no silent breakage is possible.

**Operational rule:** Every internal stage that changes signature (`Result` → `[Result, TraceEvent[]]`) MUST have its tests adapted in the SAME commit as the signature change. No commit may leave a stage with a changed public signature but untested trace output. This prevents temporary breakage and keeps each commit self-contained.

**Commit strategy:** One PR, 7 atomic commits:
1. Foundation: version.ts, types.ts (new types + remove AuditLogEntry), errors.ts, trace.ts helpers + tests
2. Pipeline weaving: pipeline.ts → `[PipelineArtifacts, TraceEvent[]]` + tests
3. Scoring weaving: scoring.ts → `[ScoredCandidate[], TraceEvent[]]` + tests
4. Ranking weaving: ranking.ts → `[ScoredCandidate[], TraceEvent[]]` + tests
5. Decision weaving: decision.ts → `[EngineDecision, TraceEvent[]]` + tests
6. Orchestrator: index.ts (weave, truncate, audit, error handling, caller migration) + integration tests
7. Edge cases + verification: truncation MAX=1, snapshot, serialization, sensitivity, final suite

**No AuditRecord on error:** Incomplete evaluations (any thrown error) do NOT produce an `AuditRecord`. Only the partial `DecisionTrace` is attached to the error. This keeps the error path simple and avoids forcing error results into the audit domain.

**MAX_TRACE_EVENTS = 1 edge case:** If the limit is 1, only the terminal event exists in the trace. All stage events are dropped. This is an explicit degenerate case — the trace is valid but carries no stage detail.

**Rollback:** `git revert` the commit. The flag OFF path returns unchanged data shape (`output` contains the same `candidates`/`decision` as before), so rollback-safe.

## Open Questions

- None. Requirements and contracts are fully specified.
