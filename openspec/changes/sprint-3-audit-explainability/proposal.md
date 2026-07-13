# Proposal: Sprint 3 — Audit + Explainability

## Intent

Why now: (1) engine needs observability before Import Service/UI integration, (2) structured traces are the debug foundation for future sprints (AI bridge, rule suggestions), (3) `EngineDecision` has skeleton fields but produces no structured evidence — engine is a black box today.

## Scope

**In:** `DecisionTrace` with ordered `TraceEvent[]` (discriminated union) · NO generic value/payload/metadata · `AuditRecord` per invocation (zero I/O) · `MAX_TRACE_EVENTS` + `truncated` flag (final + error events survive) · Partial trace on `RuleEngineError` · `RULE_ENGINE_VERSION` constant (`2.1.0`) · Serializable types · Full test coverage · Review/replace stale `AuditLogEntry` (`types.ts:121`)

**Out:** DB persistence · Queues · UI · Import Service · AI bridge · Metrics · External logging · Retention · Lifecycle

## Capabilities

No rule-engine specs exist — new capability.

- `rule-engine-audit`: Structured audit trail and explainability for rule engine v2. Covers DecisionTrace, AuditRecord, truncation, error trace, serialization.

## Approach

**Pipeline-as-Weave** (Option A). Each stage returns `[Result, TraceEvent[]]`. Orchestrator weaves into `DecisionTrace`, builds `AuditRecord`, returns `RuleEngineExecution { output, trace, audit }`. Try/catch attaches partial trace to thrown `RuleEngineError`.

## Affected Areas

| File | Change |
|------|--------|
| `types.ts` | Add 4 types. Replace `AuditLogEntry`. |
| `index.ts` | Weave trace, build audit, new envelope, error wrapper. |
| `pipeline.ts` | Return `[PipelineArtifacts, TraceEvent[]]` |
| `scoring.ts` | Return `[ScoredCandidate[], TraceEvent[]]` |
| `ranking.ts` | Return `[ScoredCandidate[], TraceEvent[]]` |
| `decision.ts` | Return `[EngineDecision, TraceEvent[]]` |
| `errors.ts` | Add `trace?: DecisionTrace` |
| `__tests__/` | Update assertions + new trace/audit tests per stage + fixtures |

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Trace bloat (250+ events) | Med | ≤5 fields, primitives. No engine persistence. |
| Breaking callers | High | `output` preserves shape. Mechanical updates. |
| Sensitivity leak | Low | Type bans value/payload. Scanning test. |
| Partial error trace gaps | Low | Single wrapper in `index.ts`. |

## Rollback Plan

Revert `evaluateRules()` to `RuleOutput`. Remove types, `trace` from `RuleEngineError`, version constant. Restore stage signatures. All via `git revert`.

## Dependencies

None. Pure engine — zero deps, zero I/O.

## Success Criteria

- [ ] All 5 stages emit correct `TraceEvent[]`
- [ ] `DecisionTrace` is deterministic and ordered
- [ ] `AuditRecord` maps input + decision correctly
- [ ] Truncation preserves final + error events
- [ ] Partial trace on `RuleEngineError` on error paths
- [ ] No `value`/`payload`/`metadata` in `TraceEvent`
- [ ] No I/O or side effects in engine code
- [ ] Existing tests pass with mechanical updates
- [ ] `AuditLogEntry` removed or replaced (not aliased)
