## v0.9.0 – Stable Foundation

**Tag:** `v0.9.0-stable-foundation`
**Date:** 2026-07-10

### Security Hardening

- `SESSION_SECRET` enforced in all environments (no hardcoded fallback)
- AI config decrypt failure handled gracefully (no API key or ciphertext exposed)
- 24 new tests (crypto + ai-config)
- `SECURITY_AUDIT.md` created with 7 findings (5.1 critical fixed, 5.2–5.7 accepted/deferred)
- `SECURITY_HARDENING_REPORT.md` created for deployment documentation

### Test Health

- 157 → 0 test failures across 30+ files
- Root causes: mock setup (43%), assertion mismatch (39%), missing exports (14%), integration (7%)
- `validateBackup` regression fixed (comment said systemConfig optional, code invalidated without it)
- 1010 tests passing, 1 skipped, 0 failed
- 33 production changes: TypeScript null-safety refactors
- 1 production change: validateBackup regression fix

### Engineering Principles Established

1. Evidence over assumptions
2. Tests describe behavior, not implementation
3. Never change production code only to satisfy tests
4. Every security finding requires evidence
5. Every accepted risk must include review conditions

### Baseline

- TypeScript: `tsc --noEmit` exit 0
- Full test suite duration: ~8.5 minutes (517s)
- PostgreSQL: Windows service (not Docker)
- Tag pushed to GitHub: `v0.9.0-stable-foundation`

### Known Limitations

- Security finding 5.1: FIX IMPLEMENTED (pending production verification).
- `entity-first-flow` test requires 15s timeout due to database setup overhead (~11.5s actual).
- Full test suite runs sequentially (`fileParallelism: false` in vitest.config.ts).
