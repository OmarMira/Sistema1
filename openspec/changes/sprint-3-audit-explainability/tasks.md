# Tasks: Sprint 3 — Audit + Explainability

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~380–420 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR (all stages interdependent) |
| Delivery strategy | ask-on-risk → size:exception |
| Commit strategy | 7 atomic commits, one PR |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Medium

### Caller Audit (pre-work)

`evaluateRules(` found in 2 files (28 call sites total):
- `src/lib/rule-engine/__tests__/index.test.ts` — 16 call sites
- `src/lib/rule-engine/__tests__/pipeline.test.ts` — 12 call sites

No production callers found outside tests.

### AuditLogEntry Removal

Only referenced at `src/lib/rule-engine/types.ts:121`. No other references found in codebase.

### Key Design Rules

- Flag OFF: return `{ output }` — omit `trace` and `audit` keys (properties absent, NOT undefined)
- Helpers live in `trace.ts`, not `decision.ts`
- Commands: `npx vitest run src/lib/rule-engine` (not `bunx`), `npx tsc --noEmit`, `npm run build`
- All tests import `RULE_ENGINE_VERSION` — no literal `'2.1.0'`

## Phase 1: Foundation (6 tasks)

- [x] 1.1 Create `src/lib/rule-engine/version.ts` — export `RULE_ENGINE_VERSION = '2.1.0'` and `MAX_TRACE_EVENTS = 500`
- [x] 1.2 Add to `src/lib/rule-engine/types.ts`: `DecisionReason` closed union, `TraceEvent` discriminated union (no value/payload/metadata), `DecisionTrace`, `AuditRecord`, `RuleEngineExecution`. Remove `AuditLogEntry` interface entirely. Search for all references.
- [x] 1.3 Add to `src/lib/rule-engine/errors.ts`: `trace?: DecisionTrace` field on `RuleEngineError`
- [x] 1.4 Create `src/lib/rule-engine/trace.ts`: `buildDecisionTrace(nonTerminalEvents, terminalEvent, maxEvents?)` with `maxEvents >= 1` validation, `cloneDecisionTrace()` with deep copy of composite fields, `deepCopyTraceEvent()`, `attachTraceToError()`
- [x] 1.5 Write tests: version constant import, helper function behavior (normal truncation, MAX=1, maxEvents validation), new type shapes
- [x] 1.6 Run `npx vitest run src/lib/rule-engine && npx tsc --noEmit && npm run build`

## Phase 2: Stage conversion (4 commits, one per stage + tests)

- [x] 2.1 Convert `runPipeline()` in `pipeline.ts` to `[PipelineArtifacts, TraceEvent[]]`. Emit `candidates_collected`, `condition_evaluated`, `candidate_valid`, `candidate_discarded`. Self-guard: `attachTraceToError(err, events)` — raw TraceEvent[], not DecisionTrace
- [x] 2.2 Write pipeline trace event tests: verify each event shape, count, stage guard preserves partial trace
- [x] 2.3 Commit: `npx vitest run src/lib/rule-engine && npx tsc --noEmit && npm run build`
- [x] 2.4 Convert `scoreCandidates()` in `scoring.ts` to `[ScoredCandidate[], TraceEvent[]]`. Emit `candidate_scored` (highestTier, weightWithinTier, matchQuality). Self-guard: `attachTraceToError(err, events)`
- [x] 2.5 Write scoring trace event tests: event structure, edge cases, stage guard preserves TraceEvent[]
- [x] 2.6 Commit: `npx vitest run src/lib/rule-engine && npx tsc --noEmit && npm run build`
- [x] 2.7 Convert `rankCandidates()` in `ranking.ts` to `[ScoredCandidate[], TraceEvent[]]`. Emit `final_order` with `rankedRuleIds: string[]`. Self-guard: `attachTraceToError(err, events)`
- [x] 2.8 Write ranking trace event tests: `rankedRuleIds` content and deep copy, stage guard preserves TraceEvent[]
- [x] 2.9 Commit: `npx vitest run src/lib/rule-engine && npx tsc --noEmit && npm run build`
- [x] 2.10 Convert `makeDecision()` in `decision.ts` to `[EngineDecision, TraceEvent[]]`. Emit `outcome` with `DecisionReason` (no free-text). Self-guard: `attachTraceToError(err, events)`
- [x] 2.11 Write decision trace event tests: `outcome` for winner/ambiguous/no_match, each reason code with exhaustive switch (`default: const _: never = reason`), stage guard
- [x] 2.12 Commit: `npx vitest run src/lib/rule-engine && npx tsc --noEmit && npm run build`

## Phase 3: Orchestrator + Integration (5 tasks)

- [x] 3.1 Audit all `evaluateRules(` callers (28 sites in 2 files). Review each site before changing.
- [x] 3.2 Update `index.ts`: call stages with destructure, collect events, `buildDecisionTrace()`, `cloneDecisionTrace()`, build `AuditRecord` on success, catch errors (combine completed-stage events + partial error events + terminal error event), attach partial trace to error, rethrow. New return type `RuleEngineExecution`. Flag OFF: return `{ output }` (omit trace/audit keys).
- [x] 3.3 Update all `evaluateRules()` call sites in `index.test.ts` and `pipeline.test.ts`: `result.candidates` → `result.output.candidates`, `result.decision` → `result.output.decision`
- [x] 3.4 Integration tests: flag OFF omits trace/audit keys (`expect('trace' in result).toBe(false)`). Full pipeline produces correct trace with terminal `complete` event. Error path — typed error propagates with partial DecisionTrace (built by orchestrator from stage TraceEvent[]) + terminal error event. No `AuditRecord` on error.
- [x] 3.5 Commit: `npx vitest run src/lib/rule-engine && npx tsc --noEmit && npm run build`

## Phase 4: Edge cases + Verification (8 tasks)

- [x] 4.1 Truncation: `buildDecisionTrace(events, terminal, 500)` — head kept, terminal slot preserved, `truncated: true`, `totalEvents > emittedEvents`
- [x] 4.2 Truncation MAX=1: `buildDecisionTrace(events, terminal, 1)` — only terminal event, no drop of stage events (there are none to keep)
- [x] 4.3 Error trace untyped: native TypeError after pipeline events — same prototype preserved (not converted to RuleEngineError), `events` (TraceEvent[]) attached only if extensible, always rethrown
- [x] 4.4 Sensitivity: runtime scan — no `TraceEvent` variant contains `value`, `payload`, or `metadata` keys
- [x] 4.5 Snapshot: `execution.trace !== execution.audit.trace`, `execution.trace.events !== execution.audit.trace.events`, `execution.trace.events[i].rankedRuleIds !== execution.audit.trace.events[i].rankedRuleIds`
- [x] 4.6 Serialization: round-trip — `expect(JSON.parse(JSON.stringify(v))).toEqual(v)`. Byte-identical for same input (same engine version, same event order, same truncation limit). No `Date`, `Map`, `Set`, or `undefined` values
- [x] 4.7 AuditLogEntry confirmed removed: search for stale `AuditLogEntry` references — must be zero
- [x] 4.8 Final commit: `npx vitest run src/lib/rule-engine && npx tsc --noEmit && npm run build && npx vitest run` (full suite)
