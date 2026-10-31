# Coordinated company recovery service

The company recovery service restores database rows, the selected company configuration and archived logo bytes under drained maintenance. HTTP/UI wiring and PostgreSQL/browser/crash acceptance are separate, pending work; do not deploy this service as a completed recovery workflow.

## Service entry points

- `restoreCompanyBackupCoordinated(companyId, text)` validates the source, closes normal admission, drains existing operations and captures a consistent safety snapshot.
- Before database replacement it writes an immutable, checksummed intent under the runtime `backup-recovery` directory. The intent contains the exact whole-file configuration preimage, proposed image, optional logo preimage/image, operation ID, checksum, safety filename and maintenance identity.
- Database replacement and its audit receipt commit together. Confirmed commit permits file application. An uncertain outcome returns `reconciliation_required` and retains maintenance; it is not success and must not be retried as a fresh restore.
- `reconcileCompanyBackupRecovery(companyId, operationId)` reads that existing intent. It acquires the company advisory lock under ReadCommitted before querying the receipt, so receipt absence is not inferred from a pre-commit snapshot. Verified presence completes files; verified absence undoes them without repeating database replacement. Results are `committed`, `aborted`, or `reconciliation_required`.

These are trusted server service APIs, not authentication or HTTP bypasses. Callers must authorize the actor and exact company. The existing database-only service remains available with its original refusal of differing files.

## Preservation and boundaries

Configuration composition changes only the selected own company property and retains global fields and other companies. Preflight verifies every target matches a recorded before/after generation before changing any target; divergent files remain blocked. Partial application can resume from mixed known generations. Application targets are mapped by trusted code, never taken as filesystem paths from an archive.

New snapshots optionally include `manifest.companyLogo` with exact base64 bytes and SHA-256, covered by the existing snapshot digest. Logo-bearing older archives without bytes are refused by coordinated recovery. The installed/development storage mapping reuses the logo service's trusted configuration. A source logo path shared by another company is refused. Old unreferenced logo files are retained rather than deleted speculatively. Original bank-statement source attachments and user avatars are not an original-byte archive in this format.

Recovery execution and maintenance release acquire the same exclusive `recovery.json` lock. Ownership is checked again after acquisition. A resumed owner cannot reopen admission during another owner's active recovery.

## Interrupted-process limitation

A process crash may leave `recovery.json`. There is no timed or automatic lock theft. Normal admission remains closed. Operator disposition requires establishing that the previous recovery is stopped before clearing its owned lock and reconciling the recorded operation. That operator workflow, actual process/power-loss behavior and directory-entry durability require acceptance testing; `fsync` alone is not proof.

Do not delete maintenance markers, leases, journals or locks simply to reopen the application. Preserve the safety snapshot and intent until recovery has been confirmed.

## Runtime import boundary

Next.js application modules import `backup-runtime-maintenance` without an extension. This TypeScript facade creates the shared runtime gate and delegates to the explicitly imported plain-Node `backup-maintenance.mjs`. The old explicit `backup-maintenance.ts` path is a compatibility re-export. Do not import a nonexistent `backup-maintenance.js` or rely on extensionless resolution of the colliding `.ts`/`.mjs` basename.

## Observed checks

The isolated deterministic suite passed 220 tests in 15 files after the release/recovery race correction. Scoped TypeScript and `git diff --check` passed. A baseline differential matched existing maintenance API outputs, errors and exit codes before that final correction. An independent verifier reproduced the race; its regression failed before the correction. Limited independent structural recheck found the exact race resolved, without rerunning tests. None of this establishes final PostgreSQL, browser, crash or complete feature acceptance.
