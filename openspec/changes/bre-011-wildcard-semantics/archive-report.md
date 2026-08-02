# Archive Report: BRE-011 — Wildcard Semantics (Option A)

- **Change**: bre-011-wildcard-semantics
- **Repo**: Sistema1
- **Main SHA**: f50cb17 (HEAD)
- **Date**: 2026-08-02
- **Result**: PASS

## Decision

`option-a-explicit-limited-wildcard`

## Resolved Decisions

1. **#1 — No-match vs validation failure**: runtime no-match on `*` for `amount_*` and `description_matches`, plus write/import rejection in a shared domain/API layer (UI message is not the sole barrier; no DB-level restriction).
2. **#2 — Legacy-column normalization**: conditions-first, fallback legacy `conditionType`/`conditionValue` → canonical model, fail closed when neither normalizes. Productive path does NOT preserve `conditions: null`.

## Final State

- PR #12 and PR #13 merged linearly into `main`.
- `sdd-verify`: PASS — 8/8 checklist items.
- Tests: 81/81 BRE-011 passing (incl. corpus 8 cases full parity across Legacy/V2/Precedence).
- BRE-009 parity harness W-1 closed (no longer diverges on the bounded surface).
- BRE-010 intact (no regressions).
- No blockers.

## PR Merge SHAs

- PR #12: `b3c02ab` (rebase-merge final foo-topic commit SHA on `main`)
- PR #13: `f50cb17` (rebase-merge final foo-topic commit SHA on `main`)

Note: the rebase-merges produce final SHAs from the last `foo-topic` commit landed on `main` (b3c02ab for #12, f50cb17 for #13).

## Published Specs / Artifacts

- `openspec/specs/rule-wildcard-semantics/spec.md` — new spec
- `openspec/changes/bre-011-wildcard-semantics/specs/rule-engine-integration/spec.md` — delta spec
- `docs/adr/ADR-011-wildcard-semantics.md`
- `docs/history/2026-08-wildcard-semantics.md`

## Next

Change fully closed. No pending `sdd-verify` or `sdd-archive` work items.