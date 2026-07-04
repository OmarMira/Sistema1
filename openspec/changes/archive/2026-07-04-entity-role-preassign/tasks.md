# Tasks: Entity Role Pre-Assignment

## Change Metadata

| Field | Value |
|-------|-------|
| **Change Name** | entity-role-preassign |
| **Delivery Strategy** | single-pr |
| **Review Budget** | ok |
| **Estimated Total Δ** | ~180 lines (+150 / -30) |
| **Files Changed** | 8 (7 modify, 1 create) |

---

## Task 1: Prisma Schema — add fields

| Field | Value |
|-------|-------|
| **id** | `entity-role-preassign--01-schema` |
| **title** | Add `autoRoleAssignment` to Company and `autoAssignedAt` to EntityContext |
| **files** | `prisma/schema.prisma` |
| **description** | Add `autoRoleAssignment Boolean @default(false)` to the Company model. Add `autoAssignedAt DateTime?` to the EntityContext model. Run `npx prisma db push` to sync the local DB. No data migration needed — defaults handle existing rows. |
| **acceptance criteria** | Schema validates. Local DB has new columns. Existing companies have `autoRoleAssignment = false`. Existing EntityContext rows have `autoAssignedAt = null`. |
| **estimated Δ** | +4 lines |

---

## Task 2: entity-context-service.ts — accept and persist `autoAssignedAt`

| Field | Value |
|-------|-------|
| **id** | `entity-role-preassign--02-context-service` |
| **title** | Add optional `autoAssignedAt` to `saveContext()` data param |
| **files** | `src/lib/services/entity-context-service.ts` |
| **description** | Add `autoAssignedAt?: Date` to the `saveContext()` function's `data` parameter type. Include it in the upsert `update` and `create` objects. Also include it in the audit log details payload. This is a purely additive change — no existing callers pass this field, so behavior for current callers is identical. |
| **acceptance criteria** | `saveContext()` accepts optional `autoAssignedAt`. When provided, it is persisted on the EntityContext row. When omitted, existing behavior is unchanged. |
| **estimated Δ** | +5 lines |

---

## Task 3: entity-classifier.ts — add `autoAssign` input + bypass source gate

| Field | Value |
|-------|-------|
| **id** | `entity-role-preassign--03-classifier` |
| **title** | Add `autoAssign` to `ClassifyEntityInput` and bypass source gate for BankRule creation |
| **files** | `src/lib/services/entity-classifier.ts` |
| **description** | Add `autoAssign?: boolean` to the `ClassifyEntityInput` interface. In `classifyEntity()`, destructure `autoAssign` from input. Change the BankRule creation gate from `if (source === 'user')` to `if (source === 'user' || autoAssign)`. When `autoAssign` is true, pass `autoAssignedAt: new Date()` in the `saveContext()` call. |
| **acceptance criteria** | When `autoAssign` is false/undefined, behavior is identical to today (only `source === 'user'` triggers BankRule creation). When `autoAssign` is true, BankRule is created regardless of source AND `autoAssignedAt` is set on the context. |
| **estimated Δ** | +7 lines (1 import change, 1 interface field, 3 destructure/gate, 2 autoAssignedAt pass-through) |

---

## Task 4: suggest-role/route.ts — conditional confidence cap + autoAssign signal

| Field | Value |
|-------|-------|
| **id** | `entity-role-preassign--04-suggest-role` |
| **title** | Query `autoRoleAssignment` flag and conditionally remove confidence cap |
| **files** | `src/app/api/learning/suggest-role/route.ts` |
| **description** | After the AI result is obtained and before capping (around line 367), query the Company model for `autoRoleAssignment` using `companyId`. If `autoRoleAssignment` is true: skip the `Math.min(..., 0.69)` cap entirely (let confidence flow naturally). If `autoRoleAssignment` is true AND final confidence >= 0.9: add `autoAssign: true` to the response JSON. If flag is false: existing 0.69 cap stays, no `autoAssign` key in response. If confidence < 0.9 even with flag on: return normal response (no `autoAssign` key, but with uncapped confidence). Also add `autoAssign` field to the local DB match result (set to `true` when `autoRoleAssignment` is true AND the local match confidence is >= 0.9, otherwise omit). |
| **acceptance criteria** | Flag off → 0.69 cap, no `autoAssign`. Flag on + confidence >= 0.9 → no cap + `autoAssign: true`. Flag on + confidence < 0.9 → no cap, no `autoAssign`. Local matches also respect the flag when confidence >= 0.9. |
| **estimated Δ** | ~25 lines |

---

## Task 5: classify-entity/route.ts — accept `autoAssign` from request body

| Field | Value |
|-------|-------|
| **id** | `entity-role-preassign--05-classify-route` |
| **title** | Parse `autoAssign` from request body and pass to `classifyEntity()` |
| **files** | `src/app/api/learning/classify-entity/route.ts` |
| **description** | Add `autoAssign` to the destructured body variables (line 19). Pass `autoAssign` in the `classifyEntity()` call (around line 87–98). No validation needed — `autoAssign` is optional and boolean. |
| **acceptance criteria** | When `autoAssign: true` is sent in the request body, it reaches `classifyEntity()`. When omitted, undefined is passed (existing behavior preserved). |
| **estimated Δ** | +3 lines |

---

## Task 6: New rollback endpoint

| Field | Value |
|-------|-------|
| **id** | `entity-role-preassign--06-rollback` |
| **title** | Create `POST /api/learning/auto-assignments/[id]/rollback` |
| **files** | `src/app/api/learning/auto-assignments/[id]/rollback/route.ts` (create) |
| **description** | Create a new POST route. Handler: (1) Load EntityContext by id from params. Return 404 if not found. (2) Verify `autoAssignedAt` is not null. Return 400 `"Cannot rollback manual assignment"` if null. (3) In order: find and delete the linked BankRule where `entityContextId = id`, then delete the EntityContext. (4) Create audit log entry via `safeAuditLog` with action `'AUTO_ASSIGNMENT_ROLLBACK'`, entity `'EntityContext'`. (5) Return `{ success: true, message: "Auto-assignment rolled back" }`. Use the same `apiHandler` wrapper with `requireMembership: false` (same as suggest-role). |
| **acceptance criteria** | POST to endpoint with valid auto-assigned id → 200, both records deleted, audit log written. POST with manual-assignment id → 400. POST with non-existent id → 404. |
| **estimated Δ** | ~50 lines (new file) |

---

## Task 7: EntityOnboardingModal.tsx — auto-assign handling + toast + rollback

| Field | Value |
|-------|-------|
| **id** | `entity-role-preassign--07-frontend` |
| **title** | Handle `autoAssign: true` from suggest-role, show toast with "Deshacer" button, call rollback |
| **files** | `src/components/learning/EntityOnboardingModal.tsx` |
| **description** | In `handlePreClassify()`: — After suggest-role returns (line 354–364), check if the response includes `autoAssign: true`. — If true: directly call `POST /api/learning/classify-entity` with `autoAssign: true` (plus companyId, pattern, role from suggestion). Skip the grid/approval flow for that entity. — On classify success: show toast via `toast.success()` with format `"{name} → {role} ({confidence}%)"`. Append a "Deshacer" button using `sonner` toast action: `toast.success(msg, { action: { label: "Deshacer", onClick: () => rollbackFn(id) } })`. — `rollbackFn`: `POST /api/learning/auto-assignments/[classifyResult.context.id]/rollback`. On rollback success, the entity should reappear in the pending list (re-fetch candidates or add back to candidates state). — On classify failure: show error toast, entity stays in pending list. — Entities handled via auto-assign should NOT be included in the manual save batch later (mark them as saved). |
| **acceptance criteria** | When suggest-role returns `autoAssign: true`, classify-entity is called automatically, toast appears with "Deshacer", clicking "Deshacer" calls rollback, entity reappears in pending list. Flag off or confidence < 0.9: existing flow unchanged. |
| **estimated Δ** | ~80 lines |

---

## Task 8: Build + Verify

| Field | Value |
|-------|-------|
| **id** | `entity-role-preassign--08-build-verify` |
| **title** | Run TypeScript build and existing tests |
| **files** | N/A (verification step) |
| **description** | Run `npm run build` to confirm all TypeScript compiles cleanly. Run `npm test` (or equivalent test runner) to confirm existing tests still pass. Fix any type errors or test failures. |
| **acceptance criteria** | `npm run build` exits with code 0. All existing tests pass. |
| **estimated Δ** | 0 lines (may include minor fixes if build fails) |

---

## Dependency Graph

```
Task 1 (schema) ──→ Task 2 (context service) ──→ Task 3 (classifier)
                                                      │
Task 4 (suggest-route) ───────────────────────────────┤
                                                      │
Task 5 (classify-route) ──────────────────────────────┤
                                                      │
                                                      └──→ Task 6 (rollback) ──→ Task 7 (frontend)
                                                                                    │
                                                                              Task 8 (build)
```

Tasks 2, 4, 5 are independent after Task 1. Task 3 depends on Task 2. Task 6 is independent. Task 7 depends on all API tasks (4, 5, 6) and Task 3.

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Build fails due to TS strict mode | Low | All changes are additive, no breaking type changes |
| Existing tests fail | Very Low | No existing behavior is modified — only additive conditions |
| Frontend toast i18n missing key | Low | Use inline Spanish strings for "Deshacer" (design approved); no i18n required for the action button |
| Race condition in rollback | Low | Sequential delete (BankRule then EntityContext) with explicit order |
