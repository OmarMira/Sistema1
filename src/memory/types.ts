// Memory Core — TypeScript Types (C1-C11)
// Generated from design v4

import type {
  MemoryItem as PrismaMemoryItem,
  MemoryVersion as PrismaMemoryVersion,
  Relationship as PrismaRelationship,
  Contradiction as PrismaContradiction,
  EvolutionLink as PrismaEvolutionLink,
  TraceabilityLog as PrismaTraceabilityLog,
  ConfidenceLog as PrismaConfidenceLog,
  MemoryStatus,
  ConfidenceLevel,
} from '@prisma/client';

// ─── Re-export Prisma types ─────────────────────────────────────────

export type {
  PrismaMemoryItem,
  PrismaMemoryVersion,
  PrismaRelationship,
  PrismaContradiction,
  PrismaEvolutionLink,
  PrismaTraceabilityLog,
  PrismaConfidenceLog,
  MemoryStatus,
  ConfidenceLevel,
};

// ─── Enums ──────────────────────────────────────────────────────────

export const MEMORY_STATUS = {
  ACTIVE: 'active',
  FORGOTTEN: 'forgotten',
} as const;

export const CONFIDENCE_LEVEL = {
  CERTAIN: 'certain',
  TENTATIVE: 'tentative',
  UNCERTAIN: 'uncertain',
} as const;

export const EVOLUTION_LINK_TYPE = {
  SUPERSEDES: 'supersedes',
  COMPLEMENTS: 'complements',
} as const;

export const TRACEABILITY_ACTION = {
  RECORDED: 'recorded',
  UPDATED: 'updated',
  RELATED: 'related',
  SUPERSEDED: 'superseded',
  FORGOTTEN: 'forgotten',
} as const;

// ─── Input DTOs ─────────────────────────────────────────────────────

/** C1 — Record input */
export interface RecordInput {
  content: string;
  type: string;
  companyId: string;
  sourceAuthor: string;
  sourceName: string;
  sourceObservedAt?: Date;
  confidence?: ConfidenceLevel;
}

/** C3 — Relate input */
export interface RelateInput {
  sourceId: string;
  targetId: string;
  label: string;
}

/** C4 — Update input */
export interface UpdateInput {
  id: string;
  content: string;
}

/** C7 — Verify consistency input */
export interface VerifyConsistencyInput {
  itemAId: string;
  itemBId: string;
}

/** C9 — Evolve input */
export interface EvolveInput {
  currentId: string;
  newContent: string;
  supersededById: string;
  linkType?: 'supersedes' | 'complements';
}

/** C10 — Forget input */
export interface ForgetInput {
  id: string;
  reason: string;
}

/** C11 — Update confidence input */
export interface UpdateConfidenceInput {
  id: string;
  newLevel: ConfidenceLevel;
  reason: string;
}

// ─── Output DTOs ────────────────────────────────────────────────────

/** C7 — Contradiction detection result */
export interface ContradictionResult {
  isContradiction: boolean;
  evidence: string;
  confidence: number;
  type: 'negation' | 'claim_value' | 'none';
}

/** C2 — Search result with ranking */
export interface SearchResult {
  item: PrismaMemoryItem;
  rank: number;
}

// ─── Source metadata ────────────────────────────────────────────────

export interface SourceMetadata {
  author: string;
  name: string;
  observedAt?: Date;
}
