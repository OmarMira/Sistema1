# Knowledge Integration Specification

## Purpose

Knowledge Integration coordinates Company Knowledge with other system components. It listens for confirmations and updates EntityContext, participates in entity merges (user resolves every field, never automated), prevents duplicate entries via multi-tier checks, and notifies relevant subsystems of changes.

## Requirements

### Requirement: Confirmation Listener and EntityContext Sync

When knowledge is confirmed (create/update), EntityContext MUST reflect the confirmed canonicalName and relationship. When archived, EntityContext MUST mark the entry as no longer authoritative.

#### Scenario: New entity updates EntityContext

- GIVEN user confirms entity "AMEX" with `relationship = "credit_card_provider"`
- WHEN persisted
- THEN EntityContext is updated with confirmed canonicalName and relationship, source = "company_knowledge"

#### Scenario: Archive de-authorizes EntityContext

- GIVEN an active entity is archived
- THEN EntityContext retains historical mapping but marks it as no longer authoritative
- AND detection falls back to EntityContext/LLM

### Requirement: Entity Merge

Merge MUST NOT be automated. User resolves every conflicting field. Aliases combine automatically (deduplicated). canonicalName chosen by user. metadata resolved field by field. External references migrated to canonical destination.

#### Scenario: User resolves field-by-field

- GIVEN entity A (canonicalName: "AMEX", aliases: ["AE"]) and entity B (canonicalName: "AMERICAN EXPRESS", aliases: ["AMEX", "AE"])
- WHEN merge initiated
- THEN system shows differences; user chooses "AMERICAN EXPRESS" as canonicalName
- AND aliases combine to `["AMEX", "AE"]`
- AND A.status = "merged", A.mergedInto = B.knowledgeId
- AND all references migrate to B
- AND audit captures before/after for both

#### Scenario: Conflicting metadata resolved by user

- GIVEN entity A (metadata: `{"relationship":"owner","notes":"CEO"}`) and entity B (metadata: `{"relationship":"employee","notes":"Fundador"}`)
- WHEN merge begins
- THEN each conflicting field is presented for user decision
- AND user selects values; merge completes with chosen values

#### Scenario: Auto-merge never permitted

- GIVEN two potential duplicate entities detected
- WHEN system finds high similarity
- THEN blocks automated creation; suggests manual merge only

#### Scenario: Cross-company merge rejected

- GIVEN entity A belongs to companyId "X" and entity B belongs to companyId "Y"
- WHEN merge is initiated
- THEN operation rejected with error: "Cannot merge entities from different companies"
- AND both entities remain unchanged

### Requirement: Duplicate Prevention

Before creating an entity, check existing entries: exact canonicalName/alias match → redirect to existing. High similarity → block. Medium/low similarity → warn but allow.

#### Scenario: Exact match redirects

- GIVEN existing entity with alias "AMEX"
- WHEN new entity with canonicalName "AMEX" is attempted
- THEN system returns existing knowledgeId and warns "already exists"

#### Scenario: High similarity blocks creation

- GIVEN existing "AMERICAN EXPRESS"
- WHEN attempting "AMERICAN EXPRES" (high similarity)
- THEN creation blocked; existing entity suggested

#### Scenario: Medium similarity warns but allows

- GIVEN existing "OMAR MIRA"
- WHEN attempting "OMAR MORA"
- THEN warning displayed with candidates; user may proceed

### Requirement: Change Notification

Created, updated, archived, or restored knowledge MUST notify downstream subsystems (EntityContext sync, detection, audit) atomically with persistence.

#### Scenario: Create triggers notification

- GIVEN an entity is confirmed and persisted
- THEN notification is published atomically
- AND EntityContext sync and audit log receive the event

## Invariants

1. **No auto-merge**: Every conflicting field requires user resolution.
2. **No bypass**: Duplicate prevention runs on every creation regardless of source.
3. **Atomic notification**: Persistence and notification are transactional.
4. **Authoritative priority**: Confirmed knowledge always beats EntityContext/LLM for same entity.

## Acceptance Criteria

- [ ] Confirmed knowledge updates EntityContext with canonicalName and relationship
- [ ] Archived knowledge de-authorizes EntityContext entries
- [ ] Merge presents field-by-field differences; user resolves every conflict
- [ ] Aliases combine with deduplication on merge
- [ ] External references migrated to canonical destination on merge
- [ ] Duplicate prevention: exact match redirects, high similarity blocks, medium warns
- [ ] Change notifications published atomically with persistence
- [ ] Automated merge never permitted
