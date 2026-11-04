# Recover an interrupted company restore

Use this operator command only after stopping all application and recovery processes for the installation. It reconciles an existing recorded operation; it does not start a new database replacement or delete the safety backup.

## Inspect without changing state

Set `ACCOUNTEXPRESS_DATA_DIR` to the installation's data root when applicable, then run from the application directory:

```text
node scripts/company-recovery.mjs inspect --operation <operation-uuid>
```

Inspection does not connect to a database. It prints the operation/company identity, maintenance identity, safety filename, lock SHA-256 (or `absent`), file keys and maintenance status. It does not print recorded file bytes or credentials.

## Reconcile after confirming the owner is stopped

Provide the installation's `DATABASE_URL` through the environment. Never paste credentials into reports or logs. Use the exact identities and lock digest returned by inspection:

```text
node scripts/company-recovery.mjs reconcile --operation <operation-uuid> --maintenance-id <maintenance-uuid> --lock-sha256 <digest-or-absent> --confirm-stopped
```

`--confirm-stopped` is an explicit operator assertion, not a process-liveness test. Do not use it while any application/recovery owner might still be running. A changed identity/digest, non-drained leases, malformed intent or mismatching receipt is a refusal, not permission to delete more files.

The command clears only the exact confirmed recovery lock, acquires exclusive recovery ownership, and queries the receipt in a read-only ReadCommitted database transaction after acquiring the company advisory lock. A matching committed receipt completes recorded file generations; an authoritative absence restores preimages. The command never replaces database rows.

- `committed`: recorded file application completed and maintenance reopened.
- `aborted`: no committed receipt; recorded preimages restored and maintenance reopened.
- Exit 1: inspect the error and keep the installation offline. Do not assume a fresh restore is safe. Unknown evidence or divergent file generations retain maintenance.

## Release only the confirmed lock

For an operator who needs lock disposition without database/file reconciliation:

```text
node scripts/company-recovery.mjs release-lock --operation <operation-uuid> --maintenance-id <maintenance-uuid> --lock-sha256 <digest-or-absent> --confirm-stopped
```

This leaves maintenance closed and preserves the journal, leases, safety backup and destination files. It is not recovery completion. `node scripts/company-recovery.mjs --help` describes every command and option.

## Observed scope

Deterministic tests cover missing confirmation, wrong maintenance identity and wrong lock digest without changing the recorded lock/journal. A disposable PostgreSQL 16 test exercises real DB/config/logo restoration, a controlled post-commit filesystem error, a child process exiting while holding recovery, and successful public-CLI reconciliation while preserving another company/global/shared-user state. This is not evidence of arbitrary power-loss durability or a completed browser workflow.
