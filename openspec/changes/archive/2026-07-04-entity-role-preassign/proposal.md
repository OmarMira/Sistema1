# Proposal: Entity Role Pre-Assignment

## Intent

Enable optionally automatic role assignment and BankRule creation when the system's confidence is high enough, eliminating unnecessary manual confirmation for high-certainty classifications. Currently the system is intentionally gated at 3 points to require human confirmation. This proposal adds an opt-in escape hatch per company.

## Scope

### In Scope
- Per-company `autoAssignRoles` flag on Company model (default false)
- Remove AI confidence cap (0.69) in suggest-role when flag enabled
- Decision-engine-driven auto-assignment: create EntityContext + BankRule when confidence >= 0.9
- Extend `autoCreateRule` guard to allow source='system'
- Frontend handling of auto-assigned responses (skip confirmation banner)

### Out of Scope
- UI redesign or removal of manual mode
- Changes to deterministic rule-matching engine
- Background jobs or async processing
- Changes to signal collection or decision-engine algorithms
- Confidence threshold customization (hardcoded at 0.9)

## Capabilities

### New Capabilities
- `auto-role-assignment`: Per-company opt-in flag enabling the system to auto-create EntityContext and BankRule when decision-engine confidence >= 0.9, without manual UI confirmation.

### Modified Capabilities
None (additive behavior — no existing spec-level requirements change)

## Approach

Three surgical changes targeting the 3 intentional gates:

1. **Schema**: Add `autoAssignRoles` boolean to Company (default false)
2. **suggest-role (gate 1)**: When flag enabled, replace 0.69 cap with decision-engine evaluation. If confidence >= 0.9, auto-classify via `classifyEntity(source='system')` and return `{ autoAssigned: true }`.
3. **classifyEntity (gate 2)**: Extend `autoCreateRule` to also fire for source='system' (currently only 'user')
4. **EntityOnboardingModal (gate 3)**: When suggest-role returns `autoAssigned: true`, skip confirmation — mark saved and refresh list.

The decision-engine's existing Rule 1 (>= 0.9 confidence → highest signal) becomes the auto-assignment trigger. No changes to signal weights or decision logic needed: entity_context with GL account (0.95) and heuristic exact-match (0.9) already cross the threshold. AI alone stays below 0.9 because its raw signal maxes at 0.85 (with GL code) or 0.6 (without).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | Add `Company.autoAssignRoles Boolean @default(false)` |
| `src/lib/services/entity-classifier.ts` | Modified | Allow `autoCreateRule` for source='system' |
| `src/app/api/learning/suggest-role/route.ts` | Modified | Conditional confidence cap + auto-assignment |
| `src/components/learning/EntityOnboardingModal.tsx` | Modified | Handle `autoAssigned: true` response |
| `src/lib/services/decision-engine.ts` | Unchanged | Rule 1 already correct for >= 0.9 |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Incorrect BankRule auto-created | Low | Triggers only at >= 0.9 confidence; reliable signals |
| Manual flow regression | Low | Flag defaults false; manual code path unchanged |
| AI bypasses guard via entity_context backing | Low | That's correct behavior — AI alone stays < 0.9 |

## Rollback Plan

Set all companies' `autoAssignRoles = false`, or revert the 3 code changes independently.

## Dependencies

- Prisma migration to add `Company.autoAssignRoles`

## Success Criteria

- [ ] Flag disabled: all existing flows work identically
- [ ] Flag enabled: entity with entity_context (0.95) auto-classifies without UI confirmation
- [ ] Flag enabled: AI-only suggestions (capped) do NOT auto-classify
- [ ] Auto-assigned entities persist EntityContext + BankRule correctly
