# Delta for rule-engine-integration

Delta for BRE-011 (`bre-011-wildcard-semantics`). Adds the wildcard routing contract and legacy-column normalization to the adapter. Existing requirements are unchanged.

## ADDED Requirements

### Requirement: Wildcard conditions routed per wildcard contract

When the adapter normalizes `BankRule` conditions into the Rule Engine v2 input contract, a condition value of exactly `*` on a wildcard-surface operator MUST be routed per `rule-wildcard-semantics` (non-empty wildcard match), and `*` on regex or amount operators MUST NOT be treated as a wildcard. (Provenance: BRE-011 proposal §7; rule-wildcard-semantics spec.)

#### Scenario: Star on description contains routed as wildcard
- GIVEN a `BankRule` with condition `description_contains = "*"` and `RULE_ENGINE_V2_ENABLED=true`
- WHEN the adapter prepares the rule for the engine
- THEN the condition is routed per the wildcard contract (matches any non-empty description) rather than passed through as a literal substring

#### Scenario: Star on amount routed as non-wildcard
- GIVEN a `BankRule` with condition `amount_gt = "*"` and `RULE_ENGINE_V2_ENABLED=true`
- WHEN the adapter prepares the rule for the engine
- THEN the condition is routed as explicit no-match per the wildcard contract, and MUST NOT raise an engine error

#### Scenario: Star on regex routed as non-wildcard
- GIVEN a `BankRule` with condition `description_matches = "*"` and `RULE_ENGINE_V2_ENABLED=true`
- WHEN the adapter prepares the rule for the engine
- THEN the condition is routed as invalid-regex no-match per the wildcard contract, and MUST NOT raise an engine error

### Requirement: Legacy columns normalized to canonical model

When `conditions` is not a usable representation and `conditionType`/`conditionValue` exist, the adapter MUST normalize the legacy columns to the canonical model before V2 execution, following conditions-first precedence and failing closed when neither representation normalizes. (Provenance: proposal §11 Decision #2; case 4.)

#### Scenario: Conditions-first precedence
- GIVEN a `BankRule` with valid non-empty `conditions` and populated legacy columns
- WHEN the adapter prepares the rule for V2
- THEN `conditions` is used and legacy columns are ignored

#### Scenario: Legacy fallback produces canonical condition
- GIVEN a `BankRule` with unusable `conditions`, `conditionType = "equals"`, `conditionValue = "*"`
- WHEN the adapter prepares the rule for V2
- THEN a canonical `description_eq("*")` condition is produced and routed through the shared wildcard contract

#### Scenario: Fail closed when nothing normalizes
- GIVEN a `BankRule` with neither usable `conditions` nor normalizable legacy columns
- WHEN the adapter prepares the rule for V2
- THEN the rule fails closed (skipped with an explicit error), never silently mis-evaluated
