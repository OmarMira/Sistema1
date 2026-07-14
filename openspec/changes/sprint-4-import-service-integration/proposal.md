# Proposal: Sprint 4 — Import Service Integration

## Intent

Integrate Rule Engine v2 into the banking import flow behind a feature flag, replacing the legacy single-rule matcher at `import.service.ts:446`. Pure architecture — no AI, no persistence. The adapter pattern preserves the engine's functional core while layering I/O invariants (skip already-classified, committed, reconciled, or ignored transactions).

## Scope

### In Scope

- Call site adapter at `import.service.ts:446` — replace `findMatchingRule()` with `runRuleEngineV2()`
- Feature flag gating via `RULE_ENGINE_V2_ENABLED` env var
- Protection invariants: skip transactions that are already classified, linked to journal entry, reconciled, or ignored
- `BankRule.conditions` format verification — physically check v1 storage format; add typed adapter if mixed formats exist
- Decision mapping: extract full `classification` object (future-proof for Sprint 5)
- Auto-apply: winner → create journal entry (current policy, no confidence gate)
- Trace/audit: `logger.debug()` in-memory only — explicitly NOT persisted
- E2E integration tests: flag OFF, flag ON + winner/ambiguous/no_match/error

### Out of Scope

- AI fallback or suggestion
- Trace/audit persistence to database
- Confidence computation (`Candidate.confidence = 0` placeholder)
- Parallel engine execution / A/B comparison in production
- Runtime feature flag service (env var only)
- API routes or UI changes
- Engine core changes (pure function unchanged)

## Capabilities

### New Capabilities

- `rule-engine-integration`: Adapter layer between Import Service and Rule Engine v2 — type mapping, flag gating, invariant checks, error handling, trace capture

### Modified Capabilities

None

## Approach

**Execution order**:
1. Skip invariants — skip already-classified, journal-linked, reconciled, ignored, manually-edited
2. Adapter mapping — construct v2 `Transaction`, cast `BankRule` types
3. Rule Engine — invoke `evaluateRules()`
4. Decision mapping — extract full `classification` object (not just `glAccountId` — future-proof for Sprint 5 entityId, category, explanation)
5. Journal entry — auto-apply if winner

**Error handling (flag ON)**: Engine throws → adapter catches → `null` result + warning log → transaction stored pending. NO automatic fallback to legacy engine. Error is visible, not hidden. Parallel execution is never used — flag ON means v2 exclusively.

**Decision mapping**:
| Engine Decision | Import Service Outcome |
|-----------------|----------------------|
| `winner` + `classification` | Create journal entry (auto-apply) |
| `ambiguous` | Store without journal entry (pending) |
| `no_match` | Store without journal entry (pending) |
| `error` | Store without journal entry (pending, warning logged) |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/services/import.service.ts` | Modified | Replace `findMatchingRule()` call at line 446 with adapter call |
| `src/lib/services/rule-engine-adapter.ts` | New | Adapter: type mapping, flag check, invariants, error handling |
| `src/lib/rule-engine/index.ts` | Unchanged | Pure function consumed by adapter |
| `src/lib/rule-engine/flag.ts` | Unchanged | Env flag already in place |
| `tests/integration/` | New | E2E tests for all flag + decision combinations |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `BankRule.conditions` format mismatch | Medium | Physically verify before coding; add typed adapter if mixed formats exist |
| v2 engine error crashes import | Low | Adapter catches errors → graceful degradation (null result, logged) |
| Performance regression | Low | v2 engine overhead vs single-rule match — benchmark before merge |
| Accidental reclassification | Low | Invariant checks skip already-processed txns |

## Rollback Plan

Set `RULE_ENGINE_V2_ENABLED=false` → legacy `findMatchingRule()` resumes immediately. No data migration needed — v2 doesn't persist anything.

## Dependencies

- `BankRule.conditions` format verified against production data (pre-coding step)
- Rule Engine v2 must be importable as a dependency (already in project)

## Success Criteria

- [ ] All existing import tests pass with flag OFF (behavior unchanged)
- [ ] flag ON + winner → journal entry created (same as legacy)
- [ ] flag ON + ambiguous → transaction stored without journal entry (pending)
- [ ] flag ON + no_match → transaction stored without journal entry (pending)
- [ ] flag ON + engine throws → import continues, no journal entry, warning logged, transaction pending
- [ ] Already classified/reconciled/ignored transactions are skipped regardless of flag
- [ ] Adapter contains zero accounting logic — only mapping, invariants, orchestration, error handling
- [ ] 500-word budget
