# Persistent maintenance admission

This boundary now fences the supported application DB, runtime-file, startup, background-session and deletion-script writers listed below. It is **not complete option C recovery**: persistent preimages, reconciliation, asset format/restore wiring, Decimal/JSON-null fidelity and independent PostgreSQL/browser/crash proof remain outstanding. Do not activate it for restoration yet.

## Public contracts

`src/lib/backup-maintenance.mjs` is plain Node ESM; no TypeScript loader is needed by scripts. `createMaintenanceGate(absoluteRoot)` performs no storage access during construction.

| Operation | Guarantee |
| --- | --- |
| `acquireNormalOperation()` | Publishes a durable exclusive lease and checks maintenance before and after publication. |
| `lease.run(fn)` | Holds ownership through the callback and already-started nested guarded work. |
| `lease.runSync(fn, settled?)` | Runs synchronously; invokes `settled` after all nested work settles. Returning a promise throws `Synchronous operation returned a promise`, but retains ownership until it settles. |
| `lease.release()` | Rejects while work runs and validates the owned lease before removal. |
| `withNormalOperation(fn)` | Reuses only live same-root normal scopes, otherwise acquires fresh normal admission. Recovery does not bypass this guard. |
| `withRuntimeOperation(fn)` | For trusted runtime DB/file writers: reuses live normal scopes, or accepts the live owned recovery callback capability. Returns a promise held through the operation. |
| `withRuntimeOperationSync(fn)` | Same admission policy with synchronous return/throw timing. Promise misuse fails closed without releasing inflight work. |
| `beginMaintenance()` | Publishes an exclusive persistent marker; does not grant immediate mutation authority. |
| `owner.drain({ timeoutMs })` | Waits for normal leases within an explicit bounded timeout; never removes stale records. |
| `owner.runRecovery(fn)` | Requires live ownership and completed drain; rejects overlap. Only runtime guards accept its capability, not normal/API admission. |
| `owner.release()` | Requires drained state and no active recovery before reopening admission. |
| `status()` | Reads marker/lease state; corrupt or unavailable storage fails closed. |
| `configuredDataRoot()` | Existing application path validation/real-ancestor normalization, extracted unchanged from `config/paths.ts`. Returns the configured data root or `undefined`. |
| `runtimeDirectory()` | Resolves `<data-root>/config`, or `<cwd>/.data` when unconfigured. |

The TypeScript facade exports `acquireNormalOperation`, `withNormalOperation`, `withRuntimeOperation`, `withRuntimeOperationSync`, `maintenanceStatus`, and `beginMaintenance`. It uses `<RUNTIME_DIR>/backup-maintenance`. `config/paths.ts` and the standalone script share the MJS data-root resolver; existing default paths and validation errors remain unchanged.

## Scope lifetime and HTTP

`apiHandler` still acquires **fresh** admission before session/authentication, tenant checks, DB effects or the handler. Anonymous/super-admin options, request headers and recovery context do not bypass admission. Admission failures return HTTP 503 with code `BACKUP_MAINTENANCE`. The direct logout route independently acquires fresh admission before reading its token or destroying sessions; denial does not clear the cookie.

Nested guarded work started while a normal callback is live reuses its lease, including after maintenance publication. The lease stays held through that work even if its initiating callback returns first. A later detached callback cannot inherit an expired normal scope: it acquires its own admission and is refused while marked. A detached callback inheriting an expired recovery scope is refused even after reopening. No environment flag, header or HTTP option grants recovery authority.

The recovery callback is a trusted in-process owner capability, not a general sandbox. Guarded work begun within it is tracked through completion; owner release still refuses while recovery runs. Normal-admission helpers remain blocked inside recovery.

## Supported integration

- Public `db` model operations and all four PostgreSQL raw methods are lazy guarded Prisma promises. Admission begins when consumed, not when constructed. Fluent calls remain guarded.
- Interactive `$transaction` holds admission around the entire callback **and commit**, including non-DB awaits. Its callback receives a guarded client.
- Array `$transaction` unwraps only this wrapper's private promise mapping before passing to Prisma, preserving batch `requestTransaction` binding. Admission covers the whole batch and commit. No unguarded base client is exported; `$extends` and `$parent` return guarded clients, not an admission bypass.
- Custom client extension methods (ordinary and `$`-prefixed) receive the guarded client as `this`. Their synchronous values and lazy PrismaPromise returns are not converted to native promises; queries through `this` remain admitted, including in array transactions. Native `$connect`, `$disconnect` and `$on` keep their required native receiver.
- Existing per-field monetary Number result overrides remain unchanged. **This does not fix backup Decimal precision.**
- Node instrumentation acquires admission before runtime initialization, PDF setup, DB optimization, metric reset and cleanup scheduling. `initRuntimeData()` remains synchronous for its filesystem effects; its asynchronous AI integrity check uses runtime admission separately.
- Background cleanup owns runtime admission for each invocation. Scheduling cleanup itself is synchronously guarded; expired timer context must reacquire.
- Onboarding covers the whole DB transaction and JSON configuration write with one outer runtime operation.
- Logo save/delete cover their complete asynchronous filesystem effects. Existing admitted API callers retain the outer API lease through both logo writes and later DB updates. Direct callers combining multiple independent operations must explicitly wrap their complete unit in `withRuntimeOperation`.
- `FileResource.execute()` synchronously guards create/modify/delete and returns its existing `{ success: false, error }` shape on denial. Read-only operations remain available.
- `scripts/delete-company.mjs` uses the same persisted root and acquires admission before constructing its independent Prisma client, prompting or deleting. Marked admission exits 1, stdout empty, stderr `Maintenance admission unavailable\n`. Existing unmarked safety checks, confirmation and deletion output remain unchanged. Never run it against customer data to test fencing.

## Limits and recovery gate

- Cooperating processes must use the same trusted root and application exports. Privileged external filesystem mutation, independent hostile Prisma clients, deployment scripts and arbitrary direct filesystem writers are not sandboxed.
- A crashed owner leaves blocking records. Restart does not reconstruct ownership or automatically reclaim records.
- File contents are fsynced; directory metadata and abrupt power-loss durability are not proven.
- Streaming/detached effects are protected only when they use guarded supported writers. Arbitrary unguarded effects are outside this guarantee.
- No undo journal, asset restoration, reconciliation, restore route or whole-installation exclusion is supplied here. Existing legacy/bootstrap-v2 and differing-config/logo/fidelity refusals are not relaxed. The unfinished restore core is not routed through an owned recovery context by this unit.

## Verification

```sh
node node_modules/vitest/vitest.mjs run --config vitest.company-backup.config.mts --configLoader native tests/backup-company/writer-admission.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.company-backup.config.mts --configLoader native
```

Tests use lazy Prisma adapters, synthetic files and unique fixtures under `tests/backup-company/.scratch`. The deletion script is executed only as a mock copy, never with a real client. These tests are not PostgreSQL transaction/extension acceptance, browser evidence or power-loss proof. Independent verification must inspect the actual Prisma contract before accepting this unit.

The prerequisite T2a independently passed 133 isolated tests plus two awaited-ownership probes, subsequently integrated into its 135-test suite. That verdict applies to T2a only; it is not approval of this writer-integration change.
