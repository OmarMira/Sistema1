# Proposal: Company Knowledge Service

## Intent

Entity detection works but lacks a verified source of truth for identity and business relationships. AI inferences live in EntityContext (runtime, ephemeral), BankRules mix accounting with entity data. Company Knowledge fills the gap: a human-verified registry feeding identity/relationship facts into detection — without touching accounting, GL, or auto-apply.

## Scope

### In Scope
- Polymorphic entity registry (person, company, financial_product, platform, asset) with CRUD and human approval
- Business relationships as `string[]`, mapped externally to EntityRole
- Bidirectional sync with EntityContext (inbound with approval, outbound as detection bias)
- Origin tracking on every decision (company_knowledge, entity_context, llm)
- Merge: user resolves conflicts field-by-field, never auto-merge

### Out of Scope
- BankRules, GL accounts, auto-apply, or accounting logic
- EntityRole enum (mapped externally, not owned)
- EntityContext schema (runtime layer)
- Cross-company inheritance (1,000 entries per company, no sharing)

## Capabilities

> Contract between proposal and specs. Each becomes a spec file.

### New Capabilities
- **entity-knowledge**: Aggregate Root for entity identity. Single entry point for canonicalName, aliases, relationship, metadata, lifecycle (active/archived/merged), and ownership (companyId). CRUD + human-approval gate. 1,000 active entries cap. No hardcoded names.
- **relationship-knowledge**: Manages the confirmed business relationship of an entity and exposes a translation contract toward consumers (e.g., EntityRole) without depending on them.
- **knowledge-integration**: Coordinates knowledge with other components — listens for confirmations, updates EntityContext, participates in merges, prevents duplicates, notifies changes. User resolves every field on merge, never automated.
- **knowledge-audit**: Immutable audit trail (who, when, what, origin). Explainability API must return knowledgeId, canonicalName, relationship, version, and decisionReason for every decision based on Company Knowledge.

### Modified Capabilities
- None — no existing specs.

## Approach

Central service module with four internal domains mirroring capabilities. Single polymorphic table with `type` discriminator. All mutations pass an approval gate. Sync layer bridges both sides via adapters — no shared schema coupling.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `internal/company-knowledge/` | New | Central service module |
| `internal/entity-context/` | Modified | Sync hooks to/from Knowledge |
| `internal/bank-rule/` | None | Explicitly excluded |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Sync coupling with EntityContext | Low | Adapter layer, no shared types |
| Merge UX complexity | Med | Spec to define field-by-field UI boundaries |
| Approval bottleneck | Low | 1,000 entries is manageable by design |

## Rollback Plan

Remove module and sync hooks. Detection falls back to EntityContext/LLM — same as before.

## Dependencies

- EntityRole enum definition (consumed by relationship-knowledge)
- EntityContext schema stability during sync integration

## Success Criteria

- [ ] Registry stores/retrieves all 5 entity types correctly
- [ ] Human approval blocks every mutation until confirmed
- [ ] Origin metadata survives sync round-trip (Knowledge ↔ EntityContext)
- [ ] Merge never auto-resolves field conflict
- [ ] Audit log immutable for all mutations
