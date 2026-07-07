# Design: Company Knowledge Service

## Technical Approach

Central service module with four domain sub-modules mirroring the proposal's capabilities. Single polymorphic Prisma model (`CompanyKnowledge`) with `type` discriminator and JSON attribute column. All mutations route through an approval gate that returns un-applied records. An adapter layer bridges Knowledge ↔ EntityContext with no shared schema coupling. Entity Knowledge acts as Aggregate Root — all entity and relationship access goes through it.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|----------|--------|-------------|-----------|
| **Polymorphic storage** | Single `CompanyKnowledge` table, `type` enum discriminator, JSON attributes column | 5 separate tables, document DB | Relationships cross types — single table keeps joins trivial. Overhead negligible at 1K entities. |
| **Module structure** | `internal/company-knowledge/` with 4 sub-packages: `entity/`, `relationship/`, `integration/`, `audit/` | Monolithic service, micro-services | Mirrors 4 proposal capabilities. Entity is Aggregate Root; relationship + audit depend on it. Single deployable unit at this scale. |
| **Approval gate** | Creates `PendingApproval` record; returns un-applied. Caller commits after explicit approval. | Inline approval, event-driven async | Sync and API paths both need the gate — must be service-level, not API-level. Caller-committed pattern keeps both paths uniform. |
| **Sync naming** | `integration/` not `sync/` | `sync/` | Constraint #12 mandates `knowledge-integration`. Architecture is identical — rename only. |
| **EntityContext wiring** | Adapter contracts; physical sync deferred until EntityContext module exists | Eager wiring | EntityContext module doesn't exist yet. `EntityContextReader`/`EntityContextWriter` define the boundary. Orchestrator tested with mocked adapters. |
| **Origin metadata** | Embedded JSON column: `{knowledgeId, version, source, decisionReason, timestamp}` | Separate origin table, sparse columns | Origin always queried with entity — embedding avoids N+1. Controlled vocabulary enforced at service layer. |
| **Audit trail** | Append-only `KnowledgeAudit` table, one row per state transition | Event store, DB triggers, same-table columns | Append-only guarantees immutability. Separate table keeps main model lean. Version field ties to entity state machine. |
| **Versioning** | Increment `version` on every state transition (create, update, archive, restore, merge) | Timestamp-only, hash-based | Every transition visible in audit. Version is part of Origin — round-trips survive sync. |

## Data Flow

```
External (API / Sync Adapter)
        │
        ▼
┌─────────────────────────────────────────┐
│          entity-knowledge                │
│  ┌──────────┐   ┌──────────────┐        │
│  │ Entity   │   │ Relationship  │       │
│  │ Service  │◄──┤ Service       │       │
│  └────┬─────┘   └──────┬───────┘       │
│       │                │                │
│  ┌────▼─────┐    ┌─────▼──────┐        │
│  │Approval  │    │ Audit      │        │
│  │ Gate     │    │ Service    │        │
│  └────┬─────┘    └─────┬──────┘        │
└───────┼────────────────┼──────────────┘
        │                │
        ▼                ▼
 ┌──────────────┐  ┌──────────────┐
 │CompanyKnowledge │ KnowledgeAudit│
 │PendingApproval  │ (append-only) │
 └───────┬──────┘  └──────────────┘
         │
         ▼
┌────────────────────┐
│ knowledge-integration │
│ ┌──────────────────┐  │
│ │EntityContextReader│  │
│ └──────────────────┘  │
│ ┌──────────────────┐  │
│ │EntityContextWriter│  │
│ └──────────────────┘  │
└──────────────────────┘
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | Add `CompanyKnowledge`, `PendingApproval`, `KnowledgeAudit` models |
| `internal/company-knowledge/entity/types.ts` | Create | Entity types, Origin, DecisionReason, EntityType enums |
| `internal/company-knowledge/entity/service.ts` | Create | CRUD + approval gate + version bump + 1,000 cap check |
| `internal/company-knowledge/relationship/service.ts` | Create | Relationship CRUD routed through Entity Knowledge (Aggregate Root) |
| `internal/company-knowledge/integration/adapter.ts` | Create | `EntityContextReader`/`EntityContextWriter` — **contract interfaces only**; physical wiring deferred until EntityContext module exists |
| `internal/company-knowledge/integration/service.ts` | Create | Sync orchestrator + CompanyKnowledgeMatcher + explain(knowledgeId). Operates against adapter contracts, not concrete EntityContext. |
| `internal/company-knowledge/audit/service.ts` | Create | Append-only log + explainability API (`GET /audit/:knowledgeId`) |
| `internal/company-knowledge/audit/types.ts` | Create | Audit entry, explainability response types |
| `internal/company-knowledge/index.ts` | Create | Barrel exports, module boundary |
| `internal/entity-context/` | Deferred | EntityContextReader/Writer implementation — blocked until EntityContext module exists |

Also update the data flow description and the architecture decision for sync naming.

### Integration status
PR #3 delivers **contract integration** — adapters, matcher, orchestrator, and explainability all work against the defined interfaces. The physical `EntityContextReader`/`EntityContextWriter` implementations (Task 3.3) require the EntityContext module to exist. Until then, the outbound sync path pushes to a no-op adapter and inbound sync reads from an empty adapter. All sync logic is tested with mocked adapters.

## Interfaces / Contracts

```typescript
// Controlled vocabulary — per approved spec
type DecisionReason =
  | 'company_knowledge_confirmed'
  | 'company_knowledge_updated'
  | 'company_knowledge_merged'
  | 'entity_context_match'
  | 'bank_rule_match'
  | 'llm_suggestion'
  | 'manual_override'
  | 'fallback_default';

type EntityType = 'person' | 'company' | 'financial_product' | 'platform' | 'asset';
type KnowledgeSource = 'company_knowledge' | 'entity_context' | 'llm';
type EntityStatus = 'active' | 'archived' | 'merged';

// Entity Knowledge — Aggregate Root (constraint #1, #14)
interface CompanyKnowledge {
  id: string;
  companyId: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  relationship: string;  // single business relationship value
  metadata: Record<string, unknown>;  // Zod-validated per type
  source: 'user_confirmed' | 'correction' | 'system_suggested' | 'csv_import';
  status: EntityStatus;
  mergedInto?: string;   // only when status = merged
  version: number;       // constraint #11
}

// Explainability payload — per spec contract
interface ExplainabilityPayload {
  source: KnowledgeSource;
  knowledgeId: string;
  canonicalName: string;
  relationship: string;
  version: number;
  decisionReason: DecisionReason;
  confidence?: number;  // present when source ≠ company_knowledge
}

// Approval gate — constraint #4
interface PendingApproval {
  id: string;
  knowledgeId: string;
  action: 'create' | 'update' | 'archive' | 'restore' | 'merge';
  payload: Partial<CompanyKnowledge>;
  requestedBy: string;
  requestedAt: Date;
  status: 'pending' | 'approved' | 'rejected';
}

// Merge — constraint #6, #10
interface MergeRequest {
  sourceKnowledgeId: string;
  targetKnowledgeId: string;
  fieldResolutions: Record<string, unknown>;  // user resolves EVERY field
}

// Audit entry — append-only
interface KnowledgeAuditEntry {
  id: string;
  knowledgeId: string;
  action: 'created' | 'updated' | 'archived' | 'restored' | 'merged';
  version: number;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  changedByUserId: string;
  timestamp: Date;
  source: string;
  reason: string;
}

// Integration adapters
interface EntityContextReader {
  pull(companyId: string): Promise<EntityContextEntry[]>;
}
interface EntityContextWriter {
  push(companyId: string, bias: DetectionBias): Promise<void>;
}
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | Entity CRUD, approval lifecycle, version bumps, 1,000 cap | Vitest, mock Prisma |
| Unit | Relationship CRUD through Aggregate Root | Vitest, mock entity service |
| Unit | Audit append-only, explainability query | Vitest, mock Prisma |
| Unit | DecisionReason values match across Prisma enum ↔ Zod schema | Vitest, compile-time consistency test |
| Unit | Integration adapter interface contracts | Vitest, test doubles |
| Integration | Approval gate (create→approve→commit, reject) | Testcontainers + Prisma |
| Integration | Merge flow (field-by-field, cross-company rejection) | Testcontainers + Prisma |
| Integration | Audit immutability (no UPDATE/DELETE) | Prisma middleware enforcement tests |
| E2E | Sync round-trip with origin preservation | Docker Compose + API tests |
| E2E | Archive/restore lifecycle | API tests |

## Migration / Rollout

Greenfield — no migration required. Deploy module alongside EntityContext sync hooks behind a feature flag (default: off). Activate sync only after approval endpoints are verified.

## Closed Questions

### DecisionReason: Prisma enum + Zod enforcement

**Resolution**: Both layers.

1. **Prisma enum** `DecisionReason` — ensures no invalid value ever reaches the database, even via raw queries or migrations.
2. **Zod schema** in `entity/service.ts` — validates every write at the service boundary. A dedicated test enforces that the Zod union matches the Prisma enum values, catching drift.

### EntityContextReader / EntityContextWriter: explicit contracts

```typescript
// EntityContext never imports Company Knowledge types.
// Contracts live in internal/company-knowledge/integration/adapter.ts.

interface EntityContextEntry {
  id: string;
  companyId: string;
  rawName: string;
  contextHints: Record<string, unknown>;  // type-specific metadata from account/GL
}

interface DetectionBias {
  knowledgeId: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  relationship: string;
  decisionReason: DecisionReason;
}

interface EntityContextReader {
  pull(companyId: string): Promise<EntityContextEntry[]>;
}

interface EntityContextWriter {
  push(companyId: string, bias: DetectionBias): Promise<void>;
}
```

### PendingApproval: no expiry in Fase 1

**Resolution**: Fase 1 uses manual approve/reject only. Expiry requires a scheduled job (Cron, pg_cron, or worker), adds Pending → Rejected state transitions, and introduces edge cases (what happens if the entity was already committed by other means?). None of this provides value at launch — the domain spec says "human approval required," not "human approval within N hours." Revisit in a future phase if real workflows demand it.
