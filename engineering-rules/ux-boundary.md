# UX Boundary

## Origin

This rule was extracted from a real engineering problem encountered during the development of Account Express.

It was not created as a theoretical guideline.

It became a permanent engineering rule only after being validated through multiple implementation cycles and proving effective at preventing scope creep and regressions.

Engineering Rules are extracted from successful engineering practice, not invented in advance.

## Purpose

Define the boundary between a UX Sprint and any other type of engineering work.

## Engineering Rule

If implementing a change requires modifying control flow, execution logic, application state, side effects, data access or business rules, it is outside the UX boundary.

## Decision Rule

If you need to think about logic, you are no longer doing UX.

## Allowed

- Copy
- Labels
- Localization
- CSS
- Layout
- Icons
- Accessibility
- Visual hierarchy
- Empty states
- Loading indicators (presentation only)

## Forbidden

- Business rules
- API changes
- Database changes
- Queries
- State management
- Event handlers
- Hooks
- Validation logic
- AI prompts
- Rule engines

## Examples

### ✅ Belongs to UX Sprint

Changing a button label from "Pre clasificar" to "Sugerir rol".

No logic change. Simple copy improvement.

### ✅ Belongs to UX Sprint

Adding `aria-label="Guardar"` to an icon-only button.

No logic change. Accessibility improvement.

### ❌ Does not belong to UX Sprint

Showing different error messages based on error code (AI_TIMEOUT vs PARSE_FAILED vs INVALID_ROLE).

Requires `if` branching and error code interpretation. This is a feature change.

### ❌ Does not belong to UX Sprint

Disabling a button based on a new validation condition.

Requires state and control flow changes. This is a feature change.

## Status

**Status:** Active  
**Scope:** Entire project  
**Applies to:** Architecture Sprints, Feature Sprints, UX Sprints, Hotfixes  
**Version:** 1.0  
**Origin Date:** 2026-07

## History

Created after the Entity Onboarding redesign
to prevent UX work from accidentally becoming
feature work.

Validated during:

- Company Knowledge v1
- Role-first Hotfix
- UX Sprint 1
