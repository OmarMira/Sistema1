# Windows destination preflight

This module performs actual local filesystem checks; it is **not yet the Windows installer executable or folder-selection UI**. It never initializes PostgreSQL, writes a company/account, creates program/data destination folders, changes the registry, starts services, elevates privileges or deletes stored accounting data.

```powershell
node installer/windows/preflight.cjs `
  --program-dir "C:\Users\Example\AppData\Local\Programs\AccountExpress" `
  --data-dir "C:\Users\Example\AppData\Local\AccountExpress" `
  --program-bytes 1073741824 `
  --data-bytes 268435456
```

The numbers above are illustrative, not certified payload requirements. The packaging unit must supply actual expanded payload/staging requirements plus the initial data reserve. Missing, zero, negative, noninteger and unsafe-size estimates fail closed. Run `node installer/windows/preflight.cjs --help` for the command contract.

The program and durable data locations must be absolute local Windows paths, distinct and non-overlapping. UNC/device paths, drive roots, traversal components, Windows-device names, forbidden/trailing characters and the Windows system-directory tree are rejected. Filesystem symlinks/junctions in existing components are rejected rather than followed. Existing components are resolved through the real filesystem before comparing locations. Nonempty program directories and data directories are never reused; `.accountexpress-install.json` identifies an already installed program for a later explicit upgrade/recovery flow.

The check measures actual free bytes with Node's Windows filesystem API, combines requirements when both locations share a volume, and checks them separately otherwise. It proves write permission by creating and removing only a uniquely named probe directory/file in each nearest existing ancestor. Directory creation is tested as well as file creation: Windows ACLs can grant one without the other. It does not create the selected destination folders. A failed check does not trigger elevation or silently select another location. Cleanup removes only its own file and an empty owned probe directory, never arbitrary directory contents.

## Public interface

```js
const { preflight } = require('./preflight.cjs');
const result = preflight({ programDir, dataDir, requiredProgramBytes, requiredDataBytes });
```

The result is one JSON object. `ok:true, code:"ready"` includes canonical selected paths and decimal-string required/available byte totals. Rejections contain only `ok:false` and a machine-readable code for later bilingual UI translation: `invalid_path`, `overlapping_paths`, `not_directory`, `destination_not_empty`, `existing_data`, `already_installed`, `unsafe_link`, `insufficient_space`, `permission_denied`, `invalid_size`, `unsupported_platform` or `filesystem_unavailable`. The CLI emits one JSON line, no filesystem details on stderr; exits are 0=ready, 1=rejected, 2=invalid command options. CLI help is non-mutating.

Free space, paths and permissions can change after inspection. A ready result is **not permission to overwrite files** or proof of a completed installation. The later installer must recheck before creating its owned staging/destination paths, refuse changed/existing targets, and limit rollback to files it created. Existing data requires an explicit upgrade/recovery path, not automatic deletion. This unit does not establish those later operations.

## Isolated verification

```powershell
node --test --test-reporter=spec tests/installer/windows-preflight.test.cjs tests/installer/mail-relay.test.cjs
```

The preflight tests use Windows directories/junctions under their own temporary test folder, sentinel files for existing-data safety, and injected filesystem-service failures for insufficient-space/permission cases. They also assert exact rejection stdout, stderr and exit code through the public CLI. No user's installed application, database, Windows configuration, mail account or registry is touched.

## Isolated real migration replay

```powershell
node installer/windows/check-migrations.cjs --help
node installer/windows/check-migrations.cjs --run
```

This development proof requires an already cached `postgres:16-alpine` image on the explicit local Docker socket and an installed local Prisma schema engine. It never pulls an image or accepts an existing database URL, remote Docker context, bind mount or persistent database volume. It does not use the application's default Vitest setup or `db push`.

The command creates one new labelled, proven-owned container with tmpfs PostgreSQL storage, a random test password and an ephemeral loopback-only port. It stages only schema/migration files and a private package/config workspace; ambient application/database/mail environment values are not passed through. Actual `prisma migrate deploy` runs against a new empty database. The proof also constructs a separate empty historical-state simulation, applies the documented historical CHECK repair there, deploys the original migration chain, and then applies the additive prerequisite migration. Original applied names/checksums must remain byte-identical, and no default user or company may be seeded. This simulation is not acceptance proof for a customer's actual upgrade history.

`20261019000301_identity_transition_action_prerequisite` permits the audit action before the existing transition insert. It intentionally sorts before `20261019000400`; all pre-existing migration files and the later `00401` repair stay untouched. The new CHECK change is transactional. Appending a repair after the failing insert would not fix fresh replay.

The proof removes only its freshly created workspace and the container whose ID, owner/scope labels, running status, tmpfs storage and loopback ephemeral port still match. If ownership cannot be proven, deletion is refused and the owned resource name is reported for operator inspection. Exit 0 means this isolated proof passed; 1 means failure/unavailable proof; 2 means invalid command options. There is no automatic recovery, `migrate resolve`, production migration, host PostgreSQL installation or application startup. Native Windows PostgreSQL/runtime packaging and clean-machine acceptance remain separate checks.

## Optional installed-instance data root

The Windows launcher will supply `ACCOUNTEXPRESS_DATA_DIR` as the selected absolute data directory, separate from program binaries. With it configured, company runtime JSON lives under `<data>/config` and the existing backup directory/manifest live under `<data>/backups`. Immutable templates still come from the program's `rules/defaults`. Installed initialization never imports the development `rules/company-config.json`. Existing runtime JSON is retained on restart; no backup format, journal, balance, database, restore or onboarding-completion rule is changed by this path selection.

Without this optional variable (or with an empty value), the original development paths and legacy import behavior remain unchanged: `.data/company-config.json` and `db/backups`. Relative paths, filesystem roots, Windows device/UNC paths and program/data overlap are rejected at module load before initialization writes. Existing path components are canonicalized through the filesystem to catch aliases into the program tree. This resolver is not installation/overwrite authorization; destination preflight and ownership-limited installation remain required. Do not populate this variable in an existing installation without an explicit data-location migration plan; this unit does not move old records or backups automatically.

The filesystem-only checks load neither dotenv nor the application's global database/PDF test setup:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.installer.config.mts
```

These checks use new owned temporary fixture folders and mock the unrelated asynchronous AI configuration health check; no user database is contacted. Upload/logo durability, standalone output and the native Windows launcher are separate pending implementation slices. No installed application is claimed by this optional configuration alone.

### Installed company logos

With `ACCOUNTEXPRESS_DATA_DIR`, new logos live in `<data>/uploads/logos`, not inside program files. Existing `/uploads/logos/<filename>` URLs remain unchanged. A dynamic Node route reads installed images on each request, including files created after startup. Only generated timestamp/UUID PNG/JPEG/SVG names are accepted; MIME-derived extensions, exclusive new-file writes and canonical-directory checks avoid client filename escapes or redirected storage. Responses use image MIME types, `nosniff`, sandbox CSP and private revalidation. Missing files return404; unavailable/redirected storage returns a sanitized503. The unset-root development save/delete paths, extensions and validation messages remain unchanged; existing Next public-file handling still owns their delivery. No previous images are moved automatically.

These filesystem checks are not a sandbox against a malicious process with the same Windows account and write access to the storage namespace. The final launcher must run as the owning user, not a privileged shared service. The final package must exclude development `public/uploads`; full installed Next routing/relocation proof remains part of package acceptance.
