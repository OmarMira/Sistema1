# Per-company backup and bounded database recovery

T1 implements company exports and recoverable history. The original
`restoreCompanyBackup` remains database-only. T2 additionally implements
`restoreCompanyBackupCoordinated` with drained maintenance, immutable file
preimages, a transaction receipt and post-commit configuration/logo replacement.
It is not yet enabled by HTTP routes; real crash/browser acceptance is pending. New exports use format `2.1.0`; the
legacy/bootstrap restore validator still rejects both company-format versions before restore
side effects. Do not describe this feature as release-ready or as proven complete
recovery until T2–T5 supply coordinated files, crash/browser and remaining
independent acceptance evidence. The bounded database core and fidelity source
have passed independent PostgreSQL 16 probes; that is not full option C.
For the independently committable export/catalog contract, start with
[Company snapshot format 2.1.0](company-backup-format.md).

> The paragraphs above describe the T1/T2 slice. Both restore paths ARE wired to
> HTTP now, and the ownership credential, the legacy-format refusal, the
> historical re-anchor and restore-as-new-company are implemented and pinned by
> tests — see [Ownership credential, certified historical restore and
> restore-as-new-company](#ownership-credential-certified-historical-restore-and-restore-as-new-company-s1s6)
> for the current contract. Real browser/crash acceptance is still open.

## Coordinated recovery and interrupted operations

The coordinated service closes maintenance admission and drains existing writers
before publishing a safety snapshot and an immutable `config/backup-recovery`
intent. It replaces the database in a serializable transaction, including an
operation receipt. Only a confirmed commit permits file replacement. Shared
company configuration is composed from its whole-file preimage, changing only
`companies[companyId]`; global fields and other companies are retained. A logo
URL shared by another company is refused rather than overwritten. Old unused
logo files are retained, not deleted speculatively.

`reconcileCompanyBackupRecovery(companyId, operationId)` reads the validated intent
and resumes only its exact maintenance identity. It obtains the same advisory
lock under **ReadCommitted**, then queries the receipt, avoiding an obsolete
snapshot of an in-flight COMMIT. A verified receipt completes the recorded files;
a verified absence restores preimages without replaying database replacement.
An unavailable or mismatched receipt, divergent file bytes, or corrupt intent
keeps maintenance closed. Results are `committed`, `aborted`, or
`reconciliation_required`; callers must not label the latter as success.

Recovery callbacks additionally hold exclusive `backup-maintenance/recovery.json`.
A process crash can leave that lock behind. It is **not stolen or deleted
on a timeout**: an operator must establish that the owning recovery is stopped
before disposing of its lock and reconciling the recorded operation. The current
service does not automate that operator disposition. Do not delete the marker,
leases, journal, or lock simply to reopen the application. Power-loss durability
and the operator recovery workflow remain acceptance requirements, not proven
by an `fsync` call or passing unit tests.

## Use and interpretation

- `createBackup(companyId)` retains its return shape: ID, filename, byte size,
  creation time, base64-encoded UTF-8 JSON, and record counts. A resolved promise
  means the complete file and index update succeeded. It does not prove download
  delivery, authenticity, recovery, or power-loss durability.
- `listBackups(companyId)` validates files and filters their embedded company
  identity. Missing/corrupt indexes are not empty history: files reconstruct the
  catalog in memory, without read-side writes. Actual filesystem errors and
  invalid/corrupt backup JSON throw rather than masquerade as an empty list.
- `getBackupFile(filename)` retains exact JSON text/UTF-8 size and `null` for
  invalid or absent filenames. It rejects symlinks and non-regular files; it is
  not a tenant authorization API. The caller still must authorize access.
- `deleteBackup(filename, companyId)` retains `invalid`, `not_found`, `deleted`.
  Ownership comes from validated file metadata, with an index only supplying old
  IDs. It removes only the named owned file, then refreshes the cache. If that
  refresh fails, the deletion has already happened and an error is propagated.

## Browser download fidelity (T3a)

Both `BackupTab` and `BackupPage` now use `src/lib/backup-download.ts` for
creation downloads and history downloads. The existing JSON/base64 API contract
is unchanged: base64 is decoded to `Uint8Array` bytes before constructing a Blob,
never converted from a binary JavaScript string back into UTF-8 text. Filenames,
JSON MIME type, whitespace and original bytes are preserved. Object URLs are
released on the next event-loop turn and temporary anchors are removed even if
the click throws. Triggering the browser download does not prove the user saved
the file successfully.

Six deterministic tests cover ASCII compatibility, exact Unicode bytes and byte
size, filename/lifecycle, click failure cleanup and unusable payload rejection.
These use Node's real Blob and a mock DOM, not a browser acceptance test. Both
screens are wired to the helper, but real browser download evidence remains T4.
Missing-payload/API error visibility and create-versus-download notifications
remain T3 work; this slice does not claim to resolve them or implement recovery.

## Explicit inventory

Names below are JSON data sections. Arrays retain database IDs, timestamps,
serialized monetary values, references and counts; no accounting links are
stripped. Company snapshots use the guarded **unextended** transaction capability,
not the UI client's Number overrides. All 13 installed monetary columns are
`Decimal(18,2)` and serialize as canonical decimal strings, with exactly two
fraction digits and no Number intermediate. The full range is
`-9999999999999999.99` through `9999999999999999.99`, including `0.01`.
The public application's per-field Number results and lazy Prisma promises are
unchanged. Both deterministic tests and the separately observed PostgreSQL 16
probes cover these monetary values; neither proves complete disaster recovery.

| Category | Included sections and scope |
| --- | --- |
| Company/accounting | `company`, `glAccounts`, `bankAccounts`, `bankStatements`, `bankTransactions`, `bankRules`, `journalEntries`, `journalLines`, `fiscalPeriods`, `reconciliationPeriods`, `journalChainHead` |
| Company access | `companyMembers`, `companyModuleEntitlements`; `users` contains public identity/profile references for members and reconciliation/application/audit actors, never password hashes, sessions or credentials |
| Company operation/configuration | `entityContexts`, `detectionConfigs`, `csvLayoutProfiles`, plus only `companies[companyId]` from runtime `company-config.json` |
| Durable rule/audit anchors | `ruleApplyRecords`, `ruleExecutionAudits`, `auditLogs` filtered by company ID; references and historic audit payloads are preserved, not re-signed |
| Knowledge | `companyKnowledge`, its `knowledgeAudit`, and company-owned `pendingApprovals` |
| Memory | `systemMemories`, `memoryItems`, `memoryVersions`, `relationships`, `contradictions`, `evolutionLinks`, `traceabilityLogs`, `confidenceLogs`; graph edges are queried through either endpoint and rejected if they cross companies |

`journalChainHead` is an explicit nullable object, not a counted array. Company
configuration is an object/null with a boolean presence count. Other mandatory
v2 arrays each have a numeric count. Legacy `systemConfig` remains an **empty**
array/count for shape compatibility, not an installation-config snapshot.

### Excluded and regenerable state

- All global `SystemConfig`, including non-AI keys; shared `BankProfile` data;
  global/null-company audit rows and other companies' records.
- Shared-user credentials/authority establishment, sessions, rate limits, identity
  challenges/registrations/security infrastructure. Exported user profiles are
  reference material, not permission to overwrite a shared identity during recovery.
- Environment variables, database connection settings, AI keys, signing/HMAC keys,
  installation/setup tokens and installer/runtime/program files. A checksum does
  not replace the journal chain's external key material.
- Original source statement attachments and user avatars. Schema
  `BankStatement.fileName` is metadata, not an original-byte attachment archive.
  New snapshots include the company logo as `manifest.companyLogo` (URL, base64
  bytes and SHA-256), protected by the snapshot digest. Missing or unsupported
  logo files fail export; older logo-bearing archives without bytes fail
  coordinated recovery. No AEX conversion or access is performed.
- Caches, derived application state and the catalog cache are regenerable. The
  database memory/knowledge history itself is included, not treated as a cache.

Exports still contain sensitive company business data and personal profile data.
Protect storage and transfer appropriately. Excluding shared secrets does not
make these exports public or anonymized.

## Consistency and integrity

Every database read runs inside one Prisma interactive `RepeatableRead`
transaction, including company existence, actor profiles, chain head and SQL-null
metadata. `withCompanyBackupTransaction<T>(callback, options)` accepts a callback
with `Prisma.TransactionClient` and preserves `isolationLevel`, `maxWait` and
`timeout`. It uses the private base client but gives the callback only a guarded
transaction; `withRuntimeOperation` holds normal admission or live owned recovery
authority around the entire transaction and commit. It exports no unguarded
client. Preview/export do not perform model writes; this capability also supports
the existing serializable replacement, so it does not issue `SET TRANSACTION READ
ONLY`. Normal application `db` behavior is unchanged. No
global config query occurs. This is a database snapshot, not a lock over the
filesystem. Company config is read before and after it; malformed/unreadable
configuration or an observed change fails before publication. Missing company
configuration is explicit `null`. This check cannot detect an intervening
change-and-revert or coordinate concurrent writers; T2/T4 must address coordinated
DB/file recovery. There is no claim of an atomic distributed DB/file snapshot.

V2 embeds a UUID export ID, format version, creation time, company identity,
mandatory-section counts, and an integrity object. The digest covers the UTF-8
bytes of `JSON.stringify({manifest-without-integrity,data})` in property order,
avoiding a self-referential digest. NEW snapshots are keyed
(`algorithm: 'hmac-sha256'`, `authenticated: true` — an HMAC with a key derived
from SESSION_SECRET via PBKDF2+HKDF, so forgery requires the secret); LEGACY
snapshots sealed with plain SHA-256 (`authenticated: false` — a corruption
checksum, **not a signature**) still verify through the read-legacy branch.
Whitespace changes to the outer pretty-printed JSON do not change either
digest. Saved JSON bytes and returned base64 bytes are identical; size is the
UTF-8 byte count, not the JavaScript character count.

Legacy `1.0.0` and `1.1.0` JSON can still be cataloged/read/deleted, with ownership
checked against embedded company metadata. They have no new checksum guarantee.
A healthy old index preserves their old ID; after index loss their stable fallback
ID is `legacy-` plus SHA-256 of the filename. New IDs survive index loss because
they live in the payload. Unknown versions cannot enter the catalog or legacy
restore. Format `2.0.0` also remains catalogable/readable/deletable, with its original
checksum and ID. Recovery accepts it only if every amount is unambiguous and no
nullable JSON field contains a provenance-less null. New fields are mandatory in
`2.1.0`; changing a version or omitting its metadata does not waive validation.
Legacy/bootstrap restoration continues to refuse both company formats.

## Publication, recovery and failures

A final name is `<companyId>_<UUID>.json`, so same-clock exports do not collide.
The company ID is restricted to ASCII letters/digits/underscore/hyphen before
any database access. Existing final files are never overwritten, even if a UUID
collides.

Publication writes an exclusive mode-0600 temporary file in the backup directory,
flushes/closes it, then uses an atomic hard link to the final name. No copy or
replace fallback is used when hard links are unavailable. The index uses its own
exclusive temporary file and atomic rename. Only temporary files created by that
invocation are cleaned up. Hard termination may leave a dot-prefixed `.tmp` file;
these are ignored by catalog scans and are not automatically deleted.

Index replacement alone now handles transient Windows `EPERM` with at most four
atomic rename attempts and 10/25/50 ms synchronous waits (85 ms requested wait;
filesystem/scheduling latency is additional). It reuses the same flushed/closed
temp, revalidates both paths before each attempt and never deletes the old index.
Other errors/platforms, path validation and primary snapshot linking do not retry.
Permanent failure remains visible with the original error/code in `error.cause`;
the complete published file remains discoverable and the old cache stays intact.
See [bounded Windows index replacement](company-backup-format.md#bounded-windows-index-replacement)
for the synchronous latency and compatibility limits. Safety publication uses the
same policy: exhaustion still stops recovery before database mutation. No command
or test runner is automatically retried.

| Failure point | Observable result |
| --- | --- |
| Snapshot/config/serialization/prepublication validation | Rejected promise; no final export/index change |
| Temporary write/flush/link or collision | Rejected promise; old files/index preserved; owned temporary file cleaned if possible |
| Final published, index update fails | Rejected promise explicitly naming the published file; complete snapshot remains discoverable by catalog scan |
| Index missing/corrupt/stale | Catalog derives records from validated JSON; index never grants another tenant ownership |
| Storage unavailable or corrupt candidate JSON | Error, not successful empty history; no silent exclusion of damaged history |

Reads/writes/deletes reject path traversal, separators, directory targets and
symlinks/junctions in existing path components, including the backup directory.
The directory must remain trusted against hostile local concurrent filesystem
mutation: pathname checks are not a portable kernel-level sandbox against a
privileged process replacing ancestors between checks. Catalog recovery checks
integrity/identity, not cryptographic tenant provenance. Directory metadata is
not explicitly fsynced; power-loss and filesystem-specific hard-link/rename
behavior still require isolated platform testing. None of these checks is an
absolute reliability guarantee.

Concurrent index replacement cannot make a complete export disappear from a
subsequent scan because the cache is not authoritative. Cross-process file
create/delete races and power interruption still need T4 acceptance evidence.

## Verification and next slice

The isolated suite mocks DB/auth/logger before importing the backup library and
uses only an owned directory under `tests/backup-company/.scratch` with teardown.
It does not connect to PostgreSQL, seed data, launch the application or touch
existing backups. `envDir: false`, empty setup/globalSetup and the native config
loader avoid default setup and bundled-config output.

```text
node node_modules/vitest/vitest.mjs run --config vitest.company-backup.config.mts --configLoader native
```

The default suite is deterministic adapter/filesystem evidence only. Separately,
independent verifier `mvve7cpf-k-ynfa` observed 191 isolated tests, three genuine
PostgreSQL probes (194 combined) and strict scoped bundler typechecks passing
without product corrections. That verdict predates the bounded Windows catalog-
replacement correction; the changed storage file requires a limited independent
recheck of that blocker, not a claim of browser/crash/full-recovery acceptance.
The parent owns feature-branch-chain commits and remaining acceptance. In particular, review bootstrap and normal restore
API callers of `validateBackup` for the intended v2 rejection before enabling any
v2 recovery UI. The bounded core below is not a substitute for coordinated
DB/files recovery, authorization integration or independent acceptance.

## T2 public database recovery core

Import from `src/lib/backup-restore.ts`:

```ts
previewCompanyRestore(companyId: string, text: string): Promise<CompanyRestorePreview>
restoreCompanyBackup(companyId: string, text: string): Promise<CompanyRestoreResult>
```

Both functions require exact company-format JSON text (`2.1.0`, or a fidelity-
unambiguous `2.0.0`) and an **already existing destination
company with the same ID**. Neither function authorizes the caller. T3 must
supply authenticated company-admin authorization, preview confirmation bound to
the checksum, and post-commit session/cache refresh before wiring routes. The
existing `restoreBackup` and bootstrap security behavior are unchanged; v2 is
not delegated through the old function.

Preview returns deeply frozen company ID, checksum, inventory counts, section
IDs, explicit `database-only` scope and blockers. It runs read-only destination
checks in a repeatable-read transaction and does not create directories, safety
backups, audit events or counters. A preview is not a reusable authorization or
lock: replacement repeats destination checks inside its own protection.

Validation covers checksum/version/counts, exact company/manifest identity,
mandatory sections, installed Prisma scalar fields/types/enums, unknown columns,
primary/unique keys, every schema FK and closed memory graph. It also checks
operational transaction references, the journal-entry/line pair and live approval
payload company/knowledge references. Historical free-text actor names and
opaque JSON audit/metadata content are preserved as history, not interpreted as
new credentials or executable authority. Duplicate nested export copies of
statement transactions, entry lines and member identities must agree with their
authoritative arrays. Cyclic GL/knowledge self-links are rejected.

Users are **references only**: each exported ID/email must match an existing
destination identity. Missing/mismatched identities fail with
`RESTORE_MISSING_IDENTITY`, never create credentials. Password/security columns
in user payloads fail schema validation. No shared user, global `SystemConfig`
or `BankProfile` is written. Other-tenant ID/unique collisions and inbound FKs
fail before safety publication, including references whose deletion would
otherwise cascade or set another tenant's field to null.

Journal hashes/head are certified by the existing `buildChainVerdict` policy
using original IDs, amounts, lines and hash versions. Audit HMACs are verified
with their stored predecessors, then the proposed merged installation-wide audit
timeline is certified to avoid breaking another company's chain. Ambiguous equal
timestamps among signed audit records fail closed. A missing/different source
HMAC key, uncertifiable legacy chain or incompatible global audit history is a
refusal, not a conversion, fabricated signature or auto-re-signing operation.
The checksum is still not authenticity or authorization evidence.

### Replacement, safety and outcome

The core takes a transaction-scoped PostgreSQL advisory lock keyed by company,
then locks the Company row `FOR UPDATE`. It reads destination ownership,
references and unique constraints again inside a serializable transaction.
Cooperating core restores serialize across processes; conflicting database
writers must cause a serialization/constraint failure rather than be silently
retried. PostgreSQL 16 round-trip and transaction-form probes have passed;
concurrent conflicting-writer, crash and power-loss guarantees remain unproven.
Destination collision checks currently scan inventory tables, so large-company
performance must be measured before rollout.

Before any database mutation, the **existing export snapshot builder** captures
current company state in that same transaction. The safety archive is sealed,
strictly validated and published using the existing no-overwrite storage
publisher. Failure of write, flush, link, validation or catalog publication stops
before database writes. A catalog failure may leave a complete discoverable
safety file, explicitly reported by the existing publisher. This inherits T1's
unaccepted durability/platform limits, including lack of directory fsync.

Replacement unlinks nullable self-references, deletes owned rows in reverse FK
order, updates company metadata, then inserts in FK order and restores nullable
self-links. IDs, timestamps, accounting links, all mandatory sections and chain
values are preserved; users/global config are not inserted. Safety snapshots use
the same raw capture, format and strict source validation as ordinary exports.

### Lossless format 2.1.0

`manifest.fidelity` is mandatory, checksum-covered metadata:

```json
{
  "monetary": "decimal-18,2",
  "jsonNulls": [
    { "model": "BankRule", "key": { "id": "rule-id" }, "field": "conditions", "kind": "db-null" },
    { "model": "KnowledgeAudit", "key": { "id": "audit-id" }, "field": "beforeValue", "kind": "json-null" }
  ]
}
```

There must be exactly one reference for each top-level null in a **nullable Json**
column, and none for other columns/rows. Kinds are exactly `db-null` or
`json-null`; identifiers, key columns/values, field ownership and total reference
count must match the installed inventory. Primary keys come from DMMF, including
`DetectionConfig.companyId`, not a blanket `id` assumption. No archive-provided
SQL identifier is used. Capture queries installed nullable-JSON models using
parameterized row keys and schema-owned quoted identifiers, inside the same
snapshot as the rows. Missing/failed metadata queries fail capture closed; a
plain Prisma `null` is never treated as proof of SQL NULL. Current nullable
columns are `BankRule.conditions` and `KnowledgeAudit.beforeValue/afterValue`.

Recovery writes `Prisma.DbNull` for SQL NULL and `Prisma.JsonNull` for JSON null.
A required JSON column's top-level null means JSON null; nested ordinary JSON
nulls remain untouched. Preview does not annotate or mutate input/nested JSON.
Money in 2.1.0 must be canonical strings; out-of-range, excess scale, numeric,
nonfinite or noncanonical representations fail before destination queries,
safety publication or mutation.

For 2.0.0, a null in any nullable JSON field fails with
`RESTORE_FIDELITY: unsupported 2.0.0 nullable JSON fidelity: <Model>.<field>; SQL NULL versus JSON null provenance is missing`.
No missing provenance is invented. Numeric legacy amounts must be finite,
strictly below `2^45` in absolute value, and their literal shortest decimal
spelling must be an exact schema cent. Below that bound binary64 spacing is
less than one cent, so installed cent values map injectively. Unsafe legacy
money fails with `RESTORE_FIDELITY: unsupported 2.0.0 monetary fidelity: <Model>.<field>`;
safe values retain their literal input value (no normalization or rounding).
This cannot repair already-corrupted archives or certify their authenticity.

One unsigned `COMPANY_RESTORE_COMMITTED` operational AuditLog receipt is inserted
inside the transaction with `id = operationId`, source checksum and safety
filename. This is not an accounting signature. Returned `counts` describe source
inventory, including referenced users, **not user writes**; destination AuditLog
has the source rows plus this extra receipt. `status: committed` confirms only
that the DB transaction resolved, with `scope: database-only`.

Once mutations start, any transaction error returns `status: not_confirmed`,
`operationId`, `safetyFilename` and a warning to inspect the receipt/safety archive.
It never asserts rollback merely because the connection failed during COMMIT.
A confirmed absence/presence requires a later trusted DB inspection; do not
auto-retry an ambiguous result. Later recoveries retain earlier receipts in their
safety archives even if replacing current company audit rows. A crash can leave
a safety archive without a receipt, or a committed receipt without a returned
response. There is no file replay queue or delayed configuration writer.

### Deliberately blocked files integration

If target company configuration differs from the archive, restore rejects
`RESTORE_FILES_REQUIRED` **before database mutation**. If source or destination
company has a nonempty logo reference, it rejects `RESTORE_ASSETS_REQUIRED`.
Preview lists these blockers without writing anything. Equal configuration may
be left untouched; an observed change during safety publication also rejects.
Equality/rechecks are not cross-process file locks and do not establish a
consistent DB/file snapshot. Other companies' JSON slices are byte-for-byte
preserved because this core never writes the shared file at all.

Concrete storage evidence:

- `src/lib/services/onboarding.service.ts:saveCompanyConfig` reads and rewrites
  the entire runtime JSON directly, including a write *inside* its DB transaction.
  `src/internal/operation-controller/resources/file-resource.ts` also permits
  direct file writes. T2b now fences both through runtime admission, but neither
  supplies a persistent cross-resource undo/reconciliation journal.
- `src/lib/config/paths.ts` selects `.data/company-config.json` in development or
  `<DATA_ROOT>/config/company-config.json` for an installed instance.
- `src/lib/uploads/logo-service.ts` uses `public/uploads/logos` (development,
  configurable through upload rules) or `<DATA_ROOT>/uploads/logos` (installed),
  while DB logo/avatar references use `/uploads/logos/<filename>`. Avatar files
  are shared identity assets and are not overwritten by company restore.
- The import route reads source statement bytes into memory and passes them to
  `ImportService.importFile`; that service persists `BankStatement.fileName` as
  metadata. The inspected import/PDF paths do not provide a durable original-file
  archive or a mapping from that name to restorable bytes. The current v2 format
  cannot recover original statement files from filenames.

The owner selected enforced maintenance (option C). T2b fences supported DB,
startup, background, runtime-config/asset and script writers through the shared
maintenance boundary. Persistent undo/reconciliation, file replacement and real
files/crash acceptance still remain required before recovery is operational.
A reader-before/after check or process-local mutex alone is not sufficient.

The deterministic recovery tests use in-memory rollback/commit-ambiguity adapters,
assert actual FK dependency ordering from installed schema metadata, and use real
owned scratch files for publication failures. They prove application behavior,
not PostgreSQL serializability, cross-process filesystem cooperation, power-loss
recovery, external asset restoration, browser acceptance or independent review.
S1/S2/S4 receive a bounded database-core contribution, not full T2/S4 acceptance.

## Maintenance coverage and remaining gate

The committed [persistent maintenance boundary](backup-maintenance.md) is the
source of truth for T2a/T2b contracts. Supported model/raw/array/interactive DB
operations, extension receivers, startup mutations, background cleanup, logout,
onboarding, logo/file writers and the deletion script now share admission.
The raw company transaction helper uses the same runtime lease/owned-recovery
guard. HTTP callers do not gain recovery bypass authority.

No persistent undo journal, asset replacement, startup reconciliation or new
recovery route is supplied. Crashed owners still leave blocking records; there
is no automatic stale cleanup. Cooperating processes and trusted local storage
remain required. Do not activate restoration solely because writer fencing and
bounded PostgreSQL probes pass.

## Opt-in PostgreSQL regression artifact

`tests/backup-company/public-pg.integration.ts` retains all three executed probe
bodies/assertions from the independent verifier artifact, whose original SHA-256
is `6a079354829f50580b0fc42042d6c8cc3045456adfaa1e414b6e82d9db158eff`.
The session-bound fixture identity/storage prelude is made portable; erased
non-null/receiver/callback annotations also make the copied artifact pass the
strict checker. All three original test bodies transpile identically, preserving
their runtime operations and assertions. The explicit `.ts` maintenance facade
import is intentional. The default isolated
runner's `**/*.test.ts` glob does **not** discover this `.integration.ts` file.

Provisioning is a separate, operator-owned step. Supply an already-running,
synthetic PostgreSQL **16** instance with the installed application schema and an
absolute JSON manifest located directly in its owned root:

```json
{
  "root": "/absolute/owned/synthetic-pg",
  "port": 55432,
  "databaseUrl": "postgresql://postgres@127.0.0.1:55432/accountexpress_test",
  "synthetic": true
}
```

The example is a descriptor shape, not a default target or provisioning command.
Its root must be disjoint from both the program directory and current working
directory, and contain the actual `pgdata` directory. Root/pgdata links and a
linked manifest are rejected. Additional provisioning metadata such as `bin` is
not executed by the runner. Use only an explicitly authorized disposable fixture.

```sh
COMPANY_RECOVERY_FIXTURE=/absolute/owned/synthetic-pg/fixture.json node node_modules/vitest/vitest.mjs run --config vitest.company-backup-pg.config.mts --configLoader native
```

Missing/malformed/non-synthetic descriptors, relative paths and unsafe URLs fail
**before db import or seeding**. The URL must have the exact password-free local
form above, with an explicit port equal to `manifest.port`; remote hosts, other
databases, passwords, queries, socket options and fragments are rejected without
connecting. No ambient database URL or `.env` is used. The opt-in config explicitly
sets `NODE_ENV=test`, uses no setup/globalSetup, selects only this integration
file and runs one worker.

The first SQL verifies `SHOW data_directory` against real `<root>/pgdata`, then
checks database name, server host/port and PostgreSQL 16 **before any DML**. Each
run uses fresh UUID-prefixed rows and a fresh `<root>/public-pg-<UUID>` data folder
outside the program tree for backup/maintenance/cache/evidence state. It never
resets schema, provisions/stops a server or touches customer storage. Synthetic
rows and `pg-evidence.json` are retained for the fixture owner's inspection and
cleanup; later invocations must not overlap on the same database.

The three probes cover:

1. Public export/preview/restore, all 13 monetary columns, both representations
   of all three nullable JSON fields, nested null, draft accounting links,
   safety provenance/receipt, immutable backup bytes and unchanged foreign
   company/shared-user/security/session/rate/global fingerprints.
2. Genuine Prisma lazy/array/interactive/fluent operations, requested isolation,
   raw Decimal versus ordinary Number results, and marked admission/extension
   denials plus live owned recovery authority.
3. Future/truncated/missing-provenance/corrupt/wrong-company inputs leaving DB
   fingerprints and backup bytes unchanged.

Signed posted-journal recovery, adversarial concurrency, browser flows, external
assets, persistent reconciliation, crash/power-loss and complete option C remain
outside this observed proof. Passing this artifact is not permission to use an
ambient database or claim full recovery acceptance.

## Ownership credential, certified historical restore and restore-as-new-company (S1–S6)

A backup file is a complete company, so a file alone must never be enough to
install it somewhere else. Three implemented guarantees close that hole, and one
of them changes the HTTP surface.

### HTTP contract

| Route | Request | Contract |
| --- | --- | --- |
| `POST /api/backup?companyId=<id>` | `{ companyId, password }` | Sudo-style creation: the creating `company_admin`/`super_admin` re-enters their own password. `400 BACKUP_PASSWORD_REQUIRED` (missing) or `400 INVALID_BACKUP_PASSWORD` (wrong) publish nothing — no file, no catalog entry, no `BACKUP_CREATED` audit row. |
| `POST /api/backup/restore?companyId=<id>` | JSON `{ data (base64), ownerPassword, targetCompanyId? }` or multipart `companyId`, `file`, `ownerPassword`, `targetCompanyId?` | Restores into the caller's company by default. The caller needs `company_admin` on that company. |
| `POST /api/backup/restore/preview?companyId=<id>` | `{ data }` | Read-only preview of the **caller's** company. It is not an import preview: a cross-company archive is refused there with `RESTORE_IDENTITY`, while the restore route certifies the destination itself. |
| `POST /api/bootstrap/restore` | multipart `file` + `recoveryPassword` + `ownerPassword`, or JSON `{ data, recoveryPassword, ownerPassword }` | First install only. Admission is the empty database (`409 DB_NOT_EMPTY` otherwise); `recoveryPassword` (min 8) becomes the restored owner's password. |

`targetCompanyId` is the S4 switch: omitted (or equal to the caller's company)
keeps the previous behaviour byte-for-byte; a DIFFERENT company is a platform
operation that requires a global `super_admin` (`403 FORBIDDEN` otherwise) and an
empty destination shell.

### Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `RESTORE_OWNERSHIP` | 400 | Missing/wrong credential, or an archive created before ownership protection (no verifier). The Spanish message states which. |
| `RESTORE_LEGACY_FORMAT` | 400 | Legacy plain-text archive: no `ACCOUNTEXPRESS-ENCRYPTED-BACKUP/1` keyed seal. A new backup must be produced by the current system. |
| `RESTORE_CHAIN` | 400 | The archive history cannot be certified here (broken/forked segment, wrong key, uncertifiable installation-wide audit order) and is never re-signed. |
| `RESTORE_SHELL` | 400 | `targetCompanyId` named a company that already holds history; restore-as-new-company needs an empty shell. |
| `RESTORE_IDENTITY` | 400 | Archive identity and destination disagree (or the destination company is missing). |
| `RESTORE_FAILED` | 400 | First-install route only: an UNKNOWN refusal (unparsable payload, missing section, unexpected fault). The message keeps its `No se pudo restaurar el sistema: …` wrapper. |

The first-install route now reports the four documented refusals
(`RESTORE_LEGACY_FORMAT`, `RESTORE_OWNERSHIP`, `RESTORE_CHAIN`, `RESTORE_SHELL`)
with their own codes and their original Spanish messages instead of flattening
them into `RESTORE_FAILED`. Only the reported code/message changed: what is
admitted, the 400 status and the "system stays empty" behaviour are unchanged.

`RESTORE_REBASE`, `RESTORE_IMPORT_JOURNAL` and `RESTORE_IMPORT_HISTORICAL` are
sealed **audit actions**, not error codes.

### Ownership proof on every path

`assertBackupOwnership` runs before any mutation: before the bootstrap shell
rows, before destination validation, before the maintenance gate, before the
safety snapshot and before any delete or publication. The verifier travels in
`manifest.ownership` (scrypt, per-backup salt, parameters stored with the file —
see [the format document](company-backup-format.md#ownership-credential-manifestownership)),
so a stolen file is inert without the creating super-admin's password and a wrong
password mutates nothing. Refusal messages never echo the attempt or archive
contents.

### Legacy plain-text archives

An archive without the current keyed seal (the old plain JSON plus unkeyed SHA-256
digest) is refused with `RESTORE_LEGACY_FORMAT` **after** the ownership gate and
before the maintenance marker, the safety snapshot or any row. Catalog, download
and preview keep working: only restore refuses it. `BACKUP_FORMAT_UNSUPPORTED`
remains the answer for `1.x` versions, which are not company snapshots at all.

### Historical re-anchor (`RESTORE_REBASE`)

The audit chain is installation-wide, so an archive restored on a fresh machine
(or after the signing secret changed) can carry a segment whose first row points
at a predecessor that went away with the old installation. When the destination
is **provably empty** and the segment is a single linear chain whose own HMACs
certify, the segment is re-anchored: one sealed `RESTORE_REBASE` audit root
documents `{ backupId, originalPredecessorHash, rebasedAt }` and the segment is
re-linked under the current secret. Nothing is dropped and no row changes
substance. On a non-empty destination the historical `RESTORE_CHAIN` refusal
stands unchanged.

### Restore as a new company (`RESTORE_IMPORT_JOURNAL`)

`targetCompanyId` pointing at a different company creates the archive's contents
as a NEW company without touching any existing one:

- the destination company keeps **its own id** (the archive id is never written);
- journal entries are re-sealed under the destination identity (company id is
  part of the entry HMAC) and one sealed `RESTORE_IMPORT_JOURNAL` row documents
  `{ backupId, sourceCompanyId, targetCompanyId, importedAt, sourceRootHash,
  sourceTailHash, sourceMembers }`;
- audit rows are stored as **closed historical evidence**: one
  `RESTORE_IMPORT_HISTORICAL` row per source row with `hash`/`previousHash` NULL
  and the certified original preserved inside `details.record`, so the live
  installation-wide chain is never forked;
- the destination must pass the empty-shell predicate (no movements, no
  journal-chain tail, no own audit member) or the restore answers
  `RESTORE_SHELL`; every other tenant is left byte-identical.

### UI

For a global `super_admin`, the restore dialog of both backup screens
(`BackupPage`, `Settings → Backup`) offers the optional destination selector
("Restaurar como empresa nueva (solo superadministrador)") filled from the
existing `GET /api/admin/companies` endpoint, with the explicit hint that the
target must be empty. `targetCompanyId` is sent only when a company different
from the current one is chosen. Non-`super_admin` users see the unchanged dialog.

### Verification

```text
tests/api/backup-ownership.test.ts   ownership credential, both restore paths
tests/api/bootstrap-restore.test.ts  refusal codes surfaced by the first-install route
tests/api/restore-reanchor.test.ts   RESTORE_REBASE, RESTORE_CHAIN, RESTORE_LEGACY_FORMAT, RESTORE_SHELL
tests/api/backup-restore.test.ts     in-system restore contract
tests/backup-company/restore.test.ts core admission/refusal matrix
```

Browser/crash acceptance of a real restore, and recovery from an ambiguous commit
(`RESTORE_RECONCILIATION_REQUIRED`), remain open acceptance items — this section
documents implemented behaviour, not full disaster-recovery proof.
