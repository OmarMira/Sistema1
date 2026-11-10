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

## Suites removed as obsolete contract

These suites asserted the replaced design end to end and cannot be adapted without
asserting something false about the current system. They are recoverable in full at
the preservation references above.

| Removed suite | Why it cannot survive |
| --- | --- |
| `tests/api/backup-ownership.test.ts` | Requires the ownership verifier sealed inside the snapshot manifest and `BACKUP_PASSWORD_REQUIRED`; the credential now lives in the AEAD container. |
| `tests/api/restore-reanchor.test.ts` | Requires `RESTORE_REBASE` / `RESTORE_CHAIN` re-anchoring of an unrooted segment and `RESTORE_LEGACY_FORMAT`; those codes no longer exist. |
| `tests/api/bootstrap-restore.test.ts` | Pins `RESTORE_LEGACY_FORMAT` / `RESTORE_CHAIN` messages of the removed sealed-snapshot flow. |
| `tests/integration/bre013-atomicity-44-45.test.ts` (test `4.5` only) | Triggered a rollback through a nonexistent `AuditLog.userId`; migration `20261109010000_immutable_audit_user_reference` removed every AuditLog foreign key, so that failure is unreachable. Tests `4.4` stays. |

Suites that pin *current* behavior were adapted instead of deleted: download
authorization, export hashing, restore maintenance, RBAC server-side gates, backup
delete integrity, bootstrap check, settings diagnostics visibility and the portable
wave6 flow. A shared fixture helper (`tests/helpers/backup-owner.ts`) now seeds the
proven owner the current contract requires.

## Dedicated harnesses excluded from the application suite

`tests/startup-migrations/**` and `tests/portable-recovery-postgres/**` refuse to run
unless the disposable database is named exactly `accountexpress_bootstraptest`. That
guard is deliberate and was not weakened; both run through their own configs and are
excluded from the root application suite, which uses `accountexpress_test`.

## Known defects and follow-up coverage

1. `src/lib/backup.ts` (`deleteBackup` → `readManifest` → `readCatalog`): DELETE reads the
   **whole** catalog, so one unreadable backup belonging to **any** tenant turns another
   tenant's DELETE into a 500 instead of the neutral 404 that `GET` already guarantees.
   It reproduces only when stale residue exists, which is why a fresh CI database hides it.
2. Audit-write rollback coverage was replaced in
   `tests/perf/restore-measure.perf.ts` (`receipt failure`): the test-only transaction
   wrapper inserts the commit receipt twice, provoking PostgreSQL's real unique-key
   error (`P2002`) at `auditLog.create`. It checks complete exported-data rollback,
   original row counts, absence of a committed receipt, a closed maintenance fence,
   and explicit reconciliation to `aborted`. This is an opt-in real-PostgreSQL test,
   not a claim that the root CI runner executes it.

## Restore performance follow-up

Commit `855960a` batches journal entries/lines within the existing transaction and
indexes repeated admission lookups without removing integrity checks. The deadline
remains 20 seconds. An independent synthetic run restored 10,000 entries and 20,000
lines with verified counts/scalars and forced-failure rollback; its transaction took
8.89 seconds. Timings vary by machine and destination state and are not a capacity
or latency guarantee. Engine-level proof does not establish both portable entry doors.
See `odd/tasks/backup-restore-performance.md` for the remaining route-level checks and
delivery status.
