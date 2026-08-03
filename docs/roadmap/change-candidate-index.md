# Change Candidate Index

Evidence index of candidate changes for the next SDD change (candidate to be named, e.g. BRE-013). This is an **evidence artifact**, not a decision: it does not prioritize, recommend, or open any change. The roadmap (or the user) selects which candidate becomes the next change.

Status legend:
- **Confirmed** — verified in the repository as of the last review.
- **Requires verification** — a reference exists, but `sdd-explore` must confirm it is still current.

| # | Candidate | Evidence Type | Evidence Status | Problem | Verification Action | Impact | Dependencies | Sources |
|---|---|---|---|---|---|---|---|---|
| A | **Rule Management UI** | Documentation | **Confirmed** — direct references in 3 sources | No UI exists to create/reorder/administer rules | Confirm no equivalent UI is already implemented in `src/app` | High (UX/operations) | BRE-011 and BRE-012 closed | `docs/history/2026-07-stabilization.md`, `docs/architecture/rule-engine.md` (Next steps #5), `docs/adr/ADR-009-deterministic-rule-engine-contract.md` |
| B | **Fuzzy Matching** | Documentation + Code | **Confirmed (partial)** — `src/lib/accounting/fuzzy-matcher.ts` and `fuzzy-pre-filter.ts` exist; no evidence they participate in the active engine flow (grep: none import them) | Flexible matching (regex/pattern) over descriptions | Confirm whether `fuzzy-matcher.ts` participates in the active engine pipeline (or is an orphan module) | Medium/High | Stable engine contract | `docs/adr/ADR-009-deterministic-rule-engine-contract.md`, `docs/architecture/rule-engine.md` (Next steps #3), `src/lib/accounting/fuzzy-matcher.ts`, `src/lib/accounting/fuzzy-pre-filter.ts` |
| C | **Rollback / Rule Simulation** | Documentation | **Requires verification** — out-of-scope v2.2 | Evaluate effect of new rules before applying; revert errors | Confirm real dependency relationship with shadow metrics (`s7-05b`) and Policy Service (`s7-07`) | High (production) | Consolidated deterministic engine | `docs/adr/ADR-009-deterministic-rule-engine-contract.md`, `src/lib/services/rule-precedence-apply-all-resolver.ts` |
| D | **Dedicated Rule Engine Testing** | Documentation | **Requires verification** — mentioned as a "future suite" | Dedicated test suite for the engine | Measure current Rule Engine coverage before asserting a gap | Medium | No critical pending feature work | `docs/architecture/rule-engine.md` (Next steps #4), `docs/history/2026-07-stabilization.md` |
| E | **Security Finding 5.1 Production Verification** | Historical | **Requires verification** — cited from `docs/history/2026-07-stabilization.md`; current status not yet verified against `SECURITY_AUDIT.md` | Validate a security finding in production | Open `SECURITY_AUDIT.md` and verify the current state of finding 5.1 | High (operational) | Production environment | `SECURITY_AUDIT.md` (not verified), `docs/history/2026-07-stabilization.md` |

## How to use this index

1. Take a candidate.
2. Follow the **Sources**.
3. Run the **Verification Action** (confirms or discards items marked "Requires verification").
4. Build `01-explore.md` exclusively from confirmed evidence.

This keeps the candidate → source → verification → explore flow explicit and repeatable, per ADR-004 (evidence over assumptions).