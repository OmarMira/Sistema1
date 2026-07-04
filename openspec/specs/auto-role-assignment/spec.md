# Auto Role Assignment Specification

## Purpose

Enable per-company opt-in automatic role pre-assignment for entity classification. When the opt-in flag is active and decision-engine confidence >= 0.9, the system auto-assigns the role, creates a BankRule, and notifies the user with a rollback option.

## Requirements

### Requirement: Company Auto-Role-Assignment Flag

The Company model MUST include an `autoRoleAssignment` boolean field defaulting to false. All auto-assignment behavior MUST be gated behind this flag. When the flag is false, the system behaves exactly as today.

#### Scenario: Flag disabled, manual flow unchanged

- GIVEN a company with `autoRoleAssignment = false`
- WHEN suggest-role returns a confidence value
- THEN the confidence is capped at 0.69
- AND the frontend displays the manual confirmation modal

#### Scenario: Flag enabled, confidence cap removed

- GIVEN a company with `autoRoleAssignment = true`
- WHEN suggest-role evaluates decision-engine confidence
- THEN the full confidence value is returned without capping

### Requirement: Auto-Assignment at High Confidence

When `autoRoleAssignment = true` AND decision-engine confidence >= 0.9, the suggest-role endpoint MUST return `autoAssign: true`. The classify-entity endpoint MUST accept `autoAssign: boolean` in the request body. When true, the entity-classifier SHALL bypass the manual gate for BankRule creation and set `autoAssignedAt` on the EntityContext.

#### Scenario: High confidence triggers auto-assignment

- GIVEN a company with `autoRoleAssignment = true` and decision-engine confidence = 0.94
- WHEN suggest-role returns `{ suggestedRole, confidence: 0.94, autoAssign: true }`
- THEN the frontend calls classify-entity with `autoAssign: true`
- AND EntityContext is created with `autoAssignedAt` set to the current timestamp
- AND a BankRule is created and linked to the context
- AND a toast notification is displayed with entity name, role, and confidence

#### Scenario: Confidence below threshold falls back to manual

- GIVEN a company with `autoRoleAssignment = true` and confidence = 0.85
- WHEN suggest-role returns the full confidence (0.85) without `autoAssign`
- THEN the frontend shows the manual confirmation modal unchanged

### Requirement: Rollback Auto-Assignment

The system MUST provide `POST /api/learning/auto-assignments/[id]/rollback`. It SHALL delete the EntityContext and its linked BankRule only if `autoAssignedAt` is set on the context. For contexts without `autoAssignedAt` (manual assignments), it SHALL return 400. Every rollback MUST be logged in the audit trail.

#### Scenario: Rollback auto-assigned entity succeeds

- GIVEN an EntityContext with `autoAssignedAt` set
- WHEN the rollback endpoint is called
- THEN the EntityContext is deleted
- AND the linked BankRule is deleted
- AND the rollback is recorded in the audit log
- AND 200 OK is returned

#### Scenario: Rollback manual assignment is rejected

- GIVEN an EntityContext without `autoAssignedAt` (manually assigned)
- WHEN the rollback endpoint is called
- THEN 400 "Cannot rollback manual assignment" is returned
- AND no records are deleted

### Requirement: Toast Notification with Rollback Action

When auto-assignment triggers, the UI SHALL display a toast: "{name} → {role} ({confidence}%)" with a "Deshacer" button. Clicking "Deshacer" SHALL call the rollback endpoint and refresh the pending classification list so the entity reappears.

#### Scenario: Deshacer restores pending state

- GIVEN an auto-assignment toast is displayed
- WHEN the user clicks "Deshacer"
- THEN the rollback endpoint is called
- AND the entity reappears in the pending classification list

### Requirement: Manual Flow Preservation

When `autoRoleAssignment = false` OR confidence < 0.9, all existing flows MUST behave exactly as today. No changes to the manual confirmation modal, BankRule creation behavior, or entity-classifier logic for non-auto-assign cases.

#### Scenario: Manual confirmation flow unchanged

- GIVEN `autoRoleAssignment = false`
- WHEN a user manually classifies an entity via the existing modal
- THEN all existing UI, data, and API behavior remains identical to the current system
