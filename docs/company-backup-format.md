# Company snapshot format 2.1.0

Company exports preserve exact monetary values and SQL-NULL/JSON-null provenance
without changing the application's public Number results. This slice contains
export, catalog, storage and the guarded raw transaction helper. It does **not**
enable company recovery routes or complete coordinated DB/files recovery.
Legacy/bootstrap restoration rejects company formats before restore side effects.

## Public export and history

| Function | Contract |
| --- | --- |
| `createBackup(companyId)` | Returns ID, unique filename, byte size, creation time, counts and base64 UTF-8 JSON only after file publication and catalog update succeed. |
| `listBackups(companyId)` | Validates files, filters embedded company identity and reconstructs missing/corrupt indexes in memory. Read-side operations never rewrite the index. |
| `getBackupFile(filename)` | Returns exact JSON text/UTF-8 size, or `null` for invalid/absent filenames. Callers still authorize access. |
| `deleteBackup(filename, companyId)` | Returns `invalid`, `not_found` or `deleted`; ownership comes from validated file metadata, not an index hint. |

A successful export does not prove browser delivery, authenticity, power-loss
durability or operational recovery. Business/profile data remains sensitive even
though shared credentials are excluded. No AEX conversion or access is performed.

## Snapshot inventory

Arrays retain IDs, timestamps, references and numeric record counts. Company
configuration is an object/null with a boolean presence count; `journalChainHead`
is an explicit nullable object, not an array.

| Category | Included state |
| --- | --- |
| Accounting | `company`, `glAccounts`, `bankAccounts`, `bankStatements`, `bankTransactions`, `bankRules`, `journalEntries`, `journalLines`, `fiscalPeriods`, `reconciliationPeriods`, `journalChainHead` |
| Access references | `companyMembers`, `companyModuleEntitlements`; public `users` profiles for member/reconciliation/application/audit actors, never password hashes or credentials |
| Company configuration | `entityContexts`, `detectionConfigs`, `csvLayoutProfiles`; only `companies[companyId]` from runtime `company-config.json` |
| Rule/audit anchors | `ruleApplyRecords`, `ruleExecutionAudits`, company-owned `auditLogs`; stored history is not re-signed |
| Knowledge | `companyKnowledge`, `knowledgeAudit`, company-owned `pendingApprovals` |
| Memory | `systemMemories`, `memoryItems`, `memoryVersions`, `relationships`, `contradictions`, `evolutionLinks`, `traceabilityLogs`, `confidenceLogs`; cross-company edges fail export |

Excluded: global `SystemConfig` (the legacy array/count stays empty), shared
`BankProfile`, other companies, global/null-company audits, shared-user security
state/sessions, rate limits, identity infrastructure, environment/connection/signing
keys and installation/runtime files. Catalog/cache/derived application state is
regenerable, but durable memory and knowledge history is included.

Logos, avatars and original statement attachment bytes are **not embedded**.
`BankStatement.fileName` is metadata, not a restorable file. This is not a complete
files-and-database disaster recovery archive.

## Money and JSON nulls

All 13 installed monetary columns are `Decimal(18,2)`. Exported values are canonical
strings with two fraction digits, including `9999999999999999.99`, `0.01`,
`-9999999999999999.99`, `-0.01` and `0.00`; no Number intermediate is used.
Noncanonical, numeric, nonfinite, out-of-range or excess-scale new-format money
fails validation without rounding.

`manifest.fidelity` is mandatory and checksum-covered:

```json
{
  "monetary": "decimal-18,2",
  "jsonNulls": [
    { "model": "BankRule", "key": { "id": "rule-id" }, "field": "conditions", "kind": "db-null" },
    { "model": "KnowledgeAudit", "key": { "id": "audit-id" }, "field": "beforeValue", "kind": "json-null" }
  ]
}
```

Exactly one reference must exist for each top-level null in a nullable Json
column, and none for other rows/fields. The installed nullable JSON columns are
`BankRule.conditions` and `KnowledgeAudit.beforeValue/afterValue`. Only `db-null`
and `json-null` are valid kinds. Row/key/field ownership, uniqueness and total
reference count are validated. Primary keys come from installed schema metadata,
not a blanket `id` assumption (`DetectionConfig` uses `companyId`).

Capture queries schema-owned, quoted model/column identifiers and **parameterized
row keys** in the same transaction as the rows. No archive-controlled identifier
becomes SQL. Missing/failed/incomplete metadata queries fail closed: plain Prisma
`null` alone cannot prove SQL NULL. Required JSON top-level null and ordinary
nested nulls mean JSON null; nested business JSON is not rewritten.

Catalog/read/delete still support `1.0.0`, `1.1.0` and `2.0.0`. Legacy 1.x has no
new checksum guarantee. Both company formats retain embedded UUID IDs after index
loss. The 2.1.0 version/metadata requirements cannot be waived by omitting fields.
A recovery reader must reject legacy 2.0 nulls without nullable-JSON provenance
and unsafe numeric money rather than invent lost state. Legacy/bootstrap restore
continues to refuse both company formats.

## Consistency and guarded transactions

`withCompanyBackupTransaction<T>(callback, options)` supplies a guarded
`Prisma.TransactionClient` from the private unextended base client. Its options
preserve `isolationLevel`, `maxWait` and `timeout`. `withRuntimeOperation` holds
normal admission or live owned recovery authority around the whole callback and
commit. No unguarded client is exported. Existing public `db` Number overrides,
lazy Prisma promises and ordinary transactions are unchanged.

Export uses one `RepeatableRead` transaction for all database reads, including
actors, chain head and SQL-null metadata. Runtime company config is read before
and after; malformed/unreadable config or an observed change fails publication.
A missing company config is explicit null. This does not detect change-and-revert
or establish an atomic distributed DB/files snapshot.

The manifest carries version, UUID, time, company identity, mandatory array counts
and an integrity digest of UTF-8 `JSON.stringify({manifest-without-integrity,data})`
in property order. Since the keyed-seal change (odd/tasks/wave5-remaining-findings.md
S6.2), NEW snapshots are sealed with HMAC-SHA256 (`algorithm: 'hmac-sha256'`,
`authenticated: true`) using a key derived from SESSION_SECRET via
PBKDF2+HKDF (`pbkdf2-sha256:100000+hkdf-sha256:accountexpress:crypto:v2:hmac`) —
forgery requires the secret. Legacy snapshots sealed with plain SHA-256
(`authenticated: false`) still verify through the read-legacy branch. Saved and
returned bytes are identical; size counts UTF-8 bytes, not JavaScript characters.

## Publication and failures

Final names are `<companyId>_<UUID>.json`; company IDs permit only ASCII letters,
digits, underscore and hyphen. Exclusive mode-0600 temporary writes are flushed,
closed, then hard-linked without overwrite. Catalog replacement uses its own
exclusive temporary file and atomic rename. No unsafe copy/overwrite fallback is
used; only invocation-owned temporary files are cleaned up.

### Bounded Windows index replacement

Only a Windows `EPERM` from **index replacement** retries: at most four atomic
rename attempts, with synchronous waits of **10, 25 and 50 ms** (85 ms total
requested waiting). The event loop is blocked during those rare waits; filesystem
calls and OS scheduling add their own latency, so 85 ms is not a wall-clock SLA.
The same already-flushed, closed temporary file and target are reused. Both paths
and their ancestors are revalidated for symlinks before every attempt. The old
index is never deleted or overwritten in place; its bytes remain intact until a
successful atomic rename.

Other errors (including `EIO`, `EACCES` and `EBUSY`), non-Windows failures and path
validation failures are immediate. Snapshot linking never retries, including
`EEXIST` collisions and link `EPERM`. Catalog reads still never repair/write the
index. Public storage functions remain synchronous; no command/test-run retry is
introduced. This policy also applies when deletion refreshes the catalog.

After the fourth `EPERM`, publication still rejects visibly, naming the complete
published snapshot. The wrapper retains the original error as `error.cause`,
including its `code`. Old index/backup bytes remain unchanged, the exclusively
owned temp is cleaned up, and file scans can discover the new complete snapshot.
There is no unbounded retry or promise of recovery from permanent permissions.

| Failure | Result |
| --- | --- |
| Snapshot/config/format validation | Rejected export, no publication |
| Write/flush/link/collision | Rejected export, previous history preserved |
| Published file, catalog update fails | Error names the complete published file; scan can rediscover it |
| Index missing/corrupt | In-memory reconstruction; no read-side write |
| Storage unavailable or corrupt backup | Visible error, never an empty-success catalog |

Reads/writes/deletes reject traversal, separators, symlinks/junctions and
non-regular backup files. Storage must remain trusted against hostile concurrent
local filesystem mutation; path checks are not a kernel sandbox. Directory
metadata fsync and filesystem-specific power-loss behavior remain unproven.
Hard termination may leave ignored dot-prefixed temporary files; no stale-file
replay or automatic cleanup is claimed. Earlier Windows `EPERM` index-renames
motivated the bounded policy above; persistent failures are not converted to
success or evidence of power-loss durability.

## Slice-local verification

```sh
node node_modules/vitest/vitest.mjs run --config vitest.company-backup.config.mts --configLoader native tests/backup-company/export.test.ts
```

These export tests use an owned scratch directory, mocked DB/auth/logger and
explicit SQL-null metadata fixtures. They include full-range canonical money and
both representations of all nullable JSON fields without importing the later
preview/restore core. They are deterministic evidence, not PostgreSQL proof.
See the committed [maintenance boundary](backup-maintenance.md) for writer fencing.
