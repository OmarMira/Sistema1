# Isolated CI verification

Run `node scripts/ci-test-isolated.mjs --help` for the supported options.

- `--plan` lists the complete dedicated identity-suite manifest without invoking Docker.
- `--run --focus` checks the previously failing application files and every dedicated identity suite.
- `--run` checks the full application suite and every dedicated identity suite.
- Add `--checks` to include Prisma validation, TypeScript, ESLint, the production build and the locally installed gitleaks scanner.

The runner requires the already installed dependencies and local `postgres:16-alpine` image. It never downloads an image. GitHub CI declares that exact image for its PostgreSQL service, making it available before the no-pull runner starts. CI invokes the same full test runner; it does not silently omit identity tests.

Each run creates a new tmpfs PostgreSQL container with cryptographically random credentials and ownership proof, bound only to a dynamic loopback port. The application, low-level identity contracts, registration and identity-deletion suites use separate databases. Only the two local Docker socket endpoints are accepted; remote Docker endpoints are refused before any Docker command. The runner does not modify `.env` files, existing containers or database authentication configuration.

The runner inspects its newly created container before schema operations. Cleanup rechecks the full ID, ownership label, mount and loopback-port proof and removes only that exact ID. A missing or mismatched proof refuses cleanup and fails the command; a failure cannot be reported as a successful check. Inspect the explicitly named run-owned resource if cleanup cannot be proved. Abrupt host/process termination may still require manual inspection of that named resource.

Direct identity integration runs now require a fresh explicit owner proof and matching loopback mapping, not historical session markers or fixed ports. Prefer the runner instead of manually setting these variables. No production authentication rule or database constraint is relaxed.

The initial CI evidence was run40044419714 attempt2:74 failed assertions and5 failed suite initializations, not proof of an operative database corruption. Direct test fixtures representing already authenticated users lacked `emailVerifiedAt`. Three component files needed an explicit browser environment. The admin component retains its shared setup; bank activity and reconciliation retain their own mocks without a conflicting shared setup import. Dedicated identity tests were being collected against the wrong database by the root configuration.

## CI-test lint coverage

ESLint includes `tests/ci/**`, including nested files. Other test directories, scripts and generated artifacts retain their existing exclusions; application rules are unchanged. The existing CI `eslint .` command therefore checks the CI tests without a separate bypass flag.

Run the installed CLI directly: `node node_modules/eslint/bin/eslint.js tests/ci --max-warnings 0`.
Run the configuration regressions and helper tests: `node node_modules/vitest/vitest.mjs run --config vitest.ci-guards.config.ts`.

The regression checks ESLint's public API: CI tests are not ignored, a forbidden `require()` import produces a real error, and the application rules/other exclusions remain in effect. An ignored-file warning is not a passing lint check.

## Verification limits

| Check | Observed evidence | What it does not prove |
| --- | --- | --- |
| Application tests | Last full run: 4,321 passed, 17 failed; those 17 later passed a focused recheck | No all-green full-suite rerun was observed after that correction |
| Skipped application tests | Four files / 54 assertions skipped in that run | Skipped cases did not pass; their skip reasons have not been audited here |
| Dedicated identity suites | 20 + 9 + 6 passed in new disposable databases | Does not inspect or certify the operative database |
| CI-test lint | All three CI test files analyzed: zero errors/warnings; CI helper suite 28/28 passed | Does not lint the rest of `tests/**` |
| TypeScript | Prior application `tsc --noEmit` passed | `tsconfig.json` excludes tests, so this is not semantic typechecking of tests |
| Secret scan | Authorized code-only snapshot passed with 144 declared exclusions | Excluded private files, historical commits and later changes are not certified |
| Independent review | Original CI-repair and new ESLint-scope verifiers returned no verdict | Parent checks cannot substitute for independent approval |

Functional execution, lint and typechecking are separate checks. A test being stored in this repository does not mean it ran, and a lint exclusion does not mean it failed. No skipped, excluded or unreviewed scope is reported as clean.

Verification status and exact per-change results are recorded in `odd/tasks/ci-safe-repair.md`. A local pass is not a GitHub CI pass: publishing and remote CI execution remain separate authorized actions. Local gitleaks8.18.4 differs from CI8.24.0 and is not claimed as identical proof.
