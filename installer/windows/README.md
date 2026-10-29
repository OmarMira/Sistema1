# AccountExpress single-PC Windows installer

The installer includes its own Node.js and PostgreSQL. Customers do **not** need Inno Setup, Node.js, npm, Docker or a separate PostgreSQL installation. Inno Setup is a developer build tool only. See [STATUS.md](STATUS.md) for observed verification; source code or a successful prerequisite check is not installed-product proof.

**Verified local artifact:** `installer/windows/dist/AccountExpress-Setup.exe`. Actual installation/start/restart/uninstall with data retention passed on this Windows host. Google activation and real inbox/first-account acceptance remain pending; an unsigned executable is not a trusted-signed or clean-VM release.

## Customer installation

1. Open the delivered `AccountExpress-Setup.exe` and select Spanish or English.
2. Choose an empty program directory, then a **separate empty data directory**. Existing files, accounting data, junctions, overlapping paths, unsafe paths, insufficient space and unwritable locations are rejected instead of overwritten.
3. Start AccountExpress using its Start-menu shortcut or `start.cmd` in the selected program folder. The owned runtime starts PostgreSQL and opens the application in the browser only after its bootstrap endpoint responds successfully.
4. Follow the company, fiscal period, administrator, review and email verification screens. No global opening balance is requested. The account/company are created by the existing verification transaction, not a local completion flag.
5. Use the Stop shortcut or `stop.cmd` before shutting down the runtime. While the foreground launcher is running, keep its console open.

Program files and durable data remain separate. This single-user installation does not create Windows services, install global runtimes, change machine-wide registry settings, or register itself in Windows Settings. Its Start-menu Uninstall shortcut (or `unins000.exe`) removes installed files **but retains the selected data directory**. The installer is unsigned; Windows may show an unknown-publisher warning. No trusted signing is claimed.

An existing installation/data directory requires an explicit upgrade/recovery procedure; this first-install package does not silently migrate, reset, merge or overwrite existing accounting data.

## Email activation is separate

The application/data stay local. Email verification and recovery use the owner's mail-only Google relay. Follow [the owner activation guide](../mail-relay/README.md), then place **only this installation's issued credential** at `<selected-data-directory>/relay.json`. Do not distribute the signing key, another customer's authorization, Gmail app password or development `.env` files.

Packaged mode explicitly selects the relay. Missing, invalid, expired or unavailable mail configuration causes a visible delivery failure; there is no fallback pretending that a code was sent. HTTP200 alone is not delivery success. Real inbox/code acceptance requires owner Google authorization and is not established by local tests.

## Build on Windows x64

Pinned runtime inputs live in project-only `.cache`: Node24.22.2 and PostgreSQL16.15 (EDB packaging revision1). Node is checked against the release's official `SHASUMS256.txt`; PostgreSQL is obtained over HTTPS from the official EDB distributor and its locally calculated SHA256 is recorded. A locally calculated digest is **not** described as a separately published vendor checksum.

```powershell
node installer/windows/build.cjs --status
node installer/windows/build.cjs --build
# Read installer/windows/.checks/latest-build.json for its actual payload path:
node installer/windows/build.cjs --compile "C:\absolute\owned-build\payload"
```

The build snapshots allowlisted source, immutable rules/defaults and public assets into a new owned `.checks/build-*` workspace. It does not load development `.env`, use the development database, or replace the active `.next`. Only a deliberately unreachable private loopback database URL and disposable build secrets are supplied during compilation. Runtime migrations are **not** replaced by build success.

The payload uses Next standalone output plus explicit production dependency closure (including Prisma CLI/Windows engine, PDF worker/canvas and image dependencies). Development caches, credential files, databases, backups and customer uploads are excluded. Runtimes/licenses are included locally. PostgreSQL staging keeps its `bin`, `lib`, `share` and required server/third-party notices; optional pgAdmin/Python, StackBuilder and development headers are not distributed. The build refuses missing production server/runtime files before invoking the installed compiler using an argument array, not an MSYS/cmd command string.

Compiler output: `.checks/output/AccountExpress-Setup.exe` and `.sha256`. Final distribution copies belong under `installer/windows/dist/` after acceptance, not before it. No push, release or publication is implied.

## Installed runtime interface

From the selected program directory, using its bundled executable:

```powershell
.\runtime\node\node.exe .\launcher.cjs --status
.\runtime\node\node.exe .\launcher.cjs --start --open
.\runtime\node\node.exe .\launcher.cjs --stop
.\runtime\node\node.exe .\launcher.cjs --restart --open
```

`--configure --data-dir <new-absolute-directory>` is normally called by the installer. `--app-dir` selects an owned payload for isolated acceptance. `--port` defaults to32180; `0` requests a free loopback port for proof. Unknown options fail with exit2. Status is read-only; runtime/configuration failures exit1. A running supervisor remains active until stopped and never kills unrelated processes on collision.

Configuration uses independent generated session, identity, database and control secrets. The data directory's Windows ACL is restricted to its owner and SYSTEM. PostgreSQL uses SCRAM authentication, an owned cluster, an ephemeral loopback port and the existing `prisma migrate deploy` chain; no `db push`, seed or forced registration/onboarding flags. Stop authenticates against that instance's private loopback control endpoint. Restart retains secrets, database and runtime files.

## Destination preflight

```powershell
node installer/windows/preflight.cjs --program-dir "C:\Example\Program" --data-dir "C:\Example\Data" --program-bytes 1073741824 --data-bytes 536870912
```

The sizes above are examples. The actual installer supplies measured payload/staging requirements and a512MiB initial data reserve. Preflight checks absolute local paths, reserved/system/UNC/device/traversal rejection, canonical aliases/junctions, existing contents, real free space and both file/directory write permissions. It creates/removes only its unique probe directory, not the selected destinations. JSON stdout and exit0 mean ready, exit1 means rejected, exit2 means invalid options. Checks are repeated before installation; preflight alone never authorizes overwrites.

## Checks

```powershell
node --test tests/installer/windows-package.test.cjs tests/installer/windows-runtime.test.cjs tests/installer/windows-preflight.test.cjs tests/installer/mail-relay.test.cjs tests/installer/migration-proof-ownership.test.cjs tests/installer/migration-slice-verifier.test.cjs tests/installer/route-export-surface.test.cjs
node node_modules/vitest/vitest.mjs run --config vitest.packaging.config.mts
node node_modules/vitest/vitest.mjs run --config vitest.installer.config.mts
node installer/windows/acceptance.cjs --installer "C:\absolute\AccountExpress-Setup.exe" --browser
```

Acceptance invokes the actual installer in new owned project paths, with no icons or registry registration, and checks new PostgreSQL migration/startup, HTTP/bootstrap/background assets, failed-mail behavior, malformed verification rejection, restart/config retention and uninstall/data retention. Browser proof checks the installed application at five approved desktop sizes in both languages/themes. Only its code-form geometry uses a mocked mail receipt; it sends no real email and is not inbox/role-provisioning proof. Evidence, logs and screenshots remain under the specific `.checks/installed-proof-*` directory.

The application's default Vitest setup is **not** an isolated installer test runner: do not use it against an ambient database. Existing `check-migrations.cjs --run` remains a separate opt-in Docker/tmpfs historical-migration proof, with cached image/pull-never, owned resources and no customer upgrade claim.

Installed JSON/backups use `<data>/config` and `<data>/backups`; logos use `<data>/uploads/logos` and the dynamic `/uploads/logos/<filename>` route. Without `ACCOUNTEXPRESS_DATA_DIR`, existing development paths and behavior remain unchanged. Installation does not import old developer company configuration or move prior logos/data automatically.
