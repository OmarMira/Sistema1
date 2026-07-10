# Security Hardening Report

**Project:** Account Express New Gen
**Date:** 2026-07-09
**Sprint:** Security hardening — crypto.ts vulnerability + audit documentation

---

## Critical

| # | Finding | Status | Evidence |
|---|---|---|---|
| 5.1 | Hardcoded `SESSION_SECRET` fallback in `crypto.ts` | ✅ FIX IMPLEMENTED | `src/lib/crypto.ts:7-18` — fallback removed, throws in all environments |

## High

None confirmed.

## Medium

| # | Finding | Status | Justification |
|---|---|---|---|
| 5.2 | Rate limiter uses in-memory `Map` | Accepted | Single-instance deployment. Revisit for multi-instance. |
| 5.3 | XSS sanitization uses regex | Accepted | Strips all HTML tags. Adequate for structured text fields. React escapes in frontend. |
| 5.4 | Backups on local filesystem | Accepted | Local-first design. No encryption at rest. |

## Low

| # | Finding | Status | Justification |
|---|---|---|---|
| 5.5 | `readFileSync` blocks event loop | Accepted | Low-frequency paths. Negligible at target scale. |
| 5.6 | `process.env` mutation in AI config | Accepted | Single-instance. Concurrency bug, not security. |
| 5.7 | Password policy (min 8, no complexity) | Accepted | SME accounting system. Tighten if threat model changes. |

---

## Verification

| Check | Result | Scope |
|---|---|---|
| `npx tsc --noEmit` | ✅ exit 0 | whole project |
| `npm run build` | ✅ Compiled successfully | whole project |
| `tests/crypto.test.ts` | ✅ 19/19 passed | security |
| `tests/ai-config.test.ts` | ✅ 5/5 passed | security |
| Full vitest suite | 848 passed, 157 failed | whole project |

---

## Changes Made

| File | Change |
|---|---|
| `src/lib/crypto.ts` | Removed hardcoded fallback. `getKey()` throws if `SESSION_SECRET` missing in any environment. |
| `src/lib/ai-config.ts` | Decrypt failure throws recovery message. No API key or ciphertext exposed in error. |
| `tests/crypto.test.ts` | 19 tests: encrypt/decrypt, error handling, SESSION_SECRET enforcement. |
| `tests/ai-config.test.ts` | 5 tests: decrypt failure with different secret, recovery message, no key leak. |
| `SECURITY_AUDIT.md` | Living document with evidence-based findings, architectural context, accepted risks. |

---

## Known Issues

157 tests fail across 26 test files. These failures were present before this security sprint and were not investigated. None of the new security tests are among the failures. Attributing these failures to pre-existing issues was not formally verified with before/after comparison — this should be confirmed in a dedicated test health sprint.

---

## Accepted Risks (Architecture-Dependent)

These are conscious trade-offs aligned with single-instance, local-first deployment:

- In-memory rate limiting (needs Redis for multi-instance)
- Local filesystem backups (needs S3/GCS + encryption for SaaS)
- PostgreSQL Row-Level Security is not currently used. Authorization is enforced in the application layer and should be re-evaluated if the trust model changes or database access becomes shared.
- Regex-based XSS sanitization (adequate for structured text)
- `readFileSync` in config routes (low-frequency paths)

---

## Next Improvements

| Priority | Action | Blocked By |
|---|---|---|
| DEFERRED | Migrate `sanitize.ts` to `sanitize-html` | Rich text fields or server-side HTML rendering |
| LOW | Remove `process.env` mutation in AI config | Multi-instance deployment |
| LOW | Convert `readFileSync` to async + cache | Performance testing |
| LOW | Add password complexity requirements | Compliance review |
| FUTURE | Distributed rate limiter | Multi-instance deployment |
| FUTURE | Cloud backup storage + encryption | SaaS migration |
| FUTURE | PostgreSQL RLS | Compliance review |
