# Proposal: Architectural Hardening

## Closure Note (2026-07-29)

**Status: ✅ IMPLEMENTED** — all three PRs were verified as already present in the codebase.

### Verification Log

| Check | Result | Evidence |
|-------|--------|----------|
| `tsconfig.json` has `strict: true` | ✅ | `tsconfig.json:11` |
| `next.config.ts` has `ignoreBuildErrors: false` | ✅ | `next.config.ts:5` (file is `.ts`, not `.mjs` as originally assumed) |
| `noImplicitAny` enabled | ✅ | `tsconfig.json:13` — fixed as part of this closure (commit 41f3f37) |
| `npx tsc --noEmit` clean | ✅ | 0 errors |
| Prisma provider: `postgresql` | ✅ | `prisma/schema.prisma:6` |
| 12 monetary fields: `Decimal @db.Decimal(18,2)` | ✅ | BankAccount.balance/initialBalance, BankStatement.openingBalance/closingBalance/totalCredits/totalDebits, BankTransaction.amount, ReconciliationPeriod.statementBalance/bookBalance/difference, JournalLine.debit/credit |
| No PRAGMAs in `db.ts` | ✅ | `src/lib/db.ts` has no PRAGMAs |
| Session hashing: SHA-256 | ✅ | `src/lib/sessions.ts:9` `hashToken()` |
| `createSession` hashes before store | ✅ | `src/lib/sessions.ts:22` |
| `getSessionUserId` hashes before lookup | ✅ | `src/lib/sessions.ts:35` |
| `destroySession` hashes before delete | ✅ | `src/lib/sessions.ts:53` |
| Full test suite | ✅ | 155 files, 1972 passed, 5 skipped |
| `npm run build` | ✅ | Successful |

### Implementation History (approximate commits)

- **PR 1** (strict TS): Gradual — `next.config.ts` creation, `tsconfig.json` with `strict: true`, and scattered type fixes across multiple commits.
- **PR 2** (Float→Decimal): Schema + service files migrated in prior feature sprints when Decimal support was introduced.
- **PR 3** (Postgres + hashing): Provider switch and session hashing implemented alongside the initial Postgres setup.

### Deltas from Original Plan

1. `next.config.ts` exists instead of `next.config.mjs` — TS config syntax, functionally equivalent.
2. `noImplicitAny` was `false` despite `strict: true` — resolved in commit 41f3f37 with 7 error fixes across 3 files.
3. `noUncheckedIndexedAccess` not enabled — not required for the core goals. Left as future improvement.

### What Was NOT Done (and Why)

- `noUncheckedIndexedAccess: true` — not part of the original "make build safe" intent. Would require ~30+ explicit checks across array/record access sites. Valid but separate.
- `@db.Decimal(18,2)` already present on all 12 monetary fields (PR 2 + PR 3 were merged together).

## Intent

A financial SaaS with Float money types, plaintext session tokens, and builds ignoring TS errors is untrustworthy. Fix all three.

## Scope

### In Scope

- **PR 1**: Remove `ignoreBuildErrors: true` from `next.config.mjs`, fix all TS errors
- **PR 2**: 12 Float fields across 5 Prisma models → `Decimal @db.Decimal(18, 2)`. Update 15 service files doing Float math + affected tests
- **PR 3**: Prisma provider → `postgresql`, initial migration. SHA-256 hashing on session token create/lookup

### Out of Scope

CSRF/Origin middleware, auth overhaul, schema redesign beyond types, data migration automation, env vars beyond DATABASE_URL.

## Capabilities

No new or modified domain capabilities — pure infrastructure/data-type hardening.

## Approach

Three sequential PRs, each independently deployable:

1. **PR 1**: `npx tsc --noEmit` must pass clean
2. **PR 2**: Migrate Float → Decimal in schema + Prisma client. Replace `Math.round(x*100)/100` with `Prisma.Decimal` in 15 service files. Update test assertions
3. **PR 3**: Swap to postgresql, generate migration. Hash tokens with SHA-256 on write, hash query param on read. Manual data migration required

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `next.config.mjs` | Modified | Remove `ignoreBuildErrors` |
| `prisma/schema.prisma` | Modified | 12 fields → Decimal, provider → postgresql |
| `src/lib/sessions.ts` | Modified | SHA-256 hashing |
| 5 Prisma models | Modified | Float → Decimal columns |
| 15 service files | Modified | Float math → Decimal ops |
| `src/lib/db.ts` | Modified | Decimal safety-net middleware |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaking 302 transactions on Float→Decimal | High | Export + cast Float→TEXT→DECIMAL before PR 2 |
| All sessions invalidated after PR 3 | High | Forced re-login, communicated ahead |
| `Prisma.Decimal` vs `number` type mismatches | Medium | tsc catches all — no `as number` escapes |
| Postgres raw SQL incompatibility | Low | Prisma abstracts providers; review `db.ts` only |

## Rollback Plan

- **PR 1**: Revert `next.config.mjs`
- **PR 2**: Keep data export. Revert schema + services, re-deploy
- **PR 3**: Revert schema, restore from backup

## Dependencies

- Production PostgreSQL instance + `DATABASE_URL`
- Data export script for 302 transactions before PR 2

## Success Criteria

- [ ] `npx tsc --noEmit` exits 0 (PR 1)
- [ ] All 12 monetary fields stored as `Decimal(18,2)` (PR 2)
- [ ] All 33 tests pass (PR 2)
- [ ] Session tokens hashed via SHA-256 in DB (PR 3)
- [ ] Session lookup by hash matches existing tokens (PR 3)
- [ ] `bun run dev` starts clean after each PR
