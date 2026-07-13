## Exploration: Sprint 3 — Audit + Explainability

### Current State

The rule engine v2 is a deterministic pure-function pipeline in src/lib/rule-engine/index.ts:

`
evaluateRules(input: RuleInput): RuleOutput
`

Pipeline stages (all pure function compositions, no classes, no DI, no mutable state):

1. **Validation** (inline in index.ts): checks feature flag, null transaction/context, valid transaction id + companyId, filters empty-condition rules via discardInvalidConfiguration().
2. **unPipeline(input)** (pipeline.ts): collects active/testing rules for the company, evaluates all conditions via valuateCondition() in conditions/index.ts, discards rules where any condition fails, produces PipelineArtifacts { rawCandidates, evaluations }.
3. **scoreCandidates(artifacts)** (scoring.ts): maps each RawCandidate to a ScoredCandidate by computing SpecificityScore (tier + weight) and matchQuality (min + alpha(avg - min)). Throws InvalidPipelineStateError if an evaluation entry is missing.
4. **ankCandidates(scored)** (anking.ts): stable-sort by descending tier → descending weight → descending matchQuality → ascending priority → lexicographic ruleId.
5. **makeDecision(scored)** (decision.ts): classify() resolves winner / ambiguous / no_match using delta threshold (0.10). Returns EngineDecision { type, result, ruleId?, candidateList, classification?, explanation }.

Return type today:
`	ypescript
interface RuleOutput {
  candidates: Candidate[];
  decision?: EngineDecision;
}
`

**No trace, no audit, no engine version today.** The pipeline produces intermediate data (valuations map, awCandidates, scoredCandidates) that is consumed within the pipeline but discarded after each step.

**Existing types in codebase**:

- AuditLogEntry already exists in 	ypes.ts (line 121) with fields: ngineVersion, decision, esult, winner, candidates, delta, 	hreshold, xplanation, 	imestamp. This type is **defined but unused** — a forward-looking placeholder.
- The app has a separate src/lib/audit.ts with createAuditLogWithRetry() for DB-level user-action audit (CRUD on entities). This is NOT the engine's synchronous audit — the engine audit is a different concern (no DB, no I/O).
- No ngineVersion constant exists anywhere.

**Error handling**: All errors extend RuleEngineError with code and details. ConditionEvalError adds conditionType. Errors are thrown, not returned. There is no trace-on-error wrapper today.

**Test coverage**: 13 test files with ~200+ tests covering all pipeline stages, edge cases, boundary conditions, and integration scenarios. Tests use a eforeEach to set RULE_ENGINE_V2_ENABLED=true.

### Affected Areas

- src/lib/rule-engine/index.ts — Main orchestrator. Must change return type from RuleOutput to RuleEngineResult { output, artifacts: { trace, audit } }. Must weave trace events from each stage into a DecisionTrace. Must build AuditRecord from trace + input metadata. Must handle trace-on-error for typed errors.
- src/lib/rule-engine/types.ts — Add types: TraceEvent (discriminated union by stage), DecisionTrace, AuditRecord, RuleEngineResult. Update or remove the stale AuditLogEntry (or alias it to the new AuditRecord).
- src/lib/rule-engine/decision.ts — classify() and makeDecision() must emit trace events for decision outcome (winner/ambiguous/no_match, delta, threshold, explanation). Currently returns classification data but no events.
- src/lib/rule-engine/pipeline.ts — unPipeline() must emit trace events: candidate count filtered in, conditions evaluated per candidate (ruleId, conditionType, score, matched), invalid discarded.
- src/lib/rule-engine/scoring.ts — scoreCandidates() must emit trace events: per-candidate specificityScore and matchQuality.
- src/lib/rule-engine/ranking.ts — ankCandidates() must emit trace events: final ordering of candidates.
- src/lib/rule-engine/errors.ts — Add a 	race?: DecisionTrace field to RuleEngineError (or a TraceableRuleEngineError subclass) so the error carries partial trace up to failure point. A wrapper in index.ts can attach trace and re-throw.
- src/lib/rule-engine/__tests__/index.test.ts — Update existing tests for new return shape { output, artifacts }. Add trace and audit assertions.
- src/lib/rule-engine/__tests__/decision.test.ts — Test trace events from makeDecision().
- src/lib/rule-engine/__tests__/pipeline.test.ts — Test trace events from unPipeline().
- src/lib/rule-engine/__tests__/scoring.test.ts — Test trace events from scoreCandidates().
- src/lib/rule-engine/__tests__/ranking.test.ts — Test trace events from ankCandidates().
- src/lib/rule-engine/__tests__/errors.test.ts — Test trace-on-error behavior.
- src/lib/rule-engine/__tests__/fixtures.ts — Add factory functions for new types (TraceEvent, DecisionTrace, AuditRecord, RuleEngineResult).

### Approaches

1. **Option A: Pipeline-as-Weave** — Each stage function returns [Result, TraceEvent[]] (tuple). The orchestrator weaves all TraceEvent[] arrays into a single DecisionTrace. Pure, deterministic, easy to test.
   - Pros:
     - Fully pure — no mutation, no shared state. Fits the existing architecture perfectly.
     - Testable at every level: each stage's trace output can be unit-tested independently.
     - Compose-friendly: pipe helpers can weave traces transparently.
     - The DecisionTrace is assembled by the orchestrator from independent pieces — no stage needs to know about other stages.
   - Cons:
     - Return type change for all stage functions from Result to [Result, TraceEvent[]]. This is mechanical but touches every stage.
     - Slightly more verbose call sites in the orchestrator (must destructure and concat).
     - If a stage throws, its trace events are lost unless caught before propagation.
   - Effort: **Medium** — mechanical changes across 5+ stage files + orchestrator, but conceptually simple.

2. **Option B: Collector Pattern** — A mutable TraceCollector object is passed through stages. Each stage calls collector.emit(event) to append trace events.
   - Pros:
     - No return type changes for stage functions — just add a parameter.
     - Easier error-trace capture: if a stage throws, the collector already holds events up to that point.
     - More familiar/ergonomic for some developers.
   - Cons:
     - **Violates the pure function constraint (axiom #6).** The engine must stay "pure function composition. No classes, no DI, no mutable shared state." A mutable collector breaks this.
     - Harder to test: each test must set up a collector and assert its internal state after the call.
     - Trace collection is a side effect — the function's return type no longer describes all outputs.
     - Risk of stale collector state across calls if not reset correctly.
   - Effort: **Low** — least code change, but violates the architecture constraint.

### Recommendation

**Option A: Pipeline-as-Weave** is the only viable option given the architectural constraints (axiom #6: no classes, no DI, no mutable shared state). The Collector pattern is explicitly disallowed by the established architecture.

The tuple return [Result, TraceEvent[]] keeps everything pure, testable, and composable. The mechanical overhead of changing return types is acceptable — each stage is small and focused.

#### Implementation Sketch

`	ypescript
// Types
type TraceEvent =
  | { stage: 'pipeline'; event: 'candidates_collected'; count: number }
  | { stage: 'pipeline'; event: 'condition_evaluated'; ruleId: string; conditionType: string; score: number; matched: boolean }
  | { stage: 'pipeline'; event: 'candidate_valid'; ruleId: string; conditionCount: number }
  | { stage: 'pipeline'; event: 'candidate_discarded'; ruleId: string }
  | { stage: 'scoring'; event: 'candidate_scored'; ruleId: string; highestTier: number; weightWithinTier: number; matchQuality: number }
  | { stage: 'ranking'; event: 'final_order'; rankedRuleIds: string[] }
  | { stage: 'decision'; event: 'outcome'; result: DecisionResult; winnerRuleId?: string; delta?: number; threshold: number; explanation: string };

interface DecisionTrace {
  engineVersion: string;
  events: TraceEvent[];
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

interface RuleEngineResult {
  output: RuleOutput;
  artifacts: {
    trace: DecisionTrace;
    audit: AuditRecord;
  };
}
`

#### Trace-on-Error Pattern

`	ypescript
// errors.ts — add optional trace to RuleEngineError
export class RuleEngineError extends Error {
  public readonly code: string;
  public readonly details: unknown;
  public readonly trace?: DecisionTrace;
  constructor(message: string, code: string, details?: unknown, trace?: DecisionTrace) {
    super(message);
    this.trace = trace;
  }
}

// index.ts — wrapper that attaches partial trace
function evaluateRules(input: RuleInput): RuleEngineResult {
  const traceEvents: TraceEvent[] = [];
  try {
    // ... run pipeline, collecting events ...
    return { output, artifacts: { trace: { engineVersion, events: traceEvents }, audit } };
  } catch (err) {
    if (err instanceof RuleEngineError) {
      (err as RuleEngineError & { trace: DecisionTrace }).trace = { engineVersion, events: traceEvents };
    }
    throw err;
  }
}
`

#### No Sensitive Data in Trace

TraceEvent MUST NOT include: full bank descriptions, condition values (e.g., the regex pattern, the amount threshold), API keys, personal data. The contract is:
- uleId — safe (opaque identifier)
- conditionType — safe (enum)
- score — safe (numeric)
- matched — safe (boolean)

If richer detail is needed later, it must be explicitly configured/opted-in.

### Key Questions Answered

1. **What specific intermediate data does each stage produce that should be traced?**
   - Pipeline: number of rules available, count collected, per-rule evaluations (conditionType, score, matched), valid/discarded per rule.
   - Scoring: per-candidate specificityScore (tier, weight) and matchQuality.
   - Ranking: final ordered list of ruleIds.
   - Decision: outcome type, winner ruleId, delta, threshold, explanation.

2. **Where does AuditRecord get populated?**
   - companyId and 	ransactionId come from input.transaction (present in RuleInput).
   - esult, winnerRuleId come from the EngineDecision.
   - candidateCount comes from decision.candidateList.length.
   - 	race comes from the DecisionTrace built during execution.
   - ngineVersion comes from a new ENGINE_VERSION constant (to be defined, e.g., "2.0.0").

3. **How to version DecisionTrace?**
   - Define a ENGINE_VERSION constant in lag.ts or a new ersion.ts. Initial value: "2.0.0".
   - The ngineVersion field goes into both DecisionTrace and AuditRecord.
   - The string format follows semver: "<major>.<minor>.<patch>". Major bumps for breaking trace schema changes, minor for additive changes.

4. **What is the serialization contract for TraceEvent union?**
   - TraceEvent is a discriminated union on stage + vent (two discriminators, but vent is specific enough within each stage).
   - For JSON serialization (e.g., storing in DB or sending to frontend), the union serializes cleanly because all fields are plain JSON-safe values.

5. **How does trace-on-error work without breaking pure function contract?**
   - The orchestrator catches RuleEngineError, attaches the partial 	raceEvents array (which holds all events up to the failure point), and re-throws.
   - The error itself gets a 	race property. The engine still throws — no change to error semantics.
   - Inside each stage, the stage catches its own errors, emits whatever trace events it has, then re-throws. The orchestrator weaves partial trace.

6. **What existing tests need updating vs new tests needed?**
   - **Update**: All tests in index.test.ts that call valuateRules() — they assert { candidates, decision } but will now get { output: { candidates, decision }, artifacts: { trace, audit } }.
   - **New unit tests**: Trace events from unPipeline, scoreCandidates, ankCandidates, makeDecision.
   - **New unit tests**: AuditRecord construction (correct mapping from input + decision + trace).
   - **New unit tests**: Trace-on-error for each typed error (InvalidPipelineStateError, MissingEntityIdError, InvalidRegex).
   - **New unit tests**: DecisionTrace structure (engineVersion, ordered events).
   - **New unit tests**: sensitivity policy (no sensitive data in trace events).
   - **Update**: ixtures.ts — add factory helpers for TraceEvent, DecisionTrace, AuditRecord, RuleEngineResult.

### Risks

- **Trace bloat**: Each invocation produces N trace events (1 per condition evaluation per rule + 1 per candidate score + final events). For a company with 50 rules each with 5 conditions, that is ~250 events per invocation. Mitigation: TraceEvent is lightweight (5 fields max), and the trace is returned in-memory, not persisted by the engine. The consumer chooses what to store.
- **Performance overhead**: Building trace events means more object allocations per invocation. Mitigation: (1) no I/O, no serialization in the engine — trace is just an array of plain objects; (2) benchmarking should confirm sub-millisecond overhead; (3) if needed, trace building can be gated behind a feature flag (but this adds complexity).
- **Breaking existing consumers**: valuateRules() currently returns RuleOutput. Changing to RuleEngineResult { output, artifacts } breaks all existing callers. Mitigation: verify callers of valuateRules() in the codebase (likely only import.service.ts and test files) and update them. The output property preserves backward-compatible shape.
- **Sensitivity review**: TraceEvent must not leak full description values, condition values (regex patterns, amount thresholds), API keys, or personal data. The current proposal only includes ruleId, conditionType, score, matched — all safe. But a code review must verify no stage accidentally passes raw values. Mitigation: the type definition itself enforces the contract (no alue field in trace events). Add a dedicated test that serializes a trace and checks for sensitive patterns.
- **Error-trace coupling**: If the wrapper pattern is not used consistently, partial trace may not be available on error paths. Mitigation: the orchestrator (index.ts) must always catch before the final return. Stage-internal errors propagate through the stack naturally — the orchestrator catches them and attaches whatever events were collected so far.
- **DecisionTrace size on wire**: If the RuleEngineResult is sent to a client (e.g., via API), the trace array could be large. Mitigation: that is a consumer concern, not the engine's. The engine returns it; the consumer decides what to serialize.

### Ready for Proposal

Yes. The exploration is comprehensive and the approach is clear. The orchestrator should tell the user:

1. **Option A (Pipeline-as-Weave) is the only viable approach** given the pure-function architecture constraint (axiom #6). The Collector pattern is disallowed.
2. **The main effort is mechanical**: changing stage return types to [Result, TraceEvent[]], updating valuateRules() to weave trace and build audit, adding new types, and updating tests.
3. **The sensitivity policy is built into the type definition** — TraceEvent physically cannot include sensitive fields unless explicitly added.
4. **No DB, no I/O, no side effects** — the engine stays pure. AuditRecord is generated synchronously in memory.
5. **The stale AuditLogEntry type** in 	ypes.ts should be either removed or aliased to the new AuditRecord to avoid confusion.
6. **A new ENGINE_VERSION constant** needs to be defined (propose "2.0.0").
