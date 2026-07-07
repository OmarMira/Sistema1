# UX Hardening Sprint — Entity Onboarding Modal

**Date**: 2026-07-05
**Status**: ✅ COMPLETED (MVP)

> Cerrado tras completar UX-01 a UX-05 + UX-10. UX-06 a UX-09 diferidos a UX Sprint 2, después de usar el sistema con datos reales y recopilar feedback.

## Sprint Type

```
☐ Architecture
☐ Feature
☑ UX Hardening
```

## Allowed Changes

- Labels
- Copy
- Icons
- Button wording
- Layout
- Accessibility
- Loading states
- Empty states
- Visual hierarchy
- Animations
- Tests (only as needed to match the above)

## Forbidden Changes

- Database
- Prisma
- APIs
- Business Rules
- Rule Matcher
- Company Knowledge
- EntityContext
- LLM prompts
- Domain model
- EntityRole enum values
- TransactionIntent values
- Backend contracts

---

## Goal

Improve the usability of EntityOnboardingModal without changing domain behavior, backend contracts or business rules.

---

## Scope

- Copy and label polish
- Visual hierarchy (role vs intent prominence)
- Footer wording based on remaining entities
- Loading and error state consistency
- Empty state clarity
- Accessibility (keyboard nav, contrast, aria)
- Responsive behavior
- Button semantics

---

## Out of Scope

- EntityContext
- Company Knowledge
- Suggest-role prompt
- Rule engine
- TransactionIntent
- EntityRole
- Database / Prisma
- APIs / Routes
- Feature flags
- Domain model changes

---

## Exit Criteria

- No behavior changes
- No API changes
- No schema changes
- No domain changes
- Existing tests remain green
- TypeScript clean (`tsc --noEmit`)
- UX review completed
- Accessibility review completed

---

## Task List

| ID | Task | Description |
|----|------|-------------|
| UX-01 | Rename primary AI action | `Pre clasificar` → `Sugerir rol` (es) / `Suggest role` (en) |
| UX-02 | Rename manual action | `Seleccionar manualmente` → `Asignar rol manualmente` (es) / `Assign role manually` (en) |
| UX-03 | Intent visual hierarchy | Reduce intent label/dropdown prominence (smaller, more subtle) |
| UX-04 | Footer dynamic wording | `Guardar clasificación` (1 entity) / `Guardar clasificaciones` (many) |
| UX-05 | Verify `learning.selectRole` resolves | Confirm rebuild picks up i18n, no literal keys on screen |
| UX-06 | Loading consistency | Ensure all loading states use same spinner + label pattern |
| UX-07 | Error consistency | Ensure error banners are uniform across entities |
| UX-08 | Accessibility | Keyboard nav, focus trapping, aria labels on dynamic sections |
| UX-09 | Visual review | Responsive, spacing, contrast, alignment pass |
| UX-10 | Final review | Re-run tests, tsc, confirm exit criteria |

---

## Apply Log

| Date | Task | Status |
|------|------|--------|
| 2026-07-05 | UX-01 | Done |
| 2026-07-05 | UX-02 | Done |
| 2026-07-05 | UX-03 | Done |
| 2026-07-05 | UX-04 | Done |
| 2026-07-05 | UX-05 | Done |
| 2026-07-05 | UX-06 | Pending |
| 2026-07-05 | UX-07 | Pending |
| 2026-07-05 | UX-08 | Pending |
| 2026-07-05 | UX-09 | Pending |
| 2026-07-05 | UX-10 | Done |

## Verify Log

| Date | Check | Result |
|------|-------|--------|
| 2026-07-05 | All existing tests pass | ✅ 28/28 |
| 2026-07-05 | TypeScript clean | ✅ tsc clean |
| 2026-07-05 | No behavior changes | |
| 2026-07-05 | No API/schema/domain changes | |
