# Tasks: Company Knowledge Service

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 800–1,200 |
| 400-line budget risk | Medium |
| Chained PRs recommended | Yes |
| Suggested split | 4 PRs (persistence → services → integration → audit) |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: Medium

**Rule: each PR must compile and pass all its tests independently. No PR depends on WIP code from a later PR.**

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Prisma models + entity types | PR 1 | Base for all services |
| 2 | Entity + Relationship services | PR 2 | Depends on PR 1 |
| 3 | Integration adapters + sync orchestrator | PR 3 | Depends on PR 2 |
| 4 | Audit + explainability + barrel exports | PR 4 | Depends on PR 2 |
| 5 | UI | TBD | Out of scope for backend Fase 1 |

## Phase 1: Persistence & Enums

- [x] 1.1 Add `CompanyKnowledge`, `PendingApproval`, `KnowledgeAudit` models with enums and relations to `prisma/schema.prisma`
- [x] 1.2 Create `internal/company-knowledge/entity/types.ts` — `EntityType`, `DecisionReason` enums, Origin interface, Zod schemas
- [x] 1.3 Write consistency test: Prisma enum values match TypeScript union + Zod enum for `EntityType` and `DecisionReason`

## Phase 2: Entity & Relationship Services

- [x] 2.1 Create `internal/company-knowledge/entity/service.ts` — CRUD, approval gate (creates PendingApproval, returns un-applied), version bump on every transition, 1,000 active cap check
- [x] 2.2 Create `internal/company-knowledge/relationship/service.ts` — relationship CRUD routed through Entity Knowledge as Aggregate Root
- [x] 2.3 Write entity service unit tests (approval lifecycle, cap enforcement, version increment, archive/restore)
- [x] 2.4 Write relationship service unit tests (CRUD through Aggregate Root, origin propagation)

## Phase 3: Contract Integration (Adapters & Orchestrator)

- [x] 3.1 Create `internal/company-knowledge/integration/adapter.ts` — `EntityContextReader` and `EntityContextWriter` interfaces
- [x] 3.2 Create `internal/company-knowledge/integration/service.ts` — sync orchestrator (inbound/outbound/onConfirm/onArchive/onMerge) + CompanyKnowledgeMatcher (bigram Jaccard, 4-tier) + explain(knowledgeId)
- [~] 3.3 ~~Modify `internal/entity-context/`~~ → **Deferred: EntityContext module does not exist yet. `EntityContextReader`/`EntityContextWriter` contracts define the future integration boundary. Physical wiring happens when EntityContext is built.**
- [x] 3.4 Write integration tests: duplicate prevention (matcher), sync round-trip (mocked), cross-company merge rejection, explainability payload

## Phase 4: Audit & Explainability

- [x] 4.1 Create `internal/company-knowledge/audit/types.ts` — `KnowledgeAuditEntry`, `ExplainabilityResponse` interfaces
- [x] 4.2 Create `internal/company-knowledge/audit/service.ts` — append-only log on every state transition + `explain(knowledgeId)` returning full provenance
- [x] 4.3 Create `internal/company-knowledge/index.ts` — barrel exports for all public types and services
- [x] 4.4 Write audit service tests: immutability (no UPDATE/DELETE), explainability query returns full audit chain

## Phase 5: UI

- [x] 5.1 UI implementation — administration pages for Company Knowledge
