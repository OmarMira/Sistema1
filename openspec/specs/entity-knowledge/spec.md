# Entity Knowledge Specification

## Purpose

Entity Knowledge is the Aggregate Root for entity identity. It provides the single entry point for storing, retrieving, and managing canonical entity identity — canonicalName, aliases, type, type-validated metadata, lifecycle state (active/archived/merged), and ownership (companyId). Every mutation requires human approval. No hardcoded entity names exist in code.

## Requirements

### Requirement: Entity CRUD with Human Approval

Every create, update, archive, and restore MUST require explicit user confirmation. The system MAY propose values but MUST NOT persist without approval.

#### Scenario: User confirms new entity

- GIVEN the user filled the creation form
- WHEN the user clicks "Confirm"
- THEN entity is persisted with `source: user_confirmed`; knowledgeId returned

#### Scenario: System proposal without confirmation is rejected

- GIVEN LLM suggested "OMAR MIRA" as an entity
- WHEN the user has not confirmed
- THEN suggestion is NOT persisted

#### Scenario: Update requires re-confirmation

- GIVEN an existing entity
- WHEN the user edits canonicalName and confirms
- THEN canonicalName is updated; audit captures before/after

### Requirement: Type Discrimination

The system MUST support exactly 5 types: `person`, `company`, `financial_product`, `platform`, `asset`. Each type MUST have a dedicated Zod schema for metadata validation. No JSON-free metadata permitted.

#### Scenario: Valid type metadata passes

- GIVEN a `person` entity with metadata `{ "relationship": "owner", "notes": "CEO" }`
- WHEN created
- THEN it persists

#### Scenario: Invalid metadata for type rejected

- GIVEN a `platform` entity with metadata `{ "assetType": "vehicle" }`
- WHEN created
- THEN validation error; no entity created

### Requirement: Lifecycle Management

Entity `status` MUST be one of: `active`, `archived`, `merged`. When `merged`, MUST have `mergedInto` pointing to destination knowledgeId.

#### Scenario: Archive and restore

- GIVEN an active entity
- WHEN archived, status = "archived", excluded from active queries
- WHEN restored, status = "active"

#### Scenario: Merge references destination

- GIVEN entity A merged into entity B
- THEN A.status = "merged", A.mergedInto = B.knowledgeId; A excluded from active queries

### Requirement: Ownership and Isolation

Every entity MUST be scoped to `companyId`. Cross-company access is forbidden. No inheritance or sharing.

#### Scenario: Company isolation enforced

- GIVEN Company A has 5 entities
- WHEN Company B queries its entity list
- THEN only Company B's entities are returned

### Requirement: Active Entry Limit

Maximum 1,000 active entities per company. Archived entities do not count. Creation exceeding the limit MUST be rejected.

#### Scenario: Limit rejection

- GIVEN a company with 1,000 active entities
- WHEN creating a new entity
- THEN error: limit reached, creation rejected

#### Scenario: Archive frees capacity

- GIVEN 1,000 active entities
- WHEN archiving one and creating another
- THEN creation succeeds (1,000 active, 1 archived)

### Requirement: Aliases as String Array

Aliases MUST be `aliases: string[]` on the entity record. They are not a separate entity type.

#### Scenario: Aliases stored on entity

- GIVEN entity "AMEX" with aliases `["AMERICAN EXPRESS", "AE"]`
- WHEN persisted
- THEN aliases are stored as `string[]` on the entity record

## Invariants

1. **Human gate**: No mutation persists without explicit user confirmation.
2. **Isolation**: Every entity belongs to exactly one companyId.
3. **Type safety**: metadata validated against per-type Zod schema.
4. **Active limit**: `count(status = active) < 1000` per companyId.
5. **No hardcode**: No entity names in source code.

## Acceptance Criteria

- [ ] CRUD requires explicit user confirmation
- [ ] All 5 types supported with per-type Zod metadata validation
- [ ] Entities can be archived, restored, and merged with correct status/mergedInto
- [ ] Archived entities excluded from active queries
- [ ] Company isolation enforced at data access layer
- [ ] 1,000 active cap enforced; archived don't count
- [ ] Aliases stored as `string[]` on entity, not separate records
- [ ] No hardcoded entity names in codebase
