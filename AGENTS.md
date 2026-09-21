# Sistema1 — GGA Code Review Rules

> This file is an automated code-review contract for Gentleman Guardian Angel.
> It does not replace project governance, ADRs, tests, or Omar's authority.

---

## Authority

REQUIRE:
- Omar remains the sole authority for scope and product decisions.

## Integrity

REJECT IF:
- The staged change weakens accounting/data integrity guarantees.
- Destructive data operations are introduced without an explicitly
  established project contract permitting them.

## Secrets and credentials

REJECT IF:
- Hardcoded credentials, API keys, tokens, passwords, private keys,
  or production secrets are introduced.
- Secret values are logged or exposed in errors.

## Scope discipline

REJECT IF:
- The staged change contains unrelated implementation outside
  the declared change.

REVIEW:
- Flag suspicious scope expansion.
- Flag hidden behavioral changes.

## Evidence

REQUIRE:
- Claims about behavior must be supported by the actual staged code.
- Do not approve based on assumptions about files not inspected.

## Public contracts

REJECT IF:
- A public API or established project contract is changed silently.
- Compatibility-affecting behavior is changed without explicit evidence
  that the change is part of the authorized scope.

## Error handling

REJECT IF:
- Failure paths falsely report success.

## Testing

REJECT IF:
- Production code is modified solely to make a test pass.
- Tests without explicit justification use `it.skip` or `describe.skip`.

REVIEW:
- Verify tests describe behavior, not implementation details.
- Verify private functions are not directly mocked.


