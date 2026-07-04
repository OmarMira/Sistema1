# Design: Entity Role Pre-Assignment

## Technical Approach

Surgical additive change: add a per-company opt-in flag (`autoRoleAssignment`) that acts as an escape hatch on the existing 0.69 confidence gate in suggest-role. When the flag is on and decision-engine confidence >= 0.9, the response signals `autoAssign: true` to the frontend, which then calls classify-entity with the new `autoAssign` param. classify-entity bypasses the `source === 'user'` guard for BankRule creation and stamps `autoAssignedAt`. A rollback endpoint undoes auto-assignments only. Default behavior (flag off) is identical to today.

## Architecture Decisions

### Decision: Field name `autoRoleAssignment` (not `autoAssignRoles`)

| Option | Tradeoff |
|--------|----------|
| `autoAssignRoles` (from proposal) | Ambiguous — suggests assigning multiple roles |
| `autoRoleAssignment` (from spec) | Clear: one role auto-assignment per entity |

**Choice**: `autoRoleAssignment` — matches spec and communicates intent precisely.

### Decision: Frontend drives classify-entity, not suggest-role

| Option | Tradeoff |
|--------|----------|
| suggest-role calls classifyEntity internally | Sugg-role has no auth (`requireMembership: false`), no audit logging, violates separation of concerns |
| Frontend calls classify-entity with `autoAssign: true` | Uses existing auth/middleware stack, clean audit trail, minimal change to suggest-role |

**Choice**: suggest-role returns `autoAssign: true` as a signal; frontend executes the classify call.

### Decision: Rollback as separate endpoint (not Prisma cascade)

BankRule's `entityContextId` has `onDelete: SetNull`. We need explicit delete of both records. A dedicated endpoint gives us audit logging and the `autoAssignedAt` guard.

### Decision: `source` stays `'user'`, `autoAssignedAt` is the discriminator

Proposal suggested `source='system'` but that would require changing the classifier's guard condition. Using a new `autoAssignedAt` timestamp field is zero-risk — no existing code reads it, and the classifier simply checks `|| autoAssign` instead of changing the source-based guard.

## Data Flow

### Scenario A: Flag off (existing flow)

```
Frontend ──POST /suggest-role──→ Route ──→ AI (0.69 cap) ──→ { suggestedRole, confidence: 0.69 }
Frontend ←─ show banner (manual) ──→ User confirms ──→ POST /classify-entity (source='user') ──→ saveContext + autoCreateRule
```

### Scenario B: Flag on, confidence >= 0.9 (auto-assign)

```
Frontend ──POST /suggest-role──→ Route (reads autoRoleAssignment=true, no cap)
  ──→ AI returns 0.94 ──→ { suggestedRole, confidence: 0.94, autoAssign: true }
Frontend ──POST /classify-entity (autoAssign: true)──→ classifyEntity()
  ──→ saveContext(autoAssignedAt: now()) ──→ autoCreateRule()
Frontend ←─ toast "Deshacer" ──→ User clicks ──→ POST /auto-assignments/[id]/rollback
  ──→ delete BankRule ──→ delete EntityContext ──→ audit log
```

### Scenario C: Flag on, confidence < 0.9 (manual fallback)

```
Frontend ──POST /suggest-role──→ Route (reads autoRoleAssignment=true, no cap)
  ──→ AI returns 0.85 ──→ { suggestedRole, confidence: 0.85 } (no autoAssign key)
Frontend ←─ show banner (manual, uncapped confidence) ──→ User decides
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | Add `autoRoleAssignment` to Company, `autoAssignedAt` to EntityContext |
| `src/app/api/learning/suggest-role/route.ts` | Modify | Query flag; conditional cap; return `autoAssign: true` when flag on & >= 0.9 |
| `src/app/api/learning/classify-entity/route.ts` | Modify | Accept `autoAssign?: boolean` in request body; pass to classifyEntity() |
| `src/lib/services/entity-classifier.ts` | Modify | Add `autoAssign` to `ClassifyEntityInput`; bypass source gate for BankRule creation when true |
| `src/lib/services/entity-context-service.ts` | Modify | Accept and persist `autoAssignedAt` in `saveContext()` |
| `src/app/api/learning/auto-assignments/[id]/rollback/route.ts` | Create | Rollback endpoint (DELETE), guarded by `autoAssignedAt` |
| `src/components/learning/EntityOnboardingModal.tsx` | Modify | Handle `autoAssign: true` in suggest-role response; skip grid; toast + Deshacer |

## Interfaces / Contracts

### New rollback endpoint

```
DELETE /api/learning/auto-assignments/{id}/rollback

Response 200: { success: true, message: "Auto-assignment rolled back" }
Response 400: { error: "Cannot rollback manual assignment" }
Response 404: { error: "Entity context not found" }
```

### Extended classify-entity request body

```typescript
interface ClassifyEntityRequest {
  // ... existing fields ...
  autoAssign?: boolean;  // NEW: when true, bypasses source='user' guard for BankRule
}
```

### Updated suggest-role response (additive)

```typescript
interface SuggestRoleResponse {
  suggestedRole: string;
  confidence: number;
  explanation: string;
  autoAssign?: true;  // NEW: only present when autoRoleAssignment=true AND confidence >= 0.9
}
```

### Extended ClassifyEntityInput

```typescript
// In entity-classifier.ts, add to existing interface:
export interface ClassifyEntityInput {
  // ... existing fields ...
  autoAssign?: boolean;  // NEW
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `suggest-role` confidence cap logic | Mock DB flag; test 3 cases (flag off, flag on >= 0.9, flag on < 0.9) |
| Unit | `classifyEntity` with `autoAssign: true` | Verify `autoCreateRule` is called, `autoAssignedAt` is set |
| Unit | Rollback guard | Verify 400 when `autoAssignedAt` is null |
| Integration | Full auto-assignment flow | Fake DB seed: flag on, AI returns 0.94; assert EntityContext + BankRule created with autoAssignedAt |
| Integration | Rollback deletes both records | Assert BankRule and EntityContext removed, audit log written |
| E2E | Toast + Deshacer | Cypress: set flag on, trigger pre-classify, verify toast, click Deshacer, verify entity reappears |
| E2E | Flag off regression | Assert existing manual flow is identical |

## Migration / Rollout

No schema data migration required. `autoRoleAssignment` defaults to `false` — existing companies are unaffected. `autoAssignedAt` defaults to `null`. Run `npx prisma migrate dev --name add_auto_role_assignment` to generate the migration.

## Open Questions

- [ ] Should the suggest-role confidence cap be removed entirely for flagged companies, or only evaluated at the >= 0.9 threshold? Decision: remove cap entirely — the frontend still gates on `autoAssign: true` for auto-flow, and users see the real confidence for manual decisions.
- [ ] Confirm: rollback should use DELETE verb (idempotent, semantically correct) vs POST. Decision: POST — avoids webserver/body-parser issues with DELETE bodies, simpler.

## Review Workload Forecast

- Line budget: ~150 additions, ~30 deletions (~180 total) — well under 400-line threshold
- Chained PRs: Not needed
- Risk: Low
