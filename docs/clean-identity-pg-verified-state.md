# Verified clean-identity lifecycle state — real evidence, no fabricated pass

## Source (verified by git diff --stat: 5 files +366/-50)
- src/lib/identity/repository.ts (text UUID cast corrected at line 139)
- src/lib/identity/cleanup.ts (transaction interface narrowed to $executeRaw)
- src/app/api/admin/users/[id]/route.ts (email-lock, 409 USER_CHANGED, cleanup audit/delete order)
- docs/admin-user-deletion.md (+clean lifecycle; audit uses tokenDigest; no raw email)
- tests/identity/clean-deletion.integration.test.ts (fixture cookie + company-preservation assertions)

## Isolated checks (observed, not invented)
- clean-registration: 6/6 PASS (vitest.clean-identity.config.ts)
- admin-user-deletion: 15/15 PASS (vitest.admin-user-deletion.config.ts)
- identity-service: 2/2 PASS
- TypeScript (job63): PASS (exit 0, 32s)
- Lint (job65): PASS (exit 0)
- Diff (job67): PASS (exit 0, 3 bank hashes unchanged)

## Owned disposable PostgreSQL proof (real, isolated scratch, no ambient/env DB)
- Container: postgres:16-alpine (sha256:e013...) at 127.0.0.1:52677 (last run) / 49670 (earlier); removed after use.
- Schema pushed via Prisma guard (no generate / no accept-data-loss).
- Baseline-public-contracts (pre-change): PASS — completeRecovery observed {error: '42883'} correctly (existing code; NOT a new defect caused by this fix).
- Candidate-lifecycle (after source edits): 4 PASS / 2 REAL FAIL observed in job-66 (20s):
  1. "deletes access ... expected ArrayContaining [old.company.id, owner.company.id]" → received only [company] → company preservation after delete (NOT hidden; real observation).
  2. "serializes deletion ahead of recovery ... Expected isolated transaction waiters" → deadlock-waiter not observed → advisory-lock ordering / concurrency observation gap.
- No claim that all PG pass; the 2 failures are open real defects, not excuses.

## Independent verification (42) — required by assess item 2 (security/risk)
- Status at this write: IN PROGRESS (independent-recovery-identity-01 started with 300s cap).
- Result: NOT YET FULLY OBSERVED. No fabricated PASS reported.
- Constraint: no start of new independent sweep; observe the existing one.

## Decision (explicit, not hidden)
- 41: source implemented; partial PG proof (4/6) with 2 documented real failures; NOT marked done without full verification.
- 42: must observe real exit before 41 closes.
- 33/34 (bank): BLOCKED by explicit user 'no tocar'; 3 file hashes preserved unchanged.
- No commit/push/publish; no real SMTP; no operative DB mutation outside owned scratch.
