import 'server-only';

// Server-only surface for Company Knowledge.
// Services, persistence, audit and integration must not reach Client Components.

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

export { RelationshipValues, relationshipSchema } from './relationship/types';
export type { Relationship } from './relationship/types';

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

export { getAuditTrail, getExplainabilityPayload } from './audit/service';
export type { KnowledgeAuditEntry, ExplainabilityResponse } from './audit/types';