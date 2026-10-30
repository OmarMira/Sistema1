# Persistent maintenance admission

This is a verified prerequisite for company recovery, not a complete recovery mode. Do not activate maintenance for restoration until every supported writer and persistent reconciliation adopts this boundary.

## Contract

`createMaintenanceGate(absoluteRoot)` in `src/lib/backup-maintenance.mjs` performs no storage access during construction. The application facade resolves the root from existing `RUNTIME_DIR` configuration.

| Operation | Guarantee |
| --- | --- |
| `acquireNormalOperation()` | Publishes a durable exclusive lease and checks maintenance before and after publication. |
| `lease.run(fn)` | Holds ownership through the awaited callback; legitimate nested operations reuse admission. |
| `lease.release()` | Rejects while awaited work runs and validates the owned lease before removal. |
| `beginMaintenance()` | Publishes an exclusive persistent marker; does not grant immediate mutation authority. |
| `owner.drain({ timeoutMs })` | Waits for normal leases within an explicit bounded timeout; does not remove stale records. |
| `owner.runRecovery(fn)` | Requires the live owner and completed drain; rejects overlapping recovery. |
| `owner.release()` | Requires drained state and no active recovery before reopening admission. |
| `status()` | Reads marker/lease state; corrupt or unavailable storage fails closed. |

`apiHandler` acquires fresh admission before session/authentication, tenant checks, DB effects, or the handler. Anonymous/super-admin options, request headers, and recovery context cannot bypass this admission. Existing unmarked responses remain unchanged. Admission failures return HTTP 503 with code `BACKUP_MAINTENANCE`.

## Limits

- Cooperating processes must use the same trusted storage root. This is not a sandbox against privileged external file replacement.
- A crashed owner leaves blocking records. Restart does not reconstruct ownership or automatically reclaim records.
- File contents are fsynced; directory metadata and abrupt power-loss durability are not proven.
- Raw/model DB calls outside admitted requests, startup/background jobs, unwrapped routes, config/asset writers, independent scripts, detached work and streaming effects still need integration.
- No undo journal, asset restoration, reconciliation, restore route or whole-installation exclusion is provided by this unit.

## Verification

```sh
node node_modules/vitest/vitest.mjs run --config vitest.company-backup.config.mts --configLoader native
```

Tests use mocked API dependencies and unique fixtures under `tests/backup-company/.scratch` relative to the current test workspace, not configured application storage. Run independent verification in an authorized disposable workspace. Owned child processes simulate admission and exited owners; never stop existing application/database processes.

Independent verification passed 133 isolated tests plus two awaited-ownership probes before those probes were incorporated into the regression suite. The initial copied-workspace suite failed collection because `bcryptjs` was omitted; after copying that installed dependency it passed. No installation or candidate-source correction was needed. This is not real PostgreSQL, browser, full crash recovery, or power-loss evidence.
