# Relationship Knowledge Specification

## Purpose

Relationship Knowledge manages the confirmed business relationship between an entity and its owning company. It stores a curated set of relationship values and exposes a stable translation contract for consumers without depending on EntityRole. The mapping from `relationship` to `EntityRole` lives entirely in an external adapter layer — Company Knowledge does not own or import it.

## Requirements

### Requirement: Relationship Values

The system MUST support exactly these 9 values: `owner`, `employee`, `vendor`, `customer`, `tenant`, `lender`, `credit_card_provider`, `related_company`, `income_platform`. Values MUST be validated at write time.

#### Scenario: Valid value accepted

- GIVEN an entity with `relationship = "owner"`
- WHEN persisted
- THEN the value is stored as-is

#### Scenario: Invalid value rejected

- GIVEN an entity with `relationship = "supplier"` (not in allowed set)
- WHEN created or updated
- THEN validation error is returned, field unchanged

#### Scenario: Update to another valid value

- GIVEN an entity with `relationship = "owner"`
- WHEN updated to `vendor` and confirmed
- THEN relationship changes to `vendor`; audit captures before/after

### Requirement: Translation Contract

Relationship Knowledge MUST expose relationships through a stable contract (interface/type) without importing EntityRole. Translation to EntityRole MUST be in a separate adapter layer.

#### Scenario: Consumer reads raw relationship value

- GIVEN a consumer queries entity "OMAR MIRA"
- WHEN the contract is called
- THEN it receives the raw `relationship` string
- AND no EntityRole type is imported

#### Scenario: Adapter maps relationship to EntityRole

- GIVEN an external adapter reads `relationship = "owner"`
- WHEN it maps to EntityRole
- THEN the mapping logic lives entirely outside Company Knowledge

#### Scenario: Versioned contract protects consumers

- GIVEN the relationship set is extended
- WHEN the contract is versioned
- THEN existing consumers continue unchanged

### Requirement: Source Tracking

Every relationship MUST carry a `source` field: `user_confirmed`, `correction`, `system_suggested`, or `csv_import` (reserved). Source MUST NOT affect consumption priority — all confirmed relationships have equal authority.

#### Scenario: Correction flow records source

- GIVEN the system suggested "vendor", user corrected to "owner" and confirmed
- WHEN persisted
- THEN `source = "correction"` and relationship has full priority

#### Scenario: Source does not gate behavior

- GIVEN entities with different sources (user_confirmed and correction)
- WHEN a consumer queries
- THEN both returned with equal priority; source is informational only

## Invariants

1. **Fixed vocabulary**: Only the 9 defined values are accepted.
2. **No EntityRole coupling**: Domain never imports EntityRole types.
3. **Source transparency**: Source is tracked but does not affect consumption.
4. **Aggregate Root**: All relationship operations MUST be performed through Entity Knowledge as the Aggregate Root. No component may create, update or delete relationship data independently of Entity Knowledge.

## Acceptance Criteria

- [ ] All 9 relationship values are supported and validated
- [ ] Invalid values rejected with clear error
- [ ] Relationship values exposed via stable contract without EntityRole dependency
- [ ] External adapter maps relationship to EntityRole successfully
- [ ] Source tracking records origin without affecting consumption priority
