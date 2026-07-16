# Project Governance — Account Express

> Nunca declarar que un protocolo fue cargado, una memoria fue guardada
> o una validación fue ejecutada sin evidencia verificable.

> **La preservación de la integridad de los datos tiene prioridad sobre la velocidad de implementación, la limpieza del código o la incorporación de nuevas funcionalidades. Ante cualquier conflicto, prevalece la integridad de la información.**

**Document ID:** GOV-001
**Version:** 1.1 (restructured)
**Status:** Stable
**Last Updated:** 2026-07-16

---

## Order of Precedence

When rules appear to conflict:

1. Explicit user authorization
2. Project Governance (this document)
3. Sprint specification
4. OpenSpec artifacts
5. Agent defaults

---

## 1. [MUST] Absolute Prohibitions

Do not execute without explicit authorization:

- `git reset --hard`
- `git clean`
- `git branch -D`
- `git push --force`
- `git rebase`
- `DROP`, `TRUNCATE`, or destructive migrations
- Mass record deletion
- Modifying `.env`, `.*`, secrets, or encrypted keys
- Deleting or replacing entire directories
- Working directly on `main`

## 2. [MUST] Protected Areas

Any modification to these areas requires prior analysis, backup, and separate authorization:

- `prisma/schema.prisma`
- `prisma/migrations/`
- Encryption and secrets
- Authentication and sessions
- `src/lib/backup.ts`
- Audit
- Journal entries (asientos)
- Reconciliation
- Bank rules
- Monetary precision
- Runtime configuration files
- Processes that update multiple transactions

## 3. [MUST] Honesty Rule

Do **not** declare:

- "completed"
- "safe"
- "working tree clean"
- "tests passing"
- "no risk"

without showing concrete evidence.

## 4. [MUST] Secrets

It is **strictly prohibited** to delete, regenerate, or modify secrets (SESSION_SECRET, API keys, encryption keys) without explicit authorization.

## 5. [MUST] No Hidden Changes

It is **strictly prohibited** to use a task as an opportunity to correct, refactor, clean up, or modernize code unrelated to the authorized scope.

Every additional change requires separate authorization.

## 6. [MUST] Destructive Command Confirmation

Certain commands require a **second explicit confirmation** before execution:

```
git clean
git reset --hard
git branch -D
git push --force
DROP
TRUNCATE
DELETE without WHERE
rm -rf
```

The AI must write:

> This command is destructive.
> Awaiting explicit authorization.

Even if the user has already granted general permission.

## 7. [MUST] Root Cause First

Before fixing a bug:

1. Identify the root cause
2. Demonstrate it with evidence
3. Only then implement the fix

Every fix must answer:

```
What is the root cause?

What evidence confirms it?

What fix addresses it specifically?

How is the fix verified?
```

## 8. [MUST] Governance Evolution

This document can only be modified through an explicit governance change.

Rules:

- Every modification must state the reason.
- `Change History` must be updated with each change.
- No rule may be removed without documenting why.
- A new rule does not replace another without leaving traceability.
- Changes to this document follow the same phases as code changes (see `runbooks/change-lifecycle.md`): propose, show, authorize, implement, verify.
- New sections are not accepted without a demonstrated incident that existing rules did not prevent.
- Corrections, clarifications, and incident-driven additions are always allowed.

## 9. [MUST] Scope Freeze

The approved scope of a task may not be expanded without authorization.

If during implementation a file outside the authorized list needs modification: **STOP** and request authorization.

## 10. [MUST] No Behavioral Change Without Documentation

If a change modifies business behavior, the AI must declare:

```
Previous behavior:

New behavior:

Reason:

Expected impact:
```

## 11. [MUST] Public API Contract

Routes, DTOs, and exported interfaces cannot change compatibility without explicit authorization.

## 12. [MUST] Specification First

Every business logic modification must have an approved specification before implementation.

Code without specification is an exception, not the norm.

## 13. [MUST] Verify State Before Acting

The AI must not assume it understands the current system state. It must verify through evidence before making modification decisions.

This principle applies to:

- Git branch, status, HEAD
- Runtime configuration and secrets
- Database schema and migrations
- Previous decisions and discussions
- Documented procedures

---

## Required procedures

Before modifying any project content, the AI must complete:

- **Mandatory Preflight** — see `runbooks/change-lifecycle.md`
- **Baseline Certification** — see `runbooks/change-lifecycle.md`
- **Critical Variable Certification** — see `runbooks/runtime-certification.md`
- **Protected Modification Protocol** — see `runbooks/change-lifecycle.md`
- **Blast Radius Declaration** — see `runbooks/change-lifecycle.md`

Before committing, always execute:

- **Pre-Commit Verification** — see `runbooks/verification.md`

Before declaring done, verify:

- **Definition of Done** — see `runbooks/change-lifecycle.md`
- **Regression Gate** — see `runbooks/change-lifecycle.md`

---

*Project Governance is the default operating policy for this repository.
Any exception must be explicitly authorized by the user and documented.*

## Change History

### v1.1 (restructured) (2026-07-16)
- Extracted domain invariants to `docs/domain/accounting-invariants.md`
- Extracted operational procedures to `docs/runbooks/`
- Extracted runtime data policy to `docs/process/runtime-data-policy.md`
- Reduced governance to executive rules only (~13 sections)
- Added Required Procedures section with cross-references to runbooks

### v1.1 (2026-07-15)
- Added governing principle: data integrity over speed
- Added Order of Precedence
- Split Domain Invariants into Functional and Technical categories
- Added Accounting Data Protection section
- Added multiple procedural sections
- Status changed from Draft to Stable

### v1.0 (2026-07-15)
- Initial governance policy
