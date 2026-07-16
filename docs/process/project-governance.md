# Project Governance — Account Express

> Nunca declarar que un protocolo fue cargado, una memoria fue guardada
> o una validación fue ejecutada sin evidencia verificable.

> **La preservación de la integridad de los datos tiene prioridad sobre la velocidad de implementación, la limpieza del código o la incorporación de nuevas funcionalidades. Ante cualquier conflicto, prevalece la integridad de la información.**

**Document ID:** GOV-001
**Version:** 1.1
**Status:** Stable
**Last Updated:** 2026-07-15
**Approved By:** __________________

---

## Order of Precedence

When rules appear to conflict:

1. Explicit user authorization
2. Project Governance (this document)
3. Sprint specification
4. OpenSpec artifacts
5. Agent defaults

---

## 1. [MUST] Mandatory Preflight

Before analyzing, modifying, deleting, moving, migrating, committing, or pushing any project content:

- Confirm working directory
- Confirm current branch
- Confirm `git status --short`
- Confirm `HEAD` commit and `origin/main`
- Confirm **not** working directly on `main`
- Certify `SESSION_SECRET` presence and format (never show values or fragments)
- Certify `DATABASE_URL` presence and format (never show values or fragments)
- Confirm PostgreSQL connectivity
- If Engram is available: register objective and authorized files before starting
- Read and apply this document

If **any** check fails: **STOP** and inform.

---

## 2. [MUST] Absolute Prohibitions

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

---

## 3. [MUST] Protected Areas

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

---

## 4. [MUST] Database Changes

Before modifying schema or data:

- Explain what changes
- List affected tables and columns
- Identify risk of data loss or accounting reinterpretation
- Create verifiable backup
- Define rollback plan
- Test on a separate database
- Run integrity validations before and after

No migration is considered safe just because Prisma accepts it.

---

## 5. [MUST] Accounting Integrity & Domain Invariants

### Functional Invariants (accounting correctness)

The following contracts are **never** to be broken:

- Double-entry always balanced
- Amounts always in cents (integer precision)
- Audit trail immutable (never deleted or altered)
- Closed periods never modified
- Reconciled transactions never reclassified
- Ignored transactions never reclassified
- Transactions with journal entries never modified
- Manual classifications never overwritten
- Deterministic results for the same input
- Orphan records never produced

### Technical Invariants (infrastructure and safety)

- Audit IDs never reused
- Migration history never altered after applied
- Encryption keys never changed without re-encrypting existing data
- Runtime secrets never stored in the repository
- Backups never stored alongside source code
- Database credentials never hardcoded

After any accounting or banking change, always verify the above.

Every Sprint must explicitly declare whether it affects any of these invariants.

---

## 6. [MUST] Accounting Data Protection

In addition to the invariants above, no process may:

- Alter historical balances
- Reinterpret posted transactions
- Regenerate audit history
- Modify closed periods

Unless explicitly authorized.

---

## 7. [MUST] Execution by Phases

Work in small, verifiable phases:

1. Investigate
2. Propose
3. Show affected files
4. Receive authorization
5. Implement one phase
6. Show diff
7. Run tests
8. STOP

Do not automatically continue to the next phase.

---

## 8. [MUST] Mandatory Pre-Commit Verification

Before committing, always show:

```powershell
git branch --show-current
git status --short
git diff --check
git diff --stat
git diff --cached --stat
```

Then execute and show results for:

```powershell
npx tsc --noEmit
npx vitest run --no-file-parallelism
npm run build
```

Database changes additionally require integrity tests and rollback verification.

---

## 9. [MUST] Engram (Persistent Memory)

Engram is a **mandatory** component of the development environment.

Before starting **any task that modifies** code, documentation, configuration, database, or Git, the AI must verify Engram is available.

If Engram is **not available**:

- The AI **must** inform the user immediately.
- Read-only tasks (inspecting, reading, searching) are **not blocked**.
- Modification tasks **must not** start without explicit user authorization.
- The AI **must not** claim that memory was saved or retrieved.
- The AI **must not** skip the notification.

If Engram **is** available:

- Save root cause of each incident
- Save which rule would have prevented it
- Save affected files
- Save authorized/prohibited commands
- Save architectural decisions
- Save validations performed

---

## 10. [MUST] Honesty Rule

Refer to the governing principle at the top of this document.

Do **not** declare:

- "completed"
- "safe"
- "working tree clean"
- "tests passing"
- "no risk"

without showing concrete evidence.

---

## 11. [MUST] Critical Variable Certification

Before modifying, the AI **must** verify that critical runtime variables exist:

- `SESSION_SECRET` — confirm presence and valid format
- `DATABASE_URL` — confirm presence and valid format

This check certifies **presence and format only**. It is **strictly prohibited** to print, log, or display values or fragments.

If either variable is missing or malformed: **STOP** and inform.

---

## 12. [MUST] Secrets

It is **strictly prohibited** to delete, regenerate, or modify secrets (SESSION_SECRET, API keys, encryption keys) without explicit authorization.

---

## 13. [SHOULD] Change Impact Levels

| Level | Scope | Examples |
|-------|-------|---------|
| N1 | Documentation | Comments, docs, README |
| N2 | UI | Components, styles, layouts |
| N3 | Business logic | Services, utilities, helpers |
| N4 | Persistence | Data access, queries, repositories |
| N5 | Critical | Prisma schema, migrations, encryption, auth, backup, journal entries, reconciliation, rules engine |

**N5 changes require explicit authorization even if the task was planned.**

---

## 14. [MUST] Mandatory Evidence

Every declaration of "done" or "ready" must be accompanied by evidence.

Examples:

```
npx tsc --noEmit
✓

npx vitest run --no-file-parallelism
1336/1336

npm run build
✓

git status --short
clean

git diff --stat
3 files changed
```

Evidence is part of the deliverable. Without it, the task is not complete.

---

## 15. [SHOULD] Incident Registry

Every time an incident occurs (e.g., lost `.env.local`, deleted branch, encryption failure, accidental file deletion, dangerous change), it **must** be recorded:

```
Incident ID:

What happened:

Root cause:

How it was detected:

How it was fixed:

What new rule prevents recurrence:

Preventive test added:
```

This turns every error into a permanent process improvement.

---

## 16. [MUST] Protected Modification Protocol

Every change **must** explicitly declare what it touches.

Example:

```
Authorized files:

✔ src/lib/services/transaction-invariants.ts
✔ tests/services/transaction-invariants.test.ts

NOT authorized:

✘ prisma/
✘ auth/
✘ backup/
✘ encryption/
✘ .env*
✘ package.json
✘ next.config.ts
```

**If during implementation a file outside the authorized list needs modification, STOP and request authorization before continuing.**

---

## 17. [MUST] Baseline Certification (mandatory before modifying)

Before touching the first file, the AI **must** show the project's initial state:

```
Branch: main
HEAD: 741fa00

git status --short
(clean)

npx tsc --noEmit
✓

npx vitest run --no-file-parallelism
1336/1336

npm run build
✓
```

If no baseline exists, the AI **cannot** later claim that "nothing was broken."

---

## 18. [MUST] Blast Radius Declaration

Before implementing, the AI must state explicitly:

```
Expected impact

Level: N3

Files:

- src/lib/services/transaction-invariants.ts
- tests/services/transaction-invariants.test.ts

Should NOT modify:

- prisma/
- backup/
- auth/
- audit/
- crypto/
```

If during implementation the impact changes:

```
STOP

The implementation requires modifying backup.ts.
Requesting authorization.
```

---

## 19. [MUST] Regression Gate

Before closing a task, answer four questions:

```
What changed?

What could have broken?

How was it verified nothing broke?

What evidence exists?
```

"Everything OK" without evidence is not acceptable.

---

## 20. [MUST] No Hidden Changes

It is **strictly prohibited** to use a task as an opportunity to correct, refactor, clean up, or modernize code unrelated to the authorized scope.

Examples of prohibited changes:

- "while I was there I changed..."
- "I took the opportunity to..."
- "I cleaned up..."
- "I refactored..."

Every additional change requires separate authorization.

---

## 21. [MUST] Safe Rollback

Every task must explicitly state how to undo.

```
Rollback Plan

- Affected files
- Migrations
- Affected data
- Rollback command
- Abort criteria
```

Git alone is not sufficient. A recovery plan must exist.

---

## 22. [MUST] Data Preservation

> No modification may reinterpret historical data without authorization.

Examples of prohibited reinterpretation:

- Reclassifying old transactions
- Recalculating historical balances
- Regenerating audit records
- Rebuilding journal entries

Historical data integrity is protected.

---

## 23. [MUST] Runtime vs Source

Runtime data:

> Never delete.
> Never version.
> Never regenerate.
> Never move.

Without explicit authorization.

Includes:

- `.data/`
- `.env.local`
- Secrets and keys
- Runtime logs
- User configuration

---

## 24. [MUST] Destructive Command Confirmation

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

---

## 25. [MUST] Root Cause First

Before fixing a bug:

1. Identify the root cause
2. Demonstrate it with evidence
3. Only then implement the fix

The following approach is **prohibited**:

> "Let's try this change and see if it works."

Every fix must answer:

```
What is the root cause?

What evidence confirms it?

What fix addresses it specifically?

How is the fix verified?
```

---

## 26. [MUST] Governance Evolution

This document can only be modified through an explicit governance change.

Rules:

- Every modification must state the reason.
- `Change History` must be updated with each change.
- No rule may be removed without documenting why.
- A new rule does not replace another without leaving traceability.
- Changes to this document follow the same phases as code changes (Section 7): propose, show, authorize, implement, verify.
- New sections are not accepted without a demonstrated incident that existing rules did not prevent.
- Corrections, clarifications, and incident-driven additions are always allowed.

---

## 27. [MUST] Runtime Certification

Before any modification that affects system execution, the following must be certified:

- `SESSION_SECRET` present and valid format
- `DATABASE_URL` present and valid format
- Prisma connected and migrations consistent
- `.data/` accessible (if applicable)
- Runtime initialized

> The absence of a critical runtime component must block any change that depends on it.

---

## 28. [MUST] Scope Freeze

The approved scope of a task may not be expanded without authorization.

Example:

```
Task:

Create transaction-invariants.ts

During work:

"backup.ts should also be modified"

↓

STOP

Request authorization before continuing.
```

---

## 29. [MUST] Definition of Done

A task may only be declared complete when:

- Authorized scope is implemented
- No unexpected changes exist
- `git status` is as expected
- Mandatory validations passed (`tsc`, tests, build)
- Evidence was shown
- No critical TODOs remain open
- Rollback plan is documented (Section 21)

---

## 30. [MUST] No Behavioral Change Without Documentation

If a change modifies business behavior, the AI must declare:

```
Previous behavior:

New behavior:

Reason:

Expected impact:
```

---

## 31. [MUST] Public API Contract

Routes, DTOs, and exported interfaces cannot change compatibility without explicit authorization.

---

## 32. [MUST] Specification First

Every business logic modification must have an approved specification before implementation.

Code without specification is an exception, not the norm.

---

## 33. [MUST] Verify State Before Acting

The AI must not assume it understands the current system state. It must verify through evidence before making modification decisions.

This principle applies to:

- Git branch, status, HEAD
- Runtime configuration and secrets
- Database schema and migrations
- Previous decisions and discussions
- Documented procedures

---

*Project Governance is the default operating policy for this repository.
Any exception must be explicitly authorized by the user and documented.*

For Domain Invariants, see **Section 5 — Accounting Integrity & Domain Invariants**.

## Change History

### v1.1 (2026-07-15)
- Added governing principle: data integrity over speed
- Added Order of Precedence
- Split Domain Invariants into Functional and Technical categories (Section 5)
- Added Section 6 — Accounting Data Protection
- Added Section 30 — No Behavioral Change Without Documentation
- Added Section 31 — Public API Contract
- Added Section 32 — Specification First
- Added Section 33 — Verify State Before Acting
- Added freeze policy: new sections only via demonstrated incident
- Status changed from Draft to Stable
- Added Document ID, Status, MUST/SHOULD/MAY classification
- Added Preventive Test field to Incident Registry (Section 15)
- Added Section 23 — Runtime vs Source
- Added Section 24 — Destructive Command Confirmation
- Added Section 25 — Root Cause First
- Added Section 26 — Governance Evolution
- Added Section 27 — Runtime Certification
- Added Section 28 — Scope Freeze
- Added Section 29 — Definition of Done
- Replaced "Project Governance wins" with exceptions-authorized policy
- Added Version History, Change History

### v1.0 (2026-07-15)
- Initial governance policy (sections 1–22)
