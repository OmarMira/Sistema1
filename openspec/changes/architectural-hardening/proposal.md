# Proposal: Architectural Hardening

## Intent

A financial SaaS with Float money types, plaintext session tokens, hardcoded SQLite, and builds ignoring TS errors is untrustworthy. Fix all four.

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
| `src/lib/db.ts` | Modified | Remove SQLite PRAGMAs |

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
- **PR 3**: Keep SQLite dump. Revert schema, restore dump

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
