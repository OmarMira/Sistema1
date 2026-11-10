# Portable owner-verified backup recovery

Tracks the portable recovery workflow in `odd/tasks/bootstrap-owner-recovery.md`: recover a company
from a backup on a **fresh, formatted or replaced machine**, from the first-run
page, without any paid service and without bypassing the existing restore
coordinator.

## What the user does

1. On the new machine the first-run page detects an empty installation.
2. They pick the recovery file, type the **owner password** (the original super
   administrator password of the source installation, *not* a new password), the
   **owner email** of the super administrator who created it and the **company
   name exactly as it was loaded in the backup**. All three are key-derivation
   inputs: the password alone cannot open the file.
3. The server opens the encrypted file, checks all three values and emails a
   **single-use code** to the owner address recorded at export time.
4. They type the code; the system restores, signs the owner in and opens the
   dashboard.

Export side: creating a backup requires the same owner password, because the
whole file is encrypted with it. Downloading a stored backup re-asks for it.

## Opening errors: check all bound inputs, not only the password

`RECOVERY_PASSWORD_MISMATCH` remains the opening-failure API code for compatibility;
its historical name is **not a diagnosis that only the password is wrong**. A
wrong owner email, wrong exact company name, wrong password, or altered ciphertext
can all prevent opening. The response deliberately does not identify a failing
secret. No email token is sent when opening fails.

The recovery form translates this code using
`bootstrap.recoveryCredentialMismatch` in the English and Spanish catalogs. Both
messages name the owner password, owner email, exact company name and the complete,
unmodified file, and explain that the failing input cannot be identified from the
opening failure. Other error codes and code-less errors keep their existing
fallback behavior.

This translation is **scoped to the recovery form**. The same legacy API code is
also used by the source-owner password check during backup creation, where the
existing password-only server explanation remains unchanged. The shared
`translateApiError` helper and global `errors` catalogs must not turn that export
failure into instructions about a file the user is not opening.

Recovery tests use synthetic files and identities, not a particular operator's
backup, email or company. An authorized real encrypted file is local input only:
never put it or its contents in fixtures, application constants, commits or
logs. Reading its version and envelope is not evidence of successful decryption
or restoration; do not collect real passwords through diagnostics or chat.

## Reusing a local account does not rewrite history

An authenticated source owner can match an existing local account by email while
having a different account ID. The source ID remains bound into the encrypted
file; account mapping happens after opening and authorization. The existing local
account keeps its ID, credentials and role.

A retained audit event may therefore still name the deleted source actor. Exact
reuse compares it both with the original authenticated source event and with the
identity-mapped version that a new import would store. A verbatim original match
keeps its actual stored digest and actor unchanged, with no projection. It still
must pass the existing local-signature or authenticated-archive certification.
Changed content is not accepted merely because the emails match; erased-reference
projection still requires its separate original-signature proof.

Portable readers and recovery safety snapshots treat audit actor/company values
as historical evidence, not live foreign keys. Other models and non-portable
replacement validation retain their existing rules. A new portable export after
recovery must reopen with that historical evidence intact, without recreating the
old actor.

**Authorization limit:** preserving a regular local `user` does not promote it
to `super_admin`. Portable export still requires an eligible, verified, active
super administrator; a regular account can receive `RECOVERY_OWNER_MISSING` when
trying to export. Changing that policy is separate from fixing recovery and must
not be implemented as automatic privilege escalation.

## File format v3 (theft confidentiality and key binding)

Two AEAD envelopes. The **expensive password KDF is bound to the owner email and
the company legal name**, which the caller must therefore supply independently
of the file; the stable source owner **account id is recovered from the sealed
`binding` entry** (no new username or memorized code) and bound into the final
data key.

```
outer header (cleartext, minimal, fully authenticated):
  { format: 'accountexpress-portable-recovery', version: 3,
    kdf:     { algorithm: 'scrypt', N: 32768, r: 8, p: 1, salt },   // pinned
    binding: { iv, tag, ciphertext },                              // sealed identity
    cipher:  { name: 'aes-256-gcm', salt, iv, tag },               // HKDF salt + data IV
    ciphertext }                                                   // entire payload

wrapKey = scrypt(DSS('…/v3/wrap-key', password,
                     ownerEmail, companyLegalName), salt)         salt = 32 random bytes/backup
binding = AES-256-GCM(wrapKey, ivB, AAD='…/v3/binding',
            JSON { ownerUserId, ownerEmail, companyLegalName })
dataKey = HKDF-SHA256(wrapKey, saltD,
            DSS('…/v3/data-key', ownerUserId, ownerEmail, companyLegalName))
ciphertext = AES-256-GCM(dataKey, ivD, JSON payload)
payload =
  { format, version,
    owner:     { ownerUserId, ownerEmail, emailVerifiedAt, legacyUser, verifiedAt },
    companyId, companyLegalName, createdAt,
    sourceSeal: { algorithm, authenticated, digest } | null,
    snapshot:  <the complete 2.1.0 company snapshot> }
```

**What the key depends on, and in which order**:

| stage | inputs | consequence |
|---|---|---|
| expensive KDF (scrypt) | exact password, owner email, company legal name, random salt | `open(file, password)` is impossible: a missing/wrong email or company name never produces the wrapping key |
| sealed binding | AES-256-GCM under the wrapping key | the owner account id (and the canonical identity) can only be read AFTER the password+email+company step succeeds |
| final data key (HKDF) | wrapping key, data salt, owner account id + email + company name | the recovered account id is bound into the key that seals the accounting payload |

So the password alone, the password plus a wrong email, or the password plus a
wrong company name all fail before any accounting data or owner id is revealed.
The account id is not a secret (L13) and the file carries it sealed, never in
cleartext.

### Canonical inputs and exact normalization

| input | supplied by | normalization (identical at creation and verification) |
|---|---|---|
| password | operator | **verbatim**: no trim, no Unicode normalization, no case folding |
| owner email | operator | Unicode NFC, trim, lowercase |
| company legal name | operator | Unicode NFC, trim, collapse whitespace runs, lowercase |
| owner account id | the file (sealed binding) | **verbatim** (opaque, ≤191 chars); verified only when the caller offers one |
| salt | generated | 32 random bytes per backup (`crypto.randomBytes`) |

Punctuation and diacritics are significant: only case, surrounding/extra
whitespace and Unicode composition are treated as the same value. A typed
company name or owner email that differs in *content* makes the file unopenable,
exactly like a wrong password — both are part of the key.

The derivation input is a domain-separated, length-prefixed encoding
(`portableKeyEncoding`): `"dss1:" <fieldCount> ":" { <labelBytes> ":" <label>
":" <valueBytes> ":" <value> }`. Byte counts (not character counts) and the
field count first make the serialization unambiguous: moving a character from
one field to another, embedding separators or truncating a trailing field always
changes a length prefix, so no two different inputs can derive the same key.

### Header tampering protection and what is authenticated

* `format`/`version` and the pinned KDF parameters (`scrypt`, N/r/p) are
  validated exactly; anything else is refused.
* `kdf.salt` and the supplied identity feed the wrapping key, so a modified
  identity, salt or parameter set changes the key and the AEAD tag check fails.
* Both `iv`/`tag`/`ciphertext` pairs are AEAD-protected.
* After the sealed binding is opened, the sealed email and company name must
equal the supplied ones and the payload identity (`owner.ownerUserId`,
  `owner.ownerEmail`, `companyLegalName`) must equal the bound identity, so a
  file can never claim one owner/company in its binding and carry another.
* Callers that resolved the owner themselves (the download route) also pass the
  account id, which is verified against the sealed one; a mismatch is refused
  with `RECOVERY_IDENTITY_MISMATCH` before any accounting data is returned.

### What is NOT claimed

* The owner email and company name are **knowledge factors, not secrets**, and
  they are **not extra authentication**: they are typed by the operator and also
  travel inside ciphertext. Anyone holding the file *and* the password *and* the
  owner email *and* the company name can open it and can re-seal it with any
  identity they choose. The binding is tamper evidence for this file, not proof
  of authorship. The owner-email token remains the application-level
  authorization step.
* The KDF protects the password at rest; a weak owner password stays weak.

### Version handling

Portable **v1** files (PBKDF2 over the password alone) and **v2** files (identity
bound only into the final data key, so the password alone could open them) are
refused with `RECOVERY_FORMAT_UNSUPPORTED` and an actionable message instead of
being opened with the weaker schedule. A new encrypted backup has to be exported
from the source installation. Refusal happens at the structural header check, so
no password attempt is charged and no challenge draft is created.

* Nothing from the snapshot is written in cleartext: **no** company name, owner
  email, account id, counts, accounts, transactions, journal or audit history.
  Only the sealed identity blob and the sealed payload exist.
* Authorization challenges are bound to `sha256(the exact uploaded bytes)`
  (`portableFileDigest`), never to a digest declared inside the file, so an
  attacker cannot substitute a self-declared digest.
* `payloadDigest = sha256(decrypted payload)` authenticates exactly what
  provenance archives. Bounded parameters: pinned KDF parameters, 32-byte salt,
  12-byte IV, 16-byte tag, canonical base64, ≤4 KiB sealed identity, ≤72 MiB
  ciphertext, ≤96 MiB file, password 8–256 characters checked **before** any key
  derivation runs.

The internal catalog/`publishBackup` snapshot is unchanged (sealed at rest,
retention and the same-installation restore flow keep working). The internal
snapshot is **not** a download: `/api/backup/[filename]` returns the encrypted
portable file and requires the owner password, and the former `?internal=1`
plaintext read is refused with `INTERNAL_SNAPSHOT_DISABLED`. In-app restore and
preview resolve the stored snapshot server-side from a validated filename, so no
plaintext accounting data travels to the browser.

## Authorization

Two stages on `POST /api/bootstrap/restore` (anonymous: the installation is
empty by definition). Body: multipart `file` + `password` + `ownerEmail` +
`companyName` [ + `token` ], or JSON
`{ data | text, password, ownerEmail, companyName, token? }`. A missing or
malformed `ownerEmail` answers `400 RECOVERY_EMAIL_REQUIRED` before the workflow
runs.

Without `token` — authorization:

1. structural header read, then charge the bounded password-attempt budget for
   the **canonical wrapping-key subject** of the file — `portableThrottleDigest`
   in `src/lib/backup-portable.ts`, i.e. the format identity, the pinned KDF
   parameters and `kdf.salt`: exactly the values that feed the wrapping key
   (5 attempts / 10 min, `IdentityRateLimit`). Reformatting the container, or
   mutating bytes that never reach the wrapping key (`binding`, `cipher`,
   `ciphertext`), cannot buy a fresh set of password guesses; a genuinely
   different backup carries its own random `kdf.salt` and therefore its own
   budget. The authorization token stays bound to the **exact uploaded bytes**
   (`portableFileDigest`), so a variant file is still a different file;
2. run the identity-bound password KDF with the exact password, the owner email
   and the company name, open the sealed identity and then the identity-bound
   payload (wrong password, wrong email, wrong company, a modified header and a
   modified ciphertext share one sanitized failure); enforce the password length
   bounds before the KDF and refuse older portable versions structurally;
3. compare the typed company name with the authenticated payload
   (whitespace/NFC/case normalized, content must match);
4. parse the snapshot in portable mode — it requires the digest of the bytes the
   caller authenticated, so it is never a blanket "skip the seal" switch;
5. resolve the owner from the **sealed source-owner credential inside the
   authenticated snapshot itself** (`validatePortableRecoveryCredential`): the
   backup carries the source owner's identity proof, so no local account lookup
   happens here — a brand-new machine has no owner account yet, and requiring
   one made zero-installation recovery impossible (T15);
6. require a genuinely fresh installation and hold the cross-request recovery
   lease (see below);
7. issue a challenge (token stored only as SHA-256), deliver it, and only then
   report `{ stage: 'challenge_sent', expiresAt }`. No mail channel, a missing
   configuration or a provider failure answers `503 RECOVERY_MAIL_UNAVAILABLE`
   and consumes the draft. If a concurrent request rotated the draft while the
   message was in flight, the answer is `409 RECOVERY_CHALLENGE_ROTATED` instead
   of a stale "delivered".

With `token` — completion: every check is repeated, then the token is consumed
atomically (single-use CAS) **before** the restore starts. A consumed token is
never re-armed: a refused, aborted or uncertain restore requires a new challenge.
Wrong/expired/reused tokens and tokens issued for a different file are distinct
refusals.

Every refusal above is presented in the operator's language. Both catalogs
(`src/i18n/locales/{en,es}.ts`) carry the recovery codes themselves, each naming
the action that unblocks it: `RECOVERY_TOKEN_EXPIRED`, `RECOVERY_TOKEN_USED`,
`RECOVERY_TOO_MANY_ATTEMPTS`, `RECOVERY_MAIL_UNAVAILABLE`,
`RECOVERY_FILE_UNSUPPORTED`, `RECOVERY_FORMAT_UNSUPPORTED`,
`RECOVERY_CHALLENGE_ROTATED`, `RECOVERY_IDENTITY_REQUIRED`,
`RECOVERY_COMPANY_MISMATCH`, `RECOVERY_OWNER_UNAVAILABLE`, `RECOVERY_IN_PROGRESS`
and `RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED`. `RECOVERY_PASSWORD_MISMATCH` stays
out of that global catalog on purpose: the export path answers a genuinely
password-only mismatch with the same code, so its multi-input wording lives in
the recovery form (see above).

## Export owner proof

`resolvePortableSourceOwner` never accepts a client-supplied email/identity and
never falls back to "whoever is acting" or "whoever is oldest in the platform":

* active global `super_admin`;
* explicit membership in the company being exported (company authorization);
* verified identity (`emailVerifiedAt` or the app's legacy grandfathered flag),
  because the recovery token is sent there;
* the unambiguous earliest such account; no owner, an unverifiable owner or two
  equally-old owners fail closed (`RECOVERY_OWNER_MISSING` /
  `RECOVERY_OWNER_AMBIGUOUS`).

The password is verified with the canonical `verifyPassword` helper before the
file is written; plaintext passwords and password hashes are never exported,
echoed or logged. The owner stamp (`owner`) lives inside the encrypted payload;
the owner email and the company legal name are inputs of the wrapping key, and
the account id is bound into the final data key. The download path re-opens the
container with the identity the server itself resolved (account id + email +
company name), so a stored snapshot can never be re-sealed under another owner
or company.

## Download authorization (restored `company_admin` gate)

`GET` and `POST /api/backup/[filename]` require `company_admin` for the caller's
company. The gate runs immediately after the request context and **before**
filename validation results, password handling, any storage read and any attempt
budget: a `viewer`/`employee` caller gets `403 FORBIDDEN` and no backup work is
done or measured on its behalf. The `?internal=1` plaintext read stays closed for
everyone (`INTERNAL_SNAPSHOT_DISABLED`), and a company admin without a password
still gets `400 RECOVERY_PASSWORD_REQUIRED`.

## Restore semantics

The replacement is the existing `restoreCompanyBackupCoordinated` (serializable
replacement, per-company advisory lock, maintenance gate, safety snapshot,
recovery journal, commit receipt, file reconciliation) called with
`{ recovery: 'portable', authenticatedDigest }`.

* The local seal cannot be verified (different `SESSION_SECRET`); the AEAD
  container certifies the bytes instead. The declared source seal is **recorded
  as provenance**, never claimed as locally verified.
* Journal/audit **topology** (unique root, no fork, no orphan, unique tail,
  head↔tail) is still certified from the stored links. Only the HMAC recompute
  step is deferred — to the archived evidence, never to a timestamp rule.
* A single-slot lease (`BootstrapRecoveryLock`, TTL 10 min, holder-scoped
  release) serializes the whole workflow, and the shell-creation transaction
  takes `pg_advisory_xact_lock('portable-bootstrap-recovery')` and re-counts
  companies/audit rows inside it. Two different files can therefore never both
  prepare or restore. The lease is released on success and on pre-mutation
  refusal, and deliberately kept (until TTL) when the commit outcome is
  uncertain.
* Destination preparation reconciles **every account the snapshot carries**, not
  only the owner, inside the same locked transaction of
  `createPortableDestinationRestore` (`src/lib/backup-recovery-provenance.ts`),
  and the created-row flags come from a **committed** transaction:
  * same id **and** same email locally → that account already *is* this person
    and stays byte-identical: never rewritten, never promoted, never re-hashed;
  * same email under a different id → the documented S4 reuse through the
    identity map, without touching the local credentials, role or verification;
  * anything else → the account is **recreated** from the authenticated snapshot
    with the source id and email, a random 24-byte password hash nobody knows,
    `platformRole` from `normalizeRestoredUserRole` (so a backup alone never
    grants `super_admin`) and `emailVerifiedAt: null` — the file is no local
    proof that the address was verified. Its tenant role comes from the restored
    membership row, like any other restored account;
  * a source id already held by a **different** person while nobody holds the
    source email → `409 RECOVERY_IDENTITY_CONFLICT` and the whole preparation
    rolls back.

  Portable readers then admit those recreated accounts because they compare
  emails in the application's canonical form (trimmed, lower-cased); the
  non-portable path keeps its byte-exact comparison and its own stricter
  contract. On refusal cleanup deletes only the rows this attempt created, and
  never a company that already received business data. A rolled-back preparation
  runs no cleanup.
* **Operator note:** a recreated non-owner account has **no usable credential**.
  The backup never carried one, so the owner must re-secure each of those
  accounts (set a password, confirm the address) after the recovery.
* The recovery's own **safety snapshot** is read with the portable
  historical-evidence semantics and against its own in-process SHA-256
  (`recovery: 'portable'` plus `authenticatedDigest`, in
  `src/lib/backup-restore.ts`), not with the strict local-key reader. That copy
  legitimately carries rows sealed by the source installation or by an earlier
  destination key, which this key can never recompute, so a **second recovery on
  the same machine** works instead of failing with `RESTORE_CHAIN`. The bytes are
  produced inside the transaction and never travel through I/O, so nothing new is
  trusted. A *local* (non-portable) replacement of that same copy keeps the
  strict contract unchanged.
* After the commit the installation writes `BootstrapRecoveryProvenance`
  (file digest, payload digest, source-seal shape, identity map, per-row
  evidence digests, history digest, trust boundary) and verifies that every
  archived row still matches its evidence and that its own commit receipt
  survives. A missing/tampered proof re-closes maintenance and answers
  `reconciliation_required` instead of success.

### Same person already registered locally (S4)

Recovery data can legitimately repeat a person who already owns a local account
with the **same email and a different id**. For the **owner** that account is
reused only after it is proven with the same supplied password:

* proven → the explicit identity map (`sourceOwnerId → localId`) is recorded in
  provenance, live references (membership, reconciliation periods, rule-apply
  rows) follow it, archived audit rows keep their stored hash/previousHash but
  follow the same documented map, and the local password/role/verification are
  **never** overwritten;
* not proven → `409 RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED` and nothing is
  created, changed or deleted. The refusal happens *after* the file was opened
  and the email token was consumed, so signing in to the local account does not
  unblock it by itself: recovery never reads a local session. What unblocks the
  case is that **both passwords are the same** — sign in to the local account,
  change its password to the one that opens the backup and start the recovery
  again. The message names that cause and that remedy only; it identifies no
  sealed input, so no oracle is added. Same-identifier/different-email is a hard
  conflict. Nothing is ever deleted because cleanup only removes rows this
  attempt created.
* Every other source account follows the same-email reuse described under
  *Restore semantics*: mapped to the local account, never re-hashed, never
  re-roled.

## Verification of recovered history (S6)

`verifyJournalChain` / `verifyAuditChain` accept the archived evidence instead of
recomputing source HMACs: each archived row must match the digest of its exact
canonical content (id, references, stored hash, previousHash, timestamp), the
archive record must match its own `historyDigest`, a missing archived row fails
(`ARCHIVE_MEMBER_MISSING`), a rewritten one fails (`ARCHIVE_HASH_MISMATCH`), and
rows written locally after recovery still verify with the local key. A missing
provenance table or an unusable record falls back to the strict local contract —
never to a silent exemption. An archived row the authenticated payload never
carried at all is marked `outsidePayload` and certified by its presence plus the
digest of the bytes this installation stores — the recovery cannot touch it, so no
source event is re-proved and any later drift of those bytes still fails — exactly
as a row archived without a seal (`sealLess`) is certified by its stored bytes.

**One mutable field is tolerated: the journal workflow status.** `status` is
local workflow state, so voiding a restored entry, a rollback or a
reclassification rewrites it long after the row was archived. The archived digest
recorded the status the row had when it arrived, and that value is not stored
separately, so the comparison (`journalArchiveMatches` in
`src/lib/journal-hash.ts`) recomputes it for the row's current status and for
every status the schema allows (`draft`, `posted`, `void`, `pending_review`) and
accepts a match on any of them. The digest frame itself is unchanged, so every
stored or archived digest written by earlier code still matches byte for byte
(no migration, no re-seal). Every other field — content, date, reference, stored
hash, stored link, hash version, lines, tenant — is still inside the frame, so
changing any of them still fails closed with `ARCHIVE_HASH_MISMATCH`.

## Explicit limitations

* **Application-level authorization, not cryptographic two-factor protection.**
  Anyone holding the file *and* the owner password *and* the owner email *and*
  the company name can open it, and can re-seal it under any identity. The email
  code is a second authorization step performed by the running installation.
* **The password alone cannot open a portable file.** The owner email and the
  company name are inputs of the expensive password KDF; omitting them answers
  `RECOVERY_IDENTITY_REQUIRED`, and a wrong one answers the same sanitized
  failure as a wrong password.
* **Identity binding is tamper evidence, not authorship.** Altering the owner
  account id, owner email, company name or salt in a file changes the key and
  makes it unopenable; it does not prove who produced the file.
* **A mistyped company name or owner email is indistinguishable from a wrong
  password** because both participate in the key derivation (case/whitespace
  variants are normalized and accepted).
* **v1 and v2 portable files cannot be reopened.** v1 used the password-only
  PBKDF2 schedule and v2 bound the identity only into the final key; both are
  refused with `RECOVERY_FORMAT_UNSUPPORTED`.
* **No independent offline recovery key** yet (deferred by the user, S8): losing
  the owner email blocks recovery.
* **Legacy backups cannot retroactively prove ownership.** Files without the
  portable container are refused by the bootstrap flow with a clear,
  actionable error; they remain restorable on the same installation through the
  authenticated path.
* **Mail is required**; an unconfigured SMTP adapter now fails instead of
  silently "delivering", so identity flows record `delivery_failed` rather than a
  false success.
* **Same person, different local password**: reuse requires the supplied password
  to also open the local account. Otherwise the documented
  `RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED` refusal applies, and the documented
  remedy is to make both passwords the same — signing in does not unblock the
  case. Recovery does not rewrite an existing account.
* **Recreated accounts arrive without a credential.** Source accounts other than
  the owner are recreated with a random unknown password hash and an unverified
  email; the owner must re-secure them after the recovery.
* **Provenance is an archive boundary, not authorship proof** against an attacker
  holding both the file and the password (and DB write access).
* Accountant multi-company import is out of scope (deferred to settings).

## Operator notes

* `prisma/migrations/20261109000000_portable_backup_recovery/migration.sql` adds
  `BootstrapRecoveryChallenge`, `BootstrapRecoveryProvenance` and
  `BootstrapRecoveryLock`. The recovery path uses parameterized raw SQL with
  constant identifiers, so it does not require client regeneration; run the
  migration (and `prisma generate` for the declared models) in the pipeline.
  Nothing here was executed against a real database by this change.

### Migrations self-apply at startup (T14, S2/S9)

* The server runs pending Prisma migrations itself on every Node.js boot
  (`src/lib/startup-migrations.ts`, hooked from `src/instrumentation.ts` right
  after `validateEnv()` and before `optimizeDatabase()`), so an installed system
  upgrades its schema by itself.
* **The operator needs no manual step** — no `prisma migrate dev`, no
  `prisma db push`, no per-machine command. Customers never run migrations by
  hand and the developer never does it per installation.
* It only ever runs `prisma migrate deploy`, which applies pending migrations
  recorded in `_prisma_migrations`. It never resets, drops, truncates or
  force-pushes: existing data, including tables that are not part of the
  migration set, survives untouched.
* Concurrent boots serialize through a lock file in `RUNTIME_DIR`; the boot that
  loses the race waits and then skips once the winner recorded success. A run
  happens at most once per process.
* Failure behaviour: one retry, then a loud structured error with code
  `MIGRATIONS_APPLY_FAILED` and boot continues — the error stays visible in the
  logs, and read/restore paths that need missing tables still fail closed. If a
  packaged runtime has no Prisma CLI in `node_modules`, the boot logs
  `MIGRATIONS_SKIPPED_CLI_MISSING` and continues (fresh installs get their schema
  from the installer's `db:push`).
* No `.env` value, connection string or credential is read, printed or logged by
  this module; captured CLI output is sanitized before logging.

Verification for this behaviour (disposable database only):

```
DATABASE_URL=postgresql://...:...@127.0.0.1:<port>/accountexpress_bootstraptest \
  node node_modules/vitest/vitest.mjs run --config tests/startup-migrations/vitest.config.mts
```

## T15 — recovery on a brand-new machine, and retained audit history

Two real defects blocked the flow that this document describes. Both are fixed
here and covered by a disposable-PostgreSQL contract suite.

### 1. The source owner is proven by the backup, not by a local account

The workflow used to require a verified, active local `super_admin` **before**
issuing the recovery token. A newly installed or formatted machine has no account
at all, so every legitimate recovery ended in `RECOVERY_OWNER_UNAVAILABLE` (403)
before any mail was sent.

Owner authority now comes from the file itself:

* the identity-bound KDF + AEAD already prove the owner password, the owner email
  and the company legal name (the password alone cannot open the container);
* the sealed payload carries a **source-owner credential** (`ownerUserId`,
  normalized `ownerEmail`, `emailVerifiedAt`, `legacyUser`, `verifiedAt`), which
  `validatePortableRecoveryCredential` validates: it must describe exactly the
  identity the data key was bound to, and the source owner must have had a
  verified email (or the app's documented grandfathered legacy status), because
  the token is mailed to that address;
* when the authenticated snapshot carries the owner's own user row it must agree
  (same email, `role` still `super_admin`); a disagreement is refused instead of
  resolved in favour of either copy.

The mandatory token still goes only to the owner address sealed in the backup, so
the live proof that the address still belongs to the owner is unchanged. A
same-email destination **owner** account is still reused only after its own
password proves it (`RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED` otherwise); it is
never promoted, rewritten or deleted. Other source accounts are reused by email
or recreated without a usable credential (see *Restore semantics*). No new
username or remembered code was introduced.

### 2. Zero companies with retained audit history is a recoverable installation

`AuditLog` deliberately outlives its company (S19(c)), so a deleted company leaves
rows behind. That state used to be refused as "not empty" in both stages and
inside the destination preparation.

* The emptiness gate is now **companies only** (`companies > 0` →
  `DB_NOT_EMPTY`). An installation that already has companies is still refused.
* Retained destination audit rows are **never deleted and never re-signed** — not
  even the rows that still carry the restored company id. `replaceRows` skips the
  audit delete pass in portable mode, so history is never duplicated.
* **Same-installation overlap is reused, not duplicated.** Restoring into the
  installation that produced the backup (its company was deleted, its audit rows
  outlived it) means the destination already holds the very events the
  authenticated snapshot carries. `planAuditOverlap` (`src/lib/journal-hash.ts`)
  admits an id as already retained **only** when the stored row equals the
  authenticated snapshot row in every canonical field — content, stored `hash`,
  stored `previousHash` and timestamp, digested through the single shared
  `auditHistoryDigestOf` normalization (with the proven identity map applied to
  the incoming expectation). Those rows are then *reused*: the writer skips the
  insert for exactly those ids (`validateRestoreDestination` returns `auditReuse`)
  and the archive evidence is the digest of the stored row. Anything else stays
  `RESTORE_ID_CONFLICT`; nothing is de-duplicated by primary-key error, matched by
  id alone, renamed or rewritten.
* They must still be **certified**: each preserved row either verifies under this
  installation's key (`computeAuditHash`) or matches the authenticated recovery
  archive written by an earlier portable recovery
  (`BootstrapRecoveryProvenance`). Anything else fails closed with
  `RESTORE_CHAIN`; the guard was tightened into an evidence requirement, not
  removed.
* **Byte-identity is proven, not assumed.** The preparation transaction (which
  also proves there are no companies) records the exact digest of every existing
  audit row, and after the coordinated replacement the same rows must still be
  present with the same digest. A deletion or rewrite by any later path is
  reported as `RECOVERY_DESTINATION_AUDIT_LOST` and the installation stays fenced
  for reconciliation.
* The recovered SOURCE history keeps its source HMAC values and is certified by
  the archive (`RECOVERY_TRUST_BOUNDARY`), exactly as before.
* **Legacy attribution drift is certified, not repaired.** `AuditLog_userId_fkey`
  used to be `ON DELETE SET NULL`, so deleting an account erased `userId` on its
  surviving audit rows while the stored HMAC kept covering the ORIGINAL payload.
  Those rows are handled by the signature-proven attribution check described in
  T19 below (and, going forward, the reference can no longer be rewritten at all).
  Nothing is ever re-signed, relabelled, deleted or rewritten.

### 3. Audit-chain verification with a recovery boundary

`verifyAuditChain` (and `partitionAuditLineages` in `src/lib/journal-hash.ts`)
accept more than one lineage **only when a recovery archive exists on the
installation**. That is unavoidable and correct: recovered source rows carry the
source installation's stored hashes, so they cannot be linked onto the
destination chain without rewriting history.

What is *not* relaxed: every member must still be reachable from exactly one
`previousHash = null` root, no member may share a stored hash, no member may have
two successors, dangling links and cycles stay invalid, and **every member is
still verified** (archive digest or local HMAC). A purely local installation
keeps the original "exactly one linear chain" verdict byte for byte.

### Verification (disposable PostgreSQL only)

```
node tests/portable-recovery-postgres/run.mjs
```

The runner refuses anything but the local Docker socket, never pulls an image,
starts one throwaway `postgres:16-alpine` container (tmpfs data directory, no bind
mounts, random synthetic password, ephemeral `127.0.0.1` port), creates
`accountexpress_bootstraptest`, builds the fixture **from `prisma/migrations`**
(not `db push`), runs the suite with `envDir: false` in a scratch runtime root
outside the worktree, then removes exactly the container it created.

The suite drives the full `request → token → complete` flow against the real
PostgreSQL adapters and the real coordinated restore, with an in-memory mail
transport (the token is held in memory and never printed). It covers: recovery on
an installation with **no local account**, recovery with **retained audit rows**
(byte-identical, chains still verify, source rows not re-signed), a
**same-installation recovery whose retained rows overlap the snapshot by id**
(reused once, retained rows byte-identical, both chain verdicts valid), the
refusal of a same-id row that is not the authenticated event (nothing changed),
**recovery after the owner account was deleted** both under the legacy `SET NULL`
constraint and after the new migration, **the production POST handler invoked
directly** (challenge `200` → restore `200`, plus refusals that mutate nothing),
same-email reuse,
wrong password/email/company, tampered file, legacy version, absent mail channel,
invalid/expired/replayed token, non-empty unrelated company, the bounded attempt
budget and the single-use CAS. `tests/wave6/bootstrap-restore.test.ts` holds the
same contracts for the ambient-CI database.

Three defects were only observable on real PostgreSQL and are now fixed and
covered: `pg_advisory_xact_lock` returns `void` (Prisma cannot deserialize it — the
prepare transaction failed), `String(date)` drops milliseconds so an archived
digest of a stored row never matched (`auditHistoryRow` in
`src/lib/journal-hash.ts`), and the post-commit journal
proof read rows without their `lines` (the digest covers every line).

Not claimed: real email delivery (the transport is in-memory), a browser or network
round trip (the handler is invoked as a function, never over TCP), or that this
suite proves anything about the owner's own installation.

## T19 — recovery after account deletion (S17/S18)

Deleting the owner account used to rewrite signed audit evidence: `userId` was a
foreign key with `ON DELETE SET NULL`, and `computeAuditHash` includes `userId`, so
the surviving row kept a seal that no longer matched its own content
(`HASH_MISMATCH`). Two separate changes answer that, and they answer different
questions.

### 1. Future deletions cannot rewrite attribution

`prisma/migrations/20261109010000_immutable_audit_user_reference/migration.sql`
drops `AuditLog_userId_fkey` — the same precedent as `AuditLog_companyId_fkey` in
`20261105000000_hot_path_indexes`. The column, its values and its indexes are
unchanged; only the referential action is removed, so deleting an account leaves
`signed attribution` intact and the stored HMAC still verifies locally.

`ON DELETE NO ACTION` was rejected on purpose: it would block deleting an account
for as long as any audit row references it.

This is data-preserving: nothing is updated or re-signed, and no historical drift
is repaired by the migration.

The nulling came from PostgreSQL, not from application code: the admin user
deletion path (`src/app/api/admin/users/[id]/route.ts`) writes its own `delete_user`
audit row and then deletes the `User`; `deleteIdentityAccess`
(`src/lib/identity/cleanup.ts`) removes only `IdentityChallenge` /
`IdentityPendingRegistration`. Neither touches audit attribution, which is why
removing the referential action is sufficient and no application code has to
change.

Owner recreation is *not* a new prerequisite and needs no second implementation:
the preparation transaction of `createPortableDestinationRestore`
(`src/lib/backup-recovery-provenance.ts`) already creates the source-owner account
with the source identifier when neither the id nor the email exists locally,
before any validation runs. Recovery therefore does not depend on a pre-existing
local owner (S15), and no duplicate account provisioning was added.

### 2. Already-drifted rows: signature-proven attribution, never a wildcard

A row the old constraint already nulled is still the authenticated event. The
recovery proves that per row, all-or-nothing, through
`planAuditOverlapWithAttribution` and `retainedAttributionHolds`
(`src/lib/journal-hash.ts`):

1. the retained `userId` must be **strictly absent**;
2. every other canonical field must equal the authenticated source event exactly —
   `id`, company, action, entity, entityId, details, stored `hash`, stored
   `previousHash` and timestamp, compared through the injective, length-prefixed
   evidence frame (so no `|` inside content can shift a field boundary);
3. the stored seal must verify under **this installation's key** with the source
   attribution (`computeAuditHash` over the stored content and that one reference);
4. the authenticated SOURCE event's own seal must also verify with that same
   reference — so a rotated key, a foreign key or a forged value authorizes
   nothing.

When all four hold, the event is *reused as stored* (one copy, byte-identical) and
the recovery archive records the **actual stored digest** plus
`projectedUserId`: the archive never pretends the null content was signed. Every
later chain verification re-computes the original seal from that stored
attribution (`ARCHIVE_ATTRIBUTION_MISMATCH` otherwise), so a stored label on its
own certifies nothing.

What this proves, and what it does not: it proves the stored seal was computed over
this exact content with this exact source account reference. It does **not** prove
that a foreign-key action (rather than a person) erased the reference, and it does
not claim the absent value itself was ever signed.

Still refused, unchanged: a same-id row with a different non-null attribution, any
other canonical difference (details, action, `hash`, `previousHash`, timestamp,
company), a seal that does not verify, an unverifiable/rotated source seal, and a
nulled row with no authenticated source event at all. Refusals mutate nothing: the
retained rows stay byte-identical, no company/account is left behind, and no
provenance record is written.

The legacy contract is untouched for everything else: the digest-only
`planAuditOverlap` still exists, the local (non-portable) merge is exactly as
strict as before, and the installation-wide verifier still enforces one certified
lineage per root, no duplicate stored hash, no fork, no orphan/cycle, no missing
archived member, and a check of **every** member.

Implementation notes:

* the recovery transaction's own safety snapshot is validated with the attribution
  it just certified (`RestoreSourceOptions.auditAttribution`), so an installation
  holding a legacy-nulled row can still publish its pre-recovery safety copy. That
  copy is a faithful snapshot of the pre-recovery state, not a new certification:
  if it still contains legacy-nulled or source-key rows, a *local* restore of that
  copy keeps refusing exactly those rows, as before;
* `BootstrapRecoveryProvenance` gains one additive, optional evidence field
  (`projectedUserId`). Its self-consistency digest is now computed over a fixed
  field order, so a JSONB round-trip (PostgreSQL does not preserve object key
  order) can never make a genuine record look rewritten, and records written
  before this field existed keep their digest byte for byte.

### 3. Schema and API consistency

The migration removes the constraint **and** `prisma/schema.prisma` no longer
declares `AuditLog.user` / `User.auditLogs`, so the schema matches the installed
database instead of describing a referential action that no longer exists.

There were **two** consumers, not one (the earlier "admin endpoint only" claim was
wrong and is corrected here): `GET /api/admin/audit-logs` and the AI assistant's
`get_audit_logs` tool in `src/app/api/ai-assistant/route.ts`, which a freshly
generated Prisma client caught. Both used `include: { user: … }`. Each now resolves
the author with ONE batched
`db.user.findMany({ where: { id: { in: userIds } }, select: … })` for the whole page
— never one query per row — following the same precedent the admin endpoint already
used for `company` after `AuditLog_companyId_fkey` was dropped. The order, `take`,
tenant `where`, role/security checks and the payload shapes are untouched; the two
reads are kept inline because they select different fields and format different
payloads (a shared module would only wrap the `Map` construction).

The external contract is unchanged: `user` is still
`{ id, email, firstName, lastName }` while the account exists and `null` once it
was deleted (the stored `userId` stays on the row), `company` keeps its shape,
ordering (`createdAt desc`), page size (100), absent `where` and the
`super_admin` requirement are untouched.

Validation is offline and synthetic: the schema is copied to a temporary OS
directory and checked with the locally installed Prisma CLI there (no `.env`, no
repository root, no network, no generation, `node_modules` untouched).

### 4. Direct HTTP-handler proof for the recovery route

`POST /api/bootstrap/restore` is also exercised as the real exported handler:
the test imports the production module and invokes it with a synthetic `Request`
(no server, no port, no listening socket). Only the **outgoing mail transport** is
stubbed — the token is captured in memory. The database, challenge/lock stores,
source authorizer, `validateRestoreDestination`, the coordinated restore, the
archive and both chain verifiers are production code on the disposable database.

Asserted over HTTP semantics (`status` + JSON): `200` for the challenge stage and
`200` for the completion stage with `success/stage/operationId/user/companies` and
the session cookie, after the owner account was deleted — both for legacy-nulled
history (projection archived) and for the post-migration state (verbatim reuse).
A changed file is refused with `400 RECOVERY_PASSWORD_MISMATCH` at the challenge
stage and again at completion with the same token; nothing is created, certified
or rewritten, and the rejected attempt does **not** consume the token (the same
token then completes with the authorized file). No token, password or owner secret
appears in any response body.


## T20 — the company reference, and both references at once (S19)

The operator hit the SAME `RESTORE_ID_CONFLICT: AuditLog` again after migration 32.
The cause was a **deterministic code gap, not the fixture**: `AuditLog_companyId_fkey`
was also `ON DELETE SET NULL` until migration `20261105000000`, so a company deleted
on an older installation erased `companyId` on its surviving audit rows. Those rows
are **unowned** (`companyId IS NULL`), and `validateRestoreDestination` ran a generic
"foreign row with the same id" gate over every model BEFORE the portable audit
planner could certify anything. The row therefore failed on its erased scope, never
reaching the HMAC proof. (The current company-deletion API preserves `companyId`, so
this is legacy drift — no claim is made about which action erased a specific real
row.)

### 1. Routing: the evidence planner decides

For **portable** recovery only, `AuditLog` is skipped by that generic foreign-id /
uniqueness gate and reaches `planAuditOverlapWithAttribution`, which either certifies
the row or refuses it. Nothing else changed: every other model and the non-portable
path keep the exact previous gate and message (`RESTORE_ID_CONFLICT: AuditLog`, no
planner diagnosis attached). A retained row whose `companyId` points at a DIFFERENT
live company is still a refusal — a live reference is never projected.

### 2. One proof for company, user, or both

`retainedAttributionHolds` now takes the references that were erased
(`{ companyId?, userId? }`) and reconstructs **all of them in one HMAC** over the
stored content. Projecting only one of two erased references cannot reproduce the
original payload, so a partial or sequential acceptance is impossible by
construction. `attestRetainedAttribution` accepts a row only when:

1. the authenticated source event's own seal verifies under this installation's key
   with its own references (a rotated/foreign/forged source seal proves nothing);
2. a reference is either strictly absent in the stored row (erased) or exactly equal
   to the authenticated one;
3. every other canonical field — content, stored `hash`, stored `previousHash`,
   stored `createdAt` — is identical (injective, length-prefixed evidence frame);
4. the stored seal verifies over that reconstruction.

The archive records the ACTUAL stored digest plus `projectedCompanyId` and/or
`projectedUserId`. `verifyAuditChain` re-proves the archived attribution with the
local key on EVERY run (`ARCHIVE_ATTRIBUTION_MISMATCH` otherwise), so a stored label
is never an authority. The recovery transaction's safety snapshot is validated with
the same in-transaction proof.

### 3. Archive compatibility

`projectedCompanyId` is optional and additive: absent optional fields are never
materialized, and the record's self-digest is computed over a fixed field order, so
records written before this evidence existed keep exactly their original digest
(JSONB does not preserve object key order). Journal evidence is untouched.

### 4. Two installation-wide verdicts

After a successful recovery the retained row still carries the erased references
(rows are never rewritten), so the per-row archive proof is what certifies it —
for both `verifyAuditChain({})` and `verifyAuditChain({ companyId })`. The audit walk
reads every hashed row (the company filter only governs reporting), and the archive
record of the restored company contains the retained row's evidence, so a scoped
call cannot report archived history as missing. Cross-company isolation (redacted
reporting for another tenant's break) is unchanged, and nothing "skips missing
archives".

A reused retained row whose `companyId` was erased is not in the restored company's
snapshot; the post-commit evidence check therefore validates against the whole
installation (by unique id) instead of the restored company, which had reported
`RECOVERY_HISTORY_LOST` for a row that was present and byte-identical.

### 5. Safe conflict diagnostics

A genuine planner conflict now carries a fixed, value-free suffix, e.g.:

```
RESTORE_ID_CONFLICT: AuditLog [mismatch: content; fields: details]
RESTORE_ID_CONFLICT: AuditLog [mismatch: source-seal; fields: none]
```

Only the field vocabulary (`companyId,userId,action,entity,entityId,details,hash,
previousHash,createdAt`), the reason tokens (`content`, `original-seal`,
`source-seal`), the fixed marker `seal-candidates-unverified` and the word `none`
can appear. Never an id, email, reference,
content, hash, token, password or backup byte. An empty suffix is the marker that
the refusal came from the pre-planner gate instead. The same text travels through
the existing refusal message (`result.message`) — no new endpoint and no route
logging was added.

### Evidence

Unit: NULL-company and NULL-both reach the planner and are reused with the exact
projection; a foreign live company, changed content (details/hash/link/timestamp/
action), a forged stored seal and an unverifiable source seal are all refused, and
the message never contains the id, company, owner, email, password or hash; the
non-portable path keeps the bare message.

Disposable PostgreSQL, real `POST /api/bootstrap/restore` (invoked as a function,
in-memory mail only): the pre-migration company FK is re-installed on the throwaway
database, the real deletion runs, the FK is dropped again in `finally`, and the
recovery answers `200` for both the NULL-company and the NULL-both state. Asserted:
one copy per id, every retained row byte-identical, archive `{digest,
projectedCompanyId[, projectedUserId]}`, `verifyAuditChain({})` AND
`verifyAuditChain({ companyId })` valid, journal chain valid; a rotated key gives
`ARCHIVE_ATTRIBUTION_MISMATCH`, a rewritten byte gives `ARCHIVE_HASH_MISMATCH`, and
restoring the byte verifies again. A changed NULL-company row is refused with the
field-only diagnostic, the database/receipt/provenance/token state is unchanged, and
the single-use token is spent exactly as before.

Before the fix, the same PG cases failed with `RESTORE_ID_CONFLICT: AuditLog` from
the pre-planner gate (captured with the routing line temporarily disabled), which is
the reported failure reproduced end to end.


One more consumer of the removed relation surfaced only with a freshly generated
client (root `tsc` passes against the older client): the AI assistant's
`get_audit_logs` tool. It keeps its exact tool payload — `<first> <last> (<email>)`
for a known account, `Sistema` when there is no author, including a stored `userId`
whose account was deleted — with one batched author read, and the same `where`,
`take`, order and label fallback as before. Covered by
`tests/bootstrap-recovery/ai-assistant-audit-user-lookup.test.ts`, which drives the
real `POST /api/ai-assistant` handler with a fake provider transport (no network,
key or model) and asserts the payload the assistant receives.


## Verification

```
node node_modules/vitest/vitest.mjs run --config vitest.bootstrap-recovery.config.mts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The isolated runner (`envDir: false`, no ambient database, no `.env`) covers:
container confidentiality and identity opacity (no cleartext PII, identity or
transactions), the identity-bound password KDF (**the password alone is refused
with `RECOVERY_IDENTITY_REQUIRED`; a wrong password, a wrong owner email and a
wrong company name each fail; only the correct three open the file**), the
owner-account-id binding into the final data key (a re-labelled binding cannot
open another identity's payload), fresh salt/IVs per backup,
tamper/parameter/size/password bounds, v1/v2-version refusal at the container and
route level, exact-byte digest binding, owner proof
(missing/unverified/unauthorized/ambiguous), company-name confirmation
(case/whitespace variants accepted, content changes refused before any mail),
owner-email refusal at request and completion without consuming the token,
rotation, bounded attempts, missing/failing mail, token expiry/single-use/file
binding, success and uncertain restore outcomes, S4 reuse and its refusal,
cleanup only of proven committed rows, rollback without cleanup, history
tampering/deletion detection, provenance-aware chain verification, and the public
route contract (multipart hardening, 50 MB/base64 bounds, `RECOVERY_EMAIL_REQUIRED`,
status mapping, no token/password/owner-email leakage, session creation, encrypted
download path, the `INTERNAL_SNAPSHOT_DISABLED` refusal, and the restored
`company_admin` gate on `GET`/`POST` downloads — a non-admin caller gets 403 with
no password handling and no storage read).
