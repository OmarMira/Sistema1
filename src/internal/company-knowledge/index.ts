// Barrel exports — Company Knowledge module boundary

// Types (public)
export * from './entity/types';

// Metadata schemas (public — for external validation)
export * from './entity/metadata-schemas';

// Entity service (public — Aggregate Root)
export {
  proposeCreate,
  confirmCreate,
  proposeUpdate,
  confirmUpdate,
  archive,
  restore,
  merge,
} from './entity/service';

export type {
  ProposeCreateInput,
  ConfirmCreateInput,
  ProposeUpdateInput,
  ConfirmUpdateInput,
  ArchiveInput,
  RestoreInput,
  MergeInput,
} from './entity/service';

// Relationship types (public — values and schema)
export { RelationshipValues, relationshipSchema } from './relationship/types';
export type { Relationship } from './relationship/types';

// Relationship service is NOT exported — it's internal-only, routed through Entity Knowledge.

// ───────────────────────────────────────────────
// Integration — adapters, matcher, sync orchestrator
// ───────────────────────────────────────────────

export type {
  EntityContextEntry,
  DetectionBias,
  EntityContextReader,
  EntityContextWriter,
} from './integration/adapter';

export { CompanyKnowledgeMatcher, characterBigramJaccard } from './integration/matcher';
export type { MatchResult } from './integration/matcher';

export { SyncOrchestrator, inferEntityType } from './integration/service';
export type {
  ExplainabilityPayload,
  SyncOrchestratorOptions,
  SyncResult,
} from './integration/service';

// Audit
export { getAuditTrail, getExplainabilityPayload } from './audit/service';
export type { KnowledgeAuditEntry, ExplainabilityResponse } from './audit/types';
