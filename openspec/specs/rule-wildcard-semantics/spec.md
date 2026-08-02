# rule-wildcard-semantics Specification

## Purpose

Define the semantics of the literal `*` as a rule condition value. Bounded surface: `*` is a wildcard meaning "matches any non-empty value" for a defined set of description string operators, and is explicitly NOT a wildcard for regex (`description_matches`) and numeric (amount) operators. Establishes cross-engine parity (Legacy, Precedence, V2) on that surface, closing the BRE-009 W-1 axis-A divergence.

**Provenance markers:** requirements are tagged `[Evidence-backed]` (behavior demonstrated by the observed 8-case matrix, BRE-011 §12) or `[Design decision]` (chosen contract, justified in BRE-011 proposal §3, not measured). This preserves exploration → proposal → specification traceability.

## Requirements

### Requirement: Wildcard marker — non-empty match [Evidence-backed]

A condition whose normalized value is exactly `*` MUST match any **non-empty** transaction value, and MUST NOT match an empty value. (Source: case 8 — Legacy `NO_MATCH` on empty description; `rule-matching-engine.ts:48-49` `strTxVal.length > 0`.)

#### Scenario: Wildcard matches non-empty description
- GIVEN a rule condition `description_contains = "*"` and a transaction with non-empty description `"TX synthetique alpha"`
- WHEN the rule is evaluated
- THEN the condition matches

#### Scenario: Wildcard does not match empty description
- GIVEN a rule condition `description_contains = "*"` and a transaction with empty description `""`
- WHEN the rule is evaluated
- THEN the condition does NOT match

### Requirement: Wildcard surface — evidence-backed operators [Evidence-backed]

The operators `description_contains` and `description_eq` MUST support the wildcard marker on the `description` field. (Source: cases 1, 3, 8.)

#### Scenario: Wildcard on contains
- GIVEN a rule condition `description_contains = "*"` and any non-empty description
- WHEN the rule is evaluated
- THEN the condition matches

#### Scenario: Wildcard on equals
- GIVEN a rule condition `description_eq = "*"` and any non-empty description
- WHEN the rule is evaluated
- THEN the condition matches

### Requirement: Wildcard surface — design-decision operators [Design decision]

The operators `description_starts_with` and `description_ends_with` MUST support the wildcard marker on the `description` field. (Justification: proposal §3 point 2 — design extension not covered by the measured matrix; adopted for surface consistency.)

#### Scenario: Wildcard on starts_with
- GIVEN a rule condition `description_starts_with = "*"` and any non-empty description
- WHEN the rule is evaluated
- THEN the condition matches

#### Scenario: Wildcard on ends_with
- GIVEN a rule condition `description_ends_with = "*"` and any non-empty description
- WHEN the rule is evaluated
- THEN the condition matches

### Requirement: Regex exclusion — `description_matches` [Evidence-backed, RESOLVED]

A condition of type `description_matches` MUST NOT treat `*` as a wildcard marker. `*` in a regex condition is an invalid regex pattern and MUST result in explicit no-match at runtime (never a wildcard match, never an exception). Rules carrying `*` on `description_matches` MUST be rejected at write/import validation. (Source: case 6 — wildcard guard intercepts the regex before evaluation; case 7 — `.*` is a separate, non-intercepted regex family; proposal §11 Decision #1.)

#### Scenario: Star is not wildcard in regex
- GIVEN a rule condition `description_matches = "*"` and a non-empty description
- WHEN the rule is evaluated at runtime
- THEN the condition does NOT match (invalid regex, no wildcard interception, no exception)

#### Scenario: Star on regex rejected at write/import
- GIVEN a rule create or import payload with condition `description_matches = "*"`
- WHEN validation runs in the shared domain/API layer
- THEN the rule is rejected with a validation error

#### Scenario: Valid regex unaffected
- GIVEN a rule condition `description_matches = ".*"` and a non-empty description
- WHEN the rule is evaluated
- THEN the regex is evaluated as a pattern (not as a wildcard marker)

### Requirement: Numeric exclusion — amount operators [Design decision, RESOLVED]

Amount operators MUST NOT support the wildcard marker. A condition value of `*` on an amount operator MUST produce an explicit no-match at runtime (never an exception). Rules carrying `*` on an amount operator MUST be rejected at write/import validation. (Source: case 5; proposal §3.4 + §11 Decision #1.)

#### Scenario: Star on amount is explicit no-match
- GIVEN a rule condition `amount_gt = "*"` and a transaction with amount `100`
- WHEN the rule is evaluated at runtime
- THEN the condition does NOT match, and no exception is raised

#### Scenario: Star on amount rejected at write/import
- GIVEN a rule create or import payload with condition `amount_gt = "*"`
- WHEN validation runs in the shared domain/API layer
- THEN the rule is rejected with a validation error

#### Scenario: Valid numeric value still works
- GIVEN a rule condition `amount_gt = "50"` and a transaction with amount `100`
- WHEN the rule is evaluated
- THEN the condition matches

### Requirement: Cross-engine parity [Design decision]

On the bounded wildcard surface (description string operators with the non-empty guard), Legacy, Precedence, and V2 MUST produce identical match outcomes. This closes the BRE-009 W-1 axis-A divergence (`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`) on that surface. (Source: proposal §3 Consequence; case 2 shows literal-`*` convergence is already achievable.)

#### Scenario: Parity on wildcard match
- GIVEN a rule condition `description_contains = "*"` and a non-empty description, with all three engines enabled
- WHEN the rule is evaluated by Legacy, Precedence, and V2
- THEN all three engines match

#### Scenario: Parity on empty description
- GIVEN a rule condition `description_contains = "*"` and an empty description, with all three engines enabled
- WHEN the rule is evaluated by Legacy, Precedence, and V2
- THEN all three engines do NOT match

#### Scenario: Parity on regex exclusion
- GIVEN a rule condition `description_matches = "*"` and any description, with all three engines enabled
- WHEN the rule is evaluated by Legacy, Precedence, and V2
- THEN none of the engines produce a wildcard match

### Requirement: Literal star preservation [Evidence-backed]

A transaction description that literally contains `*` (non-empty) MUST still match a wildcard condition, preserving current convergence. (Source: case 2 — all engines agree `SAME_WINNER`.)

#### Scenario: Literal star still matches
- GIVEN a rule condition `description_contains = "*"` and a description containing a literal asterisk `"TX * alpha"`
- WHEN the rule is evaluated
- THEN the condition matches (non-empty value)

## Requirements (added after review — legacy-column normalization)

### Requirement: Legacy-column normalization to canonical model [Design decision, RESOLVED]

When a rule's `conditions` is not a usable representation and legacy columns `conditionType`/`conditionValue` exist, the adapter MUST normalize the legacy columns to the canonical condition model before V2 execution. Precedence: (1) non-empty valid `conditions` → use them; (2) else fallback to legacy columns; (3) if neither normalizes → fail closed. (Source: proposal §11 Decision #2; case 4.)

#### Scenario: Conditions-first precedence
- GIVEN a rule with valid non-empty `conditions` and populated legacy columns
- WHEN the adapter prepares the rule for V2
- THEN `conditions` is used; legacy columns are ignored

#### Scenario: Legacy fallback produces canonical condition
- GIVEN a rule with `conditions` not usable, `conditionType = "equals"`, `conditionValue = "*"`
- WHEN the adapter prepares the rule for V2
- THEN a canonical `description_eq("*")` condition is produced and routed through the shared wildcard contract

#### Scenario: Fail closed when nothing normalizes
- GIVEN a rule with neither usable `conditions` nor normalizable legacy columns
- WHEN the adapter prepares the rule for V2
- THEN the rule fails closed (skipped with an explicit error), never silently mis-evaluated

#### Scenario: Productive path never preserves null conditions
- GIVEN a legacy-column rule normalized through fallback
- WHEN the adapter emits the rule to the productive path
- THEN the canonical condition is used; `conditions: null` is NOT preserved on the productive path (null-preservation was only for BRE-010's observational harness)
