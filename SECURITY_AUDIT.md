# Security Architecture — Account Express New Gen

Living document. Last updated: 2026-07-09.

---

## 1. Objective

Document security findings with evidence, justify architectural decisions, and prevent false positives in future audits. Every claim here is backed by file + line references against the codebase at the time of audit.

## 2. Scope

Full codebase review of `Account-Express-New-Gen` (Next.js 16 + TypeScript + Prisma + PostgreSQL + Tailwind + Shadcn/UI). Focused on: authentication, authorization, cryptographic handling, input validation, CSRF, rate limiting, data protection, and dependency risks.

## 3. Security Principles

These principles override generic scanner output. Any finding that contradicts them must be re-evaluated against the actual architecture.

- **No hardcoded secrets.** Fatal error at startup if required secrets are missing.
- **Fail closed.** Deny by default when validation is ambiguous.
- **Least privilege.** Roles enforced at API handler level. `companyId` extracted and verified per request.
- **Defense in depth.** Multiple layers: proxy (CSRF, headers), api-handler (auth, rate limit), service layer (validation).
- **Evidence over assumptions.** Every finding must cite file + line. Inference without code verification is not a finding.
- **Architecture decisions override generic scanners.** A "vulnerability" that is actually a conscious design trade-off is not a vulnerability.

## 4. Architectural Context

### Code-verifiable facts

- **PostgreSQL** as primary database (`prisma/schema.prisma:6` — `provider = "postgresql"`).
- **Multi-company support** — `companyId` enforced per request via `api-handler.ts:35-74`. Membership verified against `CompanyMember` table.
- **SME target** — accounting system for small and medium enterprises.

### Product deployment decisions (not verifiable from code alone)

- **Local-first product.** Cloud infrastructure is optional.
- **The current recommended deployment is a single application instance.** No horizontal scaling, no Kubernetes, no serverless.
- **Deployment assumptions are product decisions** and must be revalidated separately from code-level findings.

### These assumptions must be re-evaluated if the project evolves to:

- SaaS deployment
- Multi-instance / horizontal scaling
- Mandatory cloud infrastructure
- Compliance requirements (PCI-DSS, SOC2, etc.)

### Security decisions in this context

| Decision | Context |
|---|---|
| Rate limiter in-memory (`Map`) | Acceptable for single-instance. Would need Redis/Upstash for multi-instance. |
| Backups on local filesystem | Acceptable for local-first. Would need S3/GCS + encryption for SaaS. |
| No CSRF tokens (uses Origin/Referer check) | Sufficient for same-origin browser requests. `proxy.ts` handles it. |
| `readFileSync` in config routes | Low-frequency paths. Event loop blocking is negligible at target scale. |
| Password complexity (min 8, no special chars) | Acceptable for SME accounting. Can be tightened if threat model changes. |
| No RLS in PostgreSQL | Can be added as defense-in-depth when needed. Currently enforced at application layer. |

## 5. Confirmed Findings

### 5.1 ~~CRITICAL~~ FIX IMPLEMENTED — Hardcoded crypto secret fallback

| Field | Value |
|---|---|
| **File** | `src/lib/crypto.ts:7-18` |
| **Original evidence** | `process.env.SESSION_SECRET \|\| 'default-development-session-secret-change-me-in-production-32-chars'` |
| **Resolution** | Removed hardcoded fallback entirely. All environments throw if `SESSION_SECRET` missing. No dev/test fallback. |
| **Decrypt failure handling** | `src/lib/ai-config.ts:84-89` — clear error message when stored key can't be decrypted, instructs user to re-save config. |
| **Tests added** | `tests/crypto.test.ts` — 19 tests: encrypt/decrypt, error handling, SESSION_SECRET enforcement (throws in all envs without it), different secrets produce different keys. |
| **Compatibility** | No change to algorithm, salt, or key derivation. Existing encrypted data remains decryptable with the same `SESSION_SECRET`. Data encrypted with the old default secret will be inaccessible. |
| **Status** | FIX IMPLEMENTED — pending deployment |

### 5.2 MEDIUM — General rate limiter not distributed

| Field | Value |
|---|---|
| **File** | `src/lib/security/rate-limiter.ts:14` |
| **Evidence** | `const requestWindows = new Map<string, { count: number; resetAt: number }>()` |
| **Scope** | General API rate limiting (used in `api-handler.ts:131`). Auth rate limiter (`src/lib/rate-limiter.ts`) uses DB persistence. |
| **Impact** | In multi-instance deployments, each instance has independent counters. Rate limits are effectively multiplied by instance count. |
| **Severity** | MEDIUM |
| **Decision** | Acceptable for current single-instance deployment. Revisit if migrating to multi-instance. |
| **Status** | Accepted (architecture-dependent) |
| **Review when** | Deploying to Kubernetes, serverless, or Railway |

### 5.3 MEDIUM — XSS sanitization uses regex instead of library

| Field | Value |
|---|---|
| **File** | `src/lib/sanitize.ts:10-12` |
| **Evidence** | Two regexes: (1) removes `<script>...</script>` blocks, (2) strips any remaining HTML tag entirely including attributes. |
| **Contract** | `sanitizeInput(value: string): string` — strips ALL HTML from plain text. Called only by `validateRequest()` after Zod validation. |
| **Data flowing through** | Structured text fields: names, addresses, emails, phone, taxId, notes, regex patterns. No rich content. |
| **Installed alternative** | `sanitize-html` (in `package.json`) — not used in this file. |
| **Impact** | Regex is not a general HTML parser, but for this contract (strip all tags from structured text), vectors like `<img onerror="...">`, `<a href="javascript:...">`, and `<svg onload="...">` are fully removed by the second regex. Primary defense remains contextual escaping at render time (React in frontend). |
| **Severity** | MEDIUM |
| **Decision** | Regex is adequate for current structured text fields. Migrate to `sanitize-html` when: (1) rich text editor is added, (2) HTML rendering in server-side emails/reports, (3) intentional HTML content in any field. |
| **Status** | Accepted (adequate for current use case) |
| **Review when** | Adding rich text fields, email templates, or server-side HTML rendering |

### 5.4 MEDIUM — Backups on local filesystem

| Field | Value |
|---|---|
| **File** | `src/lib/backup.ts` — `BACKUP_DIR = path.join(process.cwd(), 'db', 'backups')` |
| **Evidence** | Writes JSON to local disk. No encryption at rest. Filesystem is ephemeral in serverless/containers. |
| **Impact** | Data loss in ephemeral environments. No encryption means disk access exposes all company data. |
| **Severity** | MEDIUM |
| **Decision** | Acceptable for local-first deployment. Revisit if migrating to SaaS. |
| **Status** | Accepted (local-first design) |
| **Review when** | Migrating to SaaS (need S3/GCS + encryption) |

### 5.5 LOW — readFileSync blocking event loop

| Field | Value |
|---|---|
| **Files** | 34 instances across `src/lib/` and `src/app/api/` |
| **Most impactful** | `src/lib/security/rate-limiter.ts:65` (runs on every API request) |
| **Impact** | Blocks event loop during file read. Negligible at target scale (single-instance, SME traffic). |
| **Severity** | LOW |
| **Decision** | Acceptable for current scale. Convert to async + cache if performance becomes an issue. |
| **Status** | Accepted (scale-dependent) |

### 5.6 LOW — process.env mutation in AI config

| Field | Value |
|---|---|
| **File** | `src/app/api/config/ai/route.ts:81-82` |
| **Evidence** | `process.env.AI_API_KEY = apiKey;` — mutates in-process env after DB write. |
| **Impact** | In multi-instance, only the instance that handled the request gets the new value. Other instances keep stale config until restart. Not a security vulnerability. |
| **Severity** | LOW |
| **Decision** | Bug (concurrency), not security issue. Fix if deploying multi-instance. |
| **Status** | Accepted (single-instance) |

### 5.7 LOW — Password policy lacks complexity

| Field | Value |
|---|---|
| **Files** | `src/lib/validations/auth.ts:16`, `src/app/api/settings/password/route.ts:25` |
| **Evidence** | Both require min 8 characters. No uppercase, number, or symbol requirements. No check against common passwords. |
| **Impact** | Weak passwords are easier to brute-force. Relevant for internet-facing deployments. |
| **Severity** | LOW |
| **Decision** | Acceptable for local-first SME system. Tighten if threat model changes. |
| **Status** | Accepted (design choice) |
| **Review when** | Internet-facing deployment or compliance requirements |

## 6. Discarded Findings (False Positives)

| Original Claim | Why Discarded | Evidence |
|---|---|---|
| `.env` file written from API | Already fixed. `setAiConfig()` writes to DB. No `writeFile` in `config/ai/route.ts`. | `src/app/api/config/ai/route.ts:78` |
| No CSRF protection | `proxy.ts` verifies Origin/Referer for POST/PUT/PATCH/DELETE. | `src/proxy.ts:127-152` |
| Cookie name mismatch (`session` vs `session_token`) | Unified. Both `proxy.ts` and `sessions.ts` use `isProd ? '__Host-session' : 'session'`. | `src/proxy.ts:101`, `src/lib/sessions.ts:59` |
| No `middleware.ts` | `proxy.ts` acts as middleware with global matcher. | `src/proxy.ts:162-164` |
| Password 6 chars at registration | Already fixed. `registerSchema` requires `min(8)`. | `src/lib/validations/auth.ts:16` |

## 6.1 Corrected Architectural Assumptions

These were not security vulnerabilities — they were outdated architectural descriptions in the document itself, corrected after verifying the current codebase.

| Original Assumption | Correction | Evidence |
|---|---|---|
| SQLite as primary DB | PostgreSQL is the primary database | `prisma/schema.prisma:6`, `.env:1` |
| Single-company per installation | Multi-company fully supported via `companyId` + `CompanyMember` table | `src/lib/api-handler.ts:35-74`, 100+ files |

## 7. Accepted Risks by Design

These are not vulnerabilities — they are conscious trade-offs aligned with the project's architecture:

| Risk | Justification | Review When |
|---|---|---|
| Single-instance rate limiting | Local-first deployment on a single machine. No horizontal scaling planned. | Multi-instance deployment |
| Local filesystem backups | Consistent with local-first, no-cloud-required design. | SaaS migration |
| No Redis/distributed cache | No infrastructure dependency is a feature, not a bug, for SME target audience. | Multi-instance deployment |
| No RLS in PostgreSQL | PostgreSQL Row-Level Security is not currently used. Authorization is enforced in the application layer and should be re-evaluated if the trust model changes or database access becomes shared. | Compliance requirements |
| No CSP on API responses | API returns JSON, not HTML. CSP is irrelevant for JSON endpoints. | N/A |
| Password policy (min 8 only) | Acceptable for local-first SME system. | Compliance or internet-facing |

## 8. Next Improvements

| Priority | Action | Blocked By |
|---|---|---|
| ✅ DONE | Fix `crypto.ts` — fatal error if `SESSION_SECRET` missing | — |
| ✅ DONE | Add test: server fails to start without `SESSION_SECRET` in production | — |
| ✅ DONE | Add test: ai-config decrypt failure produces recovery message, no key leak | — |
| DEFERRED | Migrate `sanitize.ts` to `sanitize-html` | Rich text fields or server-side HTML rendering |
| LOW | Remove `process.env` mutation in `config/ai/route.ts` | Multi-instance deployment |
| LOW | Convert `readFileSync` to async + cache in rate limiter | Performance testing |
| LOW | Add password complexity requirements | Compliance review |
| FUTURE | Distributed rate limiter (Redis/Upstash) | Multi-instance deployment |
| FUTURE | Cloud backup storage (S3/GCS) + encryption | SaaS migration |
| FUTURE | PostgreSQL RLS as defense-in-depth | Compliance review |

## 9. Audit History

| Date | Auditor | Findings | Notes |
|---|---|---|---|
| 2026-07-09 | AI Analysis (initial) | 3 critical, 6 high, 16 medium, 7 low | Inflated — many false positives from outdated code patterns |
| 2026-07-09 | Development AI (verification) | 1 critical, 0 high, 4 medium, 3 low | Evidence-based. Eliminated 5 false positives. |
| 2026-07-09 | Analysis AI (meta-review) | Confirmed verification methodology | Endorsed evidence-based approach |
| 2026-07-09 | Document updated | Removed SQLite references, added multi-company context, added Security Principles section | Aligned with current PostgreSQL architecture |
| 2026-07-09 | Document refined | Separated code-verifiable facts from product decisions, added Assumptions section | Methodology improvement |
| 2026-07-09 | crypto.ts fix refined | Removed dev/test fallback (throws everywhere), added decrypt failure message in ai-config.ts | Pending deployment |
| 2026-07-09 | ai-config decrypt test added | 5 tests: decrypt failure with different SESSION_SECRET, recovery message, no key/ciphertext leak | Pending deployment |
| 2026-07-09 | sanitize.ts analysis corrected | Second regex strips ALL tags including attributes; vectors like `onerror` are fully removed | Document update |

## 10. Assumptions

This audit assumes:

- Trusted internal network (local-first deployment).
- HTTPS enabled in production.
- **Requirement**: `SESSION_SECRET` is mandatory in every runtime environment. Application startup must fail if it is missing (enforced since 2026-07-09 — see section 5.1).
- Database credentials protected at the OS/filesystem level.
- No arbitrary filesystem access by external attackers.
- Single application instance (no load balancer, no horizontal scaling).

Findings and accepted risks in this document are valid under these assumptions. If any assumption changes, the audit should be re-evaluated.
