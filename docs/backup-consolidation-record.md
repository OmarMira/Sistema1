# Backup recovery consolidation record

This repository now carries a single portable backup/recovery implementation.
This record states what replaced what, where the previous implementation is still
recoverable, and which verification is still pending. It exists so a future
maintainer does not have to reconstruct the history from branches.

## What was consolidated

Two independent implementations of owner-verified backup recovery existed:

| Layer | Previous (`main` before this consolidation) | Consolidated (this branch) |
| --- | --- | --- |
| Ownership credential | `src/lib/backup-ownership.ts` | `src/lib/backup-portable.ts`, `src/lib/backup-recovery-auth.ts` |
| Recovered-history evidence | none | `src/lib/backup-recovery-provenance.ts` |
| Tests | `tests/api/backup-ownership.test.ts`, `tests/api/bootstrap-restore.test.ts`, `tests/api/restore-reanchor.test.ts`, `tests/ci/isolation-refusal-guards.test.ts` | `tests/bootstrap-recovery/` (38 suites), `tests/portable-recovery-postgres/`, `tests/startup-migrations/` |

### Merge outcome

`main` was merged into this branch rather than overwritten. The previous module
`src/lib/backup-ownership.ts` and its suite files therefore remain in the tree:
they are **not referenced by the consolidated restore path**. They are kept so no
reviewed artifact disappears; treat them as reserved reference code, not as part
of the active design.

One suite was removed because it asserted the replaced contract end to end (it
sealed an `ownership` verifier into the snapshot manifest and required restore to
honour it): `tests/backup-company/restore.test.ts`. It is preserved at the tag and
branch listed below.

The SMTP adapter was unified on the honest-failure behaviour and message
(`SMTP delivery rejected`): an unconfigured provider must never resolve silently,
because a caller reporting a delivered recovery token nobody received would leave
the operator behind a fictitious success.

They could not coexist: both modified the same entry points (`src/lib/backup.ts`,
`src/lib/backup-restore.ts`, `src/lib/backup-format.ts`, the portable and bootstrap
restore routes).

## Where the previous implementation is preserved

Nothing was discarded. The previous `main` state is recoverable from three
independent references on `origin`:

| Reference | Commit |
| --- | --- |
| Tag `preservation/main-before-portable-consolidation` | `8455ee33abd202a12cb361b650a53136677a7b34` |
| Branch `feat/secure-restore-ownership` | `2fa11907c2e11db38880bf3dfe2c572e63b4edc0` |
| Pull request #121 (merged) | same content |

## Pending verification (must not be treated as covered)

The four previous suites above were behavior-level: they imported
`@/lib/backup`, `@/lib/backup-format`, `@/lib/journal-hash` and
`@/lib/journal-chain`, never `backup-ownership` directly. They were therefore not
proven equivalent, only de-referenced by this consolidation.

They still need to be revalidated against the consolidated implementation in a
**disposable PostgreSQL instance**, never an operator database:

- restore re-anchoring of retained history;
- bootstrap restore;
- backup ownership credential checks;
- CI isolation refusal guards.

Reason they were not revalidated before this consolidation: the default Vitest
configuration targets a real local database, and no disposable PostgreSQL runtime
was available in this environment. Repository policy forbids running those suites
against operator data.

## Known open defect (documented, not fixed here)

An operator restore was observed failing with:

```text
Transaction already closed: A query cannot be executed on an expired transaction.
The timeout for this transaction was 20000 ms, however 20001 ms passed
```

Cause: the restore transaction performs per-row inserts, whole-installation
destination reads, repeated snapshot validation and stored-backup inventory work
inside a fixed 20-second Prisma transaction budget. Raising the timeout alone
masks the growth; the planned order is bounded per-table batches, moving backup
catalog maintenance out of the critical section, and removing repeated scans
before sizing a new finite budget for the largest supported payload.

Until that is implemented, a large restore can end in
`RECOVERY_RECONCILIATION_REQUIRED` and leave maintenance closed by design.
