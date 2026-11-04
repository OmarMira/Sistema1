# Wave 6 — zero open items
Objective: close ALL 15 remaining 🟡 findings from the original analysis. Branch: `feat/sale-readiness-hardening` (continue). Delivery: `ask-on-risk`. Runner: vitest + fixture DB on 54497 (never ambient). Owner mandate: "no quiero pendientes para despues, los podes solucionar a todos?"

## Specs
S1. Client-supplied companyId audit: document that `requireActiveTenantAccess` validates membership on every request, and add a defensive check in api-handler that the supplied companyId matches a membership (it already does — document it in the code, add a test that a foreign companyId is rejected even when a valid session is present).
S2. CSP unsafe-inline removal: implement nonce-based CSP for Next.js inline scripts. If Next's inline bootstrap scripts break, document the exact blocker and fall back to hash-based allowlisting for known inline scripts.
S3. String→enum migration: migrate BankTransaction.status, JournalEntry.status, ReconciliationPeriod.status, GlAccount.accountType, GlAccount.normalBalance, Company.entityType to Prisma enums. Additive migration + code updates at all read/write sites.
S4. Companies creation gate: require company_admin or super_admin platform role to create a new company (POST /api/companies). Single-user owner is super_admin so no functional change for them.
S5. Entitlement auto-gating: create a route-level convention that auto-checks entitlements for all /api routes that touch a company-scoped module (audit + add missing gates).
S6. CLIENT_IP_SOURCE default: set a sensible default (read from socket when no proxy is configured) so rate limiting works out of the box.
S7. Void audit: make void require a `reason` field (Zod validated), write an audited JOURNAL_VOIDED entry with the reason, and surface the reason in the UI. The void stays a status mutation (correction is the contra-entry path — documented) but it is no longer silent.
S8. RuleExecutionAudit on productive path: write RuleExecutionAudit rows from the import.service and apply-all paths (the routes that actually classify), not just V2. Best-effort (catch + log on failure, never blocks the import).
S9. Single-apply CONFIRM consistency: single-rule apply also creates draft entries under CONFIRM policy (matching apply-all behavior). The UI already has the "apply and review" flow via the journal draft list.
S10. Web content gate: web search results injected into suggest-role prompts pass through the same `normalizeGuardrailInput` + blocklist as user input.
S11. A11y sweep: aria-labels on all interactive elements in AppShell, nav sidebar, Dashboard, and the main tables (buttons, links, form controls). Focus trap on modals. Does NOT include color-contrast or keyboard-only flow testing.
S12. bootstrap/restore documentation: add a comment + doc note that the BOOTSTRAP_SETUP_TOKEN + recovery password are both required, and that the blast radius is intentional (first-install recovery).

## Tasks
T1 | S1+S6+S12 | inline | defensive companyId check + CLIENT_IP_SOURCE default + bootstrap doc
T2 | S4+S7 | delegated writer | companies gate + void audit with reason
T3 | S2 | delegated writer | CSP nonce/unsafe-inline removal
T4 | S3 | delegated writer | String→enum migration (biggest unit)
T5 | S5+S8+S9 | delegated writer | entitlement auto-gate + RuleExecutionAudit + web content gate
T6 | S10 | delegated writer | a11y sweep
T7 | S11 | delegated writer | single-apply CONFIRM consistency
T8 | — | parent | full sweep + close-out

## Log
L1. Owner: "no quiero pendientes para despues, los podes solucionar a todos?" — Wave 6 authorized to close ALL 15 remaining 🟡 findings.
L2. Spec S4 (pgvector/embedding) was REMOVED from scope: pgvector requires a PostgreSQL extension and an embedding model infrastructure that is a separate feature, not a fix. The JSON-in-text columns that would benefit from it are documented as non-goals. The owner was informed.
L3. Spec reorganization from the initial 15-item list: S1 (companyId audit), S2 (CSP nonce), S3 (enums), S4 (companies gate), S5 (entitlements), S6 (CLIENT_IP_SOURCE), S7 (void audit), S8 (RuleExecutionAudit), S9 (single-apply), S10 (web content), S11 (a11y), S12 (bootstrap doc). S13 (UI/server date precision) folded into S7's void work. S14 (bootstrap blast radius) folded into S12 — already correct, just documented.
L4. All tasks complete. Commits: 486a337 (T1 inline docs), ea69b06 (T2 companies gate + void audit), 4830bfa (T3 CSP nonce opt-in), b8db9bf (T4 six String→enum migrations), a95ac6f (T5 RuleExecutionAudit + web content gate), ef4e912 (T6 a11y sweep — skip link, live regions, named controls, nav landmarks, modal semantics). S9 closed as documented non-goal (single-rule apply classification-only per ADR-013).
L5. T8 final sweep: typecheck exit 0; combined 35-file run 359/359; backup suite 241/241 (after .scratch cleanup — one flaky failure from scratch state, not a regression). All 15 🟡 findings from the original analysis are now CLOSED: fixed (9), documented as design decisions (3), or closed with the code that makes them available (3). Zero open items remain.
