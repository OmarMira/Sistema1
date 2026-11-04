# Private installed runtime

`launcher.cjs` controls one user's installed AccountExpress payload. It requires the assembled standalone application, bundled Node and PostgreSQL; these source scripts alone are not an installer. Configuration and runtime state live in a separate selected data directory.

## Commands

From the installed program directory:

```powershell
.\runtime\node\node.exe .\launcher.cjs --status
.\runtime\node\node.exe .\launcher.cjs --start --open
.\runtime\node\node.exe .\launcher.cjs --stop
.\runtime\node\node.exe .\launcher.cjs --restart --open
```

The installer calls `--configure --data-dir <new-absolute-folder>` once. Configuration rejects existing installation/data, replaces the destination's DACL with owner/SYSTEM-only access and writes independent secrets exclusively. It never imports development `.env` or resets an existing database. `--app-dir` selects an explicit payload for isolated testing; `--port 0` requests an ephemeral loopback application port. Invalid options exit2; configuration/start failures exit1. `--status` is read-only.

The supervisor initializes its own SCRAM PostgreSQL cluster only when new, deploys existing Prisma migrations without a seed/schema push, then starts the real standalone server. Application, database and authenticated control listeners bind only to127.0.0.1. Browser launch waits for a successful bootstrap response. Keep the foreground console open and use Stop to shut down cleanly.

Stop authenticates against the matching instance and terminates only its owned child/server/cluster. An unauthenticated or stale lock is not permission to kill other processes. Restart retains configuration, database and uploads. This runtime creates no global service or machine-wide runtime installation.

## Evidence

`tests/installer/windows-runtime.test.cjs` checks the public configuration/status CLI; `windows-acl.test.cjs` verifies removal of an explicit Everyone grant from both data root and secret-file permissions. Actual payload smoke/browser evidence and executable installation acceptance are separate checks recorded in `STATUS.md` and the feature task document.
