# Change Lifecycle

## Mandatory Preflight

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
- Read and apply `docs/process/governance.md`

If **any** check fails: **STOP** and inform.

## Execution by Phases

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

## Change Impact Levels

| Level | Scope | Examples |
|-------|-------|---------|
| N1 | Documentation | Comments, docs, README |
| N2 | UI | Components, styles, layouts |
| N3 | Business logic | Services, utilities, helpers |
| N4 | Persistence | Data access, queries, repositories |
| N5 | Critical | Prisma schema, migrations, encryption, auth, backup, journal entries, reconciliation, rules engine |

**N5 changes require explicit authorization even if the task was planned.**

## Protected Modification Protocol

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

## Baseline Certification (mandatory before modifying)

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

## Blast Radius Declaration

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

## Scope Freeze (operational)

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

## Regression Gate

Before closing a task, answer four questions:

```
What changed?

What could have broken?

How was it verified nothing broke?

What evidence exists?
```

"Everything OK" without evidence is not acceptable.

## Safe Rollback

Every task must explicitly state how to undo. See the full rollback procedure in `runbooks/database-change.md`.

Git alone is not sufficient. A recovery plan must exist.

## Definition of Done

A task may only be declared complete when:

- Authorized scope is implemented
- No unexpected changes exist
- `git status` is as expected
- Mandatory validations passed (`tsc`, tests, build)
- Evidence was shown
- No critical TODOs remain open
- Rollback plan is documented (see Safe Rollback above)

---

## Change History

### v1.0 (2026-07-16)
- Extracted from `docs/process/project-governance.md` sections 1, 7, 13, 16, 17, 18, 19, 21, 28, 29
