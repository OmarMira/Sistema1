# Delta for Entity Classification + Entity Role Suggestion

Consolidated delta for FR-1 through FR-5 of the `improve-entity-classifier` change. Affects both `entity-classification` and `entity-role-suggestion` domains.

---

## ADDED Requirements

### FR-1: Direction-Based Hard Filter

The system MUST apply a hard filter that excludes roles whose `EXPECTED_DIRECTION` contradicts the entity's `directionProfile` before any AI call or suggestion.

- If the entity has **only credits** (`debitPct === 0`), roles with `EXPECTED_DIRECTION: 'debit'` MUST be excluded.
- If the entity has **only debits** (`creditPct === 0`), roles with `EXPECTED_DIRECTION: 'credit'` MUST be excluded.
- If both `creditPct > 0` AND `debitPct > 0` (ambiguous/mixed), no roles are excluded by direction.
- Roles with `EXPECTED_DIRECTION: 'mixed'` or `null` (SOCIO, OTRO, IGNORADA) MUST NOT be excluded regardless of direction profile.
- The filter MUST operate on `EXPECTED_DIRECTION` from `entity-roles.ts` without modification to that constant.
- An 80% threshold SHALL be used for the filter: if dominant direction >= 0.80, the filter applies. Below 0.80, treat as ambiguous.

#### Scenario: Pure credit entity excludes debit roles

- GIVEN an entity with `directionProfile: { creditPct: 1.0, debitPct: 0.0 }`
- WHEN the filter is evaluated
- THEN roles CLIENTE, INGRESO, INQUILINO, SOCIO, OTRO, IGNORADA MUST remain eligible
- AND roles PROVEEDOR, EMPLEADO, GASTO_OPERATIVO, TARJETA_CREDITO, PRESTAMO MUST be excluded

#### Scenario: Pure debit entity excludes credit roles

- GIVEN an entity with `directionProfile: { creditPct: 0.0, debitPct: 1.0 }`
- WHEN the filter is evaluated
- THEN roles PROVEEDOR, EMPLEADO, GASTO_OPERATIVO, TARJETA_CREDITO, PRESTAMO, SOCIO, OTRO, IGNORADA MUST remain eligible
- AND roles CLIENTE, INGRESO, INQUILINO MUST be excluded

#### Scenario: Mixed direction passes all roles

- GIVEN an entity with `directionProfile: { creditPct: 0.55, debitPct: 0.45 }`
- WHEN the filter is evaluated
- THEN all 11 roles MUST remain eligible (no exclusion by direction)

#### Scenario: 80% threshold edge

- GIVEN an entity with `directionProfile: { creditPct: 0.79, debitPct: 0.21 }`
- WHEN the filter is evaluated
- THEN all roles MUST remain eligible (dominant direction < 0.80)

#### Scenario: Real-world — SETOYOTA all debits

- GIVEN an entity matching "SETOYOTA FIN/EZP" with 100% debit transactions
- WHEN the filter is evaluated
- THEN GASTO_OPERATIVO MUST remain eligible (EXPECTED_DIRECTION is 'debit')
- AND CLIENTE, INGRESO, INQUILINO MUST be excluded

---

### FR-2: Rich AI Prompt with Debe/Haber Context

The system MUST modify the AI prompt in `suggest-role/route.ts` to include transactional context beyond the entity description.

The prompt MUST include:
- Entity **name** (canonicalName)
- **Number of transactions** (occurrences)
- **directionProfile**: credit % and debit % with explicit "money IN" / "money OUT" labels
- **Sample descriptions** (up to 3)
- **Total amounts range** (min amount, max amount across transactions)

The prompt MUST contain the sentence: `"This entity has X% debit transactions (money OUT) and Y% credit transactions (money IN)"`.

#### Scenario: Rich prompt changes AI suggestion

- GIVEN an entity with `{ canonicalName: "SETOYOTA FIN/EZP", directionProfile: { creditPct: 0, debitPct: 1 }, occurrences: 15 }`
- WHEN `POST /api/learning/suggest-role` is called with the entity context
- THEN the prompt sent to the AI MUST include direction percentages with money IN/OUT labels
- AND the AI MUST have sufficient signal to distinguish money-receiving from money-paying roles

#### Scenario: Prompt includes up to 3 samples

- GIVEN an entity with 10 sample descriptions
- WHEN the prompt is constructed
- THEN exactly 3 sample descriptions SHALL be included (first 3, or most representative)

---

### FR-3: OTRO Persistence and Learning

The system MUST persist OTRO classifications so they survive page refresh and can be reviewed later.

- The `EntityContext` model MUST gain a nullable `userDescription` String field.
- When the user selects OTRO and writes a description, `classify-entity/route.ts` MUST save the `EntityContext` with `role: 'OTRO'`, `userDescription` set to the user's text, and `source: 'user'`.
- When `getEntityCandidates` runs, it MUST skip entities that already have an `OTRO` context (they were already seen).
- The system MUST provide an endpoint or modal view that lists OTRO entities for later re-classification.

#### Scenario: OTRO persists on save

- GIVEN the user selects OTRO and types "pagos varios de oficina"
- WHEN `POST /api/learning/classify-entity` is called with `{ role: "OTRO", userDescription: "pagos varios de oficina" }`
- THEN an EntityContext record is created with `role: "OTRO"` and `userDescription: "pagos varios de oficina"`
- AND `source` is set to `"user"`

#### Scenario: Already-classified OTRO is excluded from candidates

- GIVEN an EntityContext record exists with `pattern: "PAPELERA XYZ"` and `role: "OTRO"`
- WHEN `getEntityCandidates` is called
- THEN entities matching "PAPELERA XYZ" MUST NOT appear in the returned candidate list

#### Scenario: OTRO entities appear in pending list

- GIVEN EntityContext records with `role: "OTRO"` exist for the current company
- WHEN the user accesses the OTRO review view
- THEN all OTRO entities are displayed with their `userDescription` and `pattern`
- AND the user can assign a new canonical role to each

#### Scenario: OTRO survives page refresh

- GIVEN the user saves an OTRO entity and refreshes the page
- WHEN the OTRO review view loads
- THEN the previously saved OTRO entity MUST be visible

---

### FR-4: Web Search Fallback

When AI confidence is low AND the entity name is unfamiliar, the system MAY call a web search API to gather context and re-classify.

- Trigger: AI confidence < 80% AND no local `EntityContext` match exists for the entity name.
- The web search MUST be async with a 5-second timeout (AbortController).
- The search result snippet + source URL MUST be passed back to the AI for a second classification attempt.
- Configurable via `WEB_SEARCH_ENABLED` env var (default: `false`, opt-in).
- The fallback result confidence MUST be capped at 0.70 (web search adds signal but is less reliable).

#### Scenario: Web search helps classify unfamiliar entity

- GIVEN the entity description "SETOYOTA FIN/EZP" has no local DB match and AI confidence < 80%
- WHEN `WEB_SEARCH_ENABLED=true`
- THEN a web search for "SETOYOTA FIN/EZP" is executed
- AND the result snippet (e.g., "Southeast Toyota Finance") is passed to the AI
- AND the AI returns a re-classified suggestion with confidence capped at 0.70

#### Scenario: Web search disabled by default

- GIVEN `WEB_SEARCH_ENABLED` is unset or `false`
- WHEN AI confidence < 80% and no local match exists
- THEN no web search is performed
- AND the endpoint returns the original low-confidence result

#### Scenario: Web search times out gracefully

- GIVEN the web search takes longer than 5 seconds
- WHEN the AbortController fires
- THEN the endpoint returns the original low-confidence result without error
- AND the timeout is logged server-side

---

## MODIFIED Requirements

### Requirement: Entity Classifier Tests (entity-classification spec, existing)

The system MUST have unit tests covering both existing and new classifier behavior. Target coverage MUST be at least 70% per module. New test files MUST be created for direction filter, OTRO persistence, and prompt enrichment.

(Previously: Tests cover `getEntityCandidates`, `clusterCandidates` modes, and core classification only.)

#### Scenario: Direction filter rejects impossible roles — UNCHANGED scenario shape but new tests

- GIVEN a test suite with 11 role expectations
- WHEN direction filter is tested with pure-credit, pure-debit, and mixed profiles
- THEN each profile MUST exclude only the roles that contradict its dominant direction

#### Scenario: OTRO persistence test

- GIVEN `classifyEntity` is called with `role: "OTRO"` and `userDescription`
- WHEN the EntityContext is saved
- THEN a record with `role: "OTRO"` and `userDescription` exists in the test database

#### Scenario: Rich prompt includes direction context

- GIVEN the `suggest-role` route is called with entity context data
- WHEN the prompt is constructed
- THEN the prompt string MUST contain "money OUT" and "money IN" labels with percentages

### Requirement: Entity Classification — OTRO AI Role Suggestion (entity-classification spec, existing)

The system MUST persist OTRO entities to EntityContext when the user saves with a description. OTRO entities MUST NOT be saved without a description. Future candidate detection MUST skip already-classified OTRO patterns.

(Previously: "OTRO without assigned canonical role → Save blocked (entity NEVER persists 'OTRO' as role)". This is now modified — OTRO CAN persist when a userDescription is provided.)

#### Scenario: OTRO with description saves successfully
(Replaces previous scenario where OTRO save was always blocked)

- GIVEN user sets role to OTRO and writes description "servicios mensuales" (>= 5 chars)
- WHEN handleClassifyAll is called
- THEN EntityContext is saved with `role: "OTRO"` and source `"user"`
- AND the entity no longer appears in future candidate scans

#### Scenario: OTRO without description still blocked

- GIVEN user sets role to OTRO but writes no description (< 5 chars)
- WHEN handleClassifyAll is called
- THEN no EntityContext is saved for this entity
- AND the entity still appears in future candidate scans

### Requirement: Entity Context Service — saveContext (entity-context-service, existing)

`saveContext` MUST accept and persist an optional `userDescription` field. The `EntityContext.upsert` call MUST include `userDescription` in both `create` and `update` branches.

(Previously: saveContext did not handle userDescription.)

#### Scenario: userDescription is persisted

- GIVEN `saveContext` is called with `{ ..., userDescription: "pagos varios" }`
- WHEN the upsert executes
- THEN the EntityContext record `userDescription` field equals `"pagos varios"`

---

## MODIFIED Database Schema

### EntityContext.userDescription

The `EntityContext` model in `prisma/schema.prisma` MUST add an optional `userDescription` field:

```
userDescription String?
```

This is a nullable, optional field. No backfill required. Existing records continue to work with `userDescription === null`.

---

## MODIFIED Environment Config

The system MUST read `WEB_SEARCH_ENABLED` from `process.env`. Default value is `'false'`. The config SHALL be read at request time (not cached), allowing runtime configuration changes.

---

## Test Coverage (FR-5)

| Test File | Scope |
|-----------|-------|
| `direction-filter.test.ts` | Hard filter rules for all 11 roles with pure-credit, pure-debit, mixed, and threshold-edge profiles |
| `suggest-role.test.ts` | Rich prompt construction includes direction context; web search fallback trigger and timeout |
| `otro-persistence.test.ts` | Save OTRO with description, load OTRO entities, skip already-classified OTRO, reject OTRO without description |
| Existing `entity-classifier.test.ts` | Update if `getEntityCandidates` signature changes |
| Existing `entity-detector.test.ts` | Update if `EntityCandidate` type changes |

---

## Notes

- The 80% threshold is a starting heuristic; it MAY be tuned after real-world validation.
- Web search implementation is intentionally opt-in due to API costs. Teams with existing search API keys (e.g., Google Custom Search, Bing) can enable it.
- OTRO review view is a minimal MVP — a simple list with re-classify action. Future iterations may add batch re-classification.
- The `EXPECTED_DIRECTION` mapping in `entity-roles.ts` is the single source of truth for direction expectations. It MUST NOT be duplicated.
