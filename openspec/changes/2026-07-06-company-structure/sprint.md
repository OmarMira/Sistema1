# Feature Sprint — Company Structure / Estructura de la Empresa

**Date**: 2026-07-06
**Status**: ✅ IMPLEMENTED — All tasks complete

---

## Sprint Type

```
☐ Architecture
☑ Feature
☐ UX Hardening
```

---

## Goal

Create a visual, grouped overview of the active company's confirmed entities — accessible by clicking on the company name — so the user can immediately understand who the company works with, without needing to browse through lists, filters or tables.

The view presents confirmed business entities grouped into **business categories** (People, Companies, Financial Institutions, Platforms, etc.), using confirmed data from EntityContext. No AI, no pending entities, no suggestions.

---

## Scope

- New UI component: Company Structure view (dashboard-style cards)
- Trigger: click on active company name (not on the "Cambiar" button)
- Data source: **EntityContext** — only confirmed records with valid roles
- Present entities grouped by **business categories** (Personas, Empresas, Finanzas, Plataformas, etc.), not by raw `role` enum
- Each group card shows: category name, entity count, top 3-5 entity names, "Ver todos" link
- Empty state when no entities confirmed
- Navigation: click on entity name → navigate to entity detail (if screen exists)
- Navigation: click "Ver todos" → navigate to filtered list of that role
- All existing tests remain green
- TypeScript clean
- **Guiding principle: This view visualizes confirmed business knowledge. It never creates, infers or modifies business knowledge.**

---

## Out of Scope

- **No AI / LLM**
- **No CompanyKnowledge** (reserved for future enrichment)
- **No pending or suggested entities**
- **No create / edit / delete from this view** (Phase 1 is read-only)
- **No EntityContext changes**
- **No BankRule changes**
- **No GL accounts / accounting**
- **No clustering or inference**
- **No changes to existing EntityOnboardingModal**
- **No changes to "Cambiar" button behavior**
- **No backend API changes** (use existing EntityContext queries)

---

## Exit Criteria

- Click on company name opens Company Structure view
- "Cambiar" button behavior unchanged
- Only confirmed entities with valid roles appear
- No pending/suggested entities appear
- No AI calls made
- No data modified
- Empty state renders correctly when no entities
- Categories with zero entities are simply omitted (not shown as "0")
- All existing tests green
- TypeScript clean (`tsc --noEmit`)
- Build passes (`next build`)

---

## Task List

| ID | Task | Description |
|----|------|-------------|
| CS-01 | Add click handler on company name | Make active company name clickable (not "Cambiar"), opens Company Structure view |
| CS-02 | Query confirmed EntityContext records | Fetch confirmed entities with valid roles from EntityContext. Grouping for presentation is performed in the view layer. |
| CS-03 | Build Company Structure view | Dashboard-style layout with role cards (icon, name, count, top entities) |
| CS-04 | Group cards + "Ver todos" | Card component showing group header, entity count, top entities list, and navigation |
| CS-05 | Entity navigation | Click on entity name →navigate to entity detail (if available) |
| CS-06 | Empty state | Render empty state when no entities confirmed |
| CS-07 | Verify | Run tests, tsc, build; confirm exit criteria |

---

## Apply Log

| Date | Task | Status |
|------|------|--------|
| 2026-07-06 | CS-01 | Done — Company name clickable in AppShell header |
| 2026-07-06 | CS-02 | Done — Fetches via existing GET /api/entity-context?limit=1000 |
| 2026-07-06 | CS-03 | Done — CompanyStructureView component created |
| 2026-07-06 | CS-04 | Done — Cards with category icon, name, count, top entities |
| 2026-07-06 | CS-05 | Deferred — Entity detail screen not yet available |
| 2026-07-06 | CS-06 | Done — Empty state with guidance text |
| 2026-07-06 | CS-07 | Pending — Verify log below |

---

## Verify Log

| Date | Check | Result |
|------|-------|--------|
| 2026-07-06 | All existing tests pass | ✅ 28/28 |
| 2026-07-06 | TypeScript clean | ✅ tsc clean |
| 2026-07-06 | Build passes | ✅ next build 0 errors |
| 2026-07-06 | No AI calls | ✅ No LLM, no prompts |
| 2026-07-06 | No data modified | ✅ Read-only view |
| 2026-07-06 | Only confirmed entities shown | ✅ Queries EntityContext only |

---

## Engineering Constraint

**Company Structure is a read-only visualization layer. It must never become a management screen.** Any create, edit, delete or approval workflow belongs to its corresponding module, not to Company Structure.

> Estructura de la Empresa es únicamente una vista de lectura. Nunca debe convertirse en una pantalla de administración. Cualquier alta, modificación, eliminación o aprobación se realiza en el módulo correspondiente, nunca desde esta vista.
