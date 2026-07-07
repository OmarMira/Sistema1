# Knowledge Audit Specification

## Purpose

Knowledge Audit provides an immutable trail for every Company Knowledge mutation and an explainability API that traces any decision back to its source. Every mutation leaves a permanent record. Phase 1 has no hard delete — only archive and restore.

## Requirements

### Requirement: Immutable Audit Log

Every create, update, archive, and restore MUST generate a record with: `companyId`, `knowledgeId`, `action`, `changedByUserId`, `timestamp`, `beforeValue`, `afterValue`, `source`, and `reason`. Records MUST be append-only. No modification or deletion of existing records is permitted.

#### Scenario: Update creates full audit log

- GIVEN entity "OMAR MIRA" with relationship "owner"
- WHEN relationship changes to "vendor"
- THEN audit record: `action: "updated"`, `beforeValue: { relationship: "owner" }`, `afterValue: { relationship: "vendor" }`, with changedByUserId, timestamp populated

#### Scenario: Archive audited

- GIVEN an active entity
- WHEN archived
- THEN audit record: `action: "archived"`, `beforeValue` contains pre-archive state, `afterValue` contains `status: "archived"`

#### Scenario: Audit record immutability

- GIVEN an existing audit record
- WHEN update or delete is attempted
- THEN operation rejected; record unchanged

### Requirement: Explainability API

Every Company Knowledge-based decision MUST expose:

```json
{
  "source": "company_knowledge",
  "knowledgeId": "ck_abc123",
  "canonicalName": "OMAR MIRA",
  "relationship": "owner",
  "version": 3,
  "decisionReason": "confirmed_company_knowledge"
}
```

`version` reflects the mutation count. Every state transition (create, update, archive, restore, merge) increments version. `decisionReason` uses a controlled vocabulary.

### Controlled vocabulary for `decisionReason`:

| Value | When |
|-------|------|
| `company_knowledge_confirmed` | Entity confirmed by user (create) |
| `company_knowledge_updated` | Existing entity updated |
| `company_knowledge_merged` | Entity absorbed into another |
| `entity_context_match` | Decision from EntityContext |
| `bank_rule_match` | Decision from BankRule |
| `llm_suggestion` | LLM proposed without confirmed knowledge |
| `manual_override` | User overrode a suggestion |
| `fallback_default` | No source matched; default applied |

#### Scenario: Detection returns explainability payload

- GIVEN entity "OMAR MIRA" in Company Knowledge, version 3
- WHEN detection classifies a transaction involving it
- THEN payload includes source, knowledgeId, canonicalName, relationship, version, decisionReason

#### Scenario: Unknown entity excluded

- GIVEN entity NOT in Company Knowledge
- WHEN detection classifies it
- THEN payload does NOT include Company Knowledge fields
- AND source reflects actual origin (entity_context, llm)

#### Scenario: Version increments monotonically

- GIVEN entity with version = 1 at creation
- WHEN updated twice
- THEN version = 3; explainability API returns version: 3

#### Scenario: Archive and restore increment version

- GIVEN entity with version = 3
- WHEN archived
- THEN version = 4
- WHEN restored
- THEN version = 5

#### Scenario: Merge increments destination version

- GIVEN entity B (destination) with version = 2 and entity A (source) to be merged
- WHEN merge completes
- THEN B.version = 3; A.status = "merged"

### Requirement: No Hard Delete

Phase 1 supports only `active ↔ archived` and `active → merged`. Hard delete requests MUST be rejected.

#### Scenario: Hard delete rejected

- GIVEN an active entity
- WHEN DELETE is attempted
- THEN error returned: delete not supported; entity unchanged

#### Scenario: Restore returns archived to active

- GIVEN entity with `status = "archived"`
- WHEN restored
- THEN status = "active"; audit record: `action: "restored"`

#### Scenario: Merged entity immutable

- GIVEN entity with `status = "merged"` and `mergedInto` set
- WHEN any mutation attempted
- THEN operation rejected; entity remains as pointer to canonical destination

## Invariants

1. **Immutability**: Audit records append-only; no update/delete.
2. **Permanent trace**: Every mutation produces exactly one audit record.
3. **No hard delete**: Only transitions: active↔archived, active→merged.
4. **Version monotonicity**: Version increments by 1 per mutation, never decreases.

## Acceptance Criteria

- [ ] Every create/update/archive/restore generates a complete audit record
- [ ] Audit records are append-only and immutable
- [ ] Explainability API returns source, knowledgeId, canonicalName, relationship, version, decisionReason
- [ ] Version increments monotonically per update
- [ ] Hard delete rejected with clear error
- [ ] Archived entities restorable; merged entities immutable
- [ ] Explainability contract is stable and versioned
