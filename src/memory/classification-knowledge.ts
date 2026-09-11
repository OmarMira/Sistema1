// Knowledge Engine — Classification Knowledge
// Read/write layer for transaction classification patterns.
// Uses existing MemoryService (C1-C11) without modifying PR2.
// Pattern: description normalization → glAccountId mapping per company.

import type { ConfidenceLevel } from '@prisma/client';
import { MemoryAdapter } from './adapter';
import type { MemoryPrismaClient, TransactionRunner } from './prisma-types';

// ─── Content format ─────────────────────────────────────────────

export interface ClassificationContent {
  /** Normalized bank description pattern */
  pattern: string;
  /** GL account to assign when matched */
  glAccountId: string;
  /** Transaction direction hint */
  direction: 'debit' | 'credit' | 'any';
  /** What produced this knowledge */
  source: 'user_correction' | 'import_correction';
  /** Original transaction ID for traceability */
  transactionId?: string;
  /** Entity identity reference (CompanyKnowledge.id) — Phase 2: entity→treatment */
  entityId?: string;
}

const TYPE = 'classification';

// ─── Adapter factory (type-safe boundary) ───────────────────────

/**
 * Create a MemoryAdapter from the project's Prisma client.
 * Accepts any client that satisfies the MemoryPrismaClient contract,
 * including the extended client returned by $extends().
 *
 * @param client - The Prisma client (satisfies MemoryPrismaClient)
 * @param runTx - Transaction runner, typically `(fn) => db.$transaction(fn)`
 */
export function createAdapter(client: MemoryPrismaClient, runTx: TransactionRunner): MemoryAdapter {
  return new MemoryAdapter(client, runTx);
}

// ─── Normalization ──────────────────────────────────────────────

/** Normalize a bank description for matching. */
export function normalizeDescription(raw: string): string {
  return raw
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .substring(0, 200);
}

// ─── Result types ───────────────────────────────────────────────

export interface LearnSuccess {
  ok: true;
  action: 'recorded' | 'updated' | 'no_op';
  itemId: string;
}

export interface LearnFailure {
  ok: false;
  error: string;
}

export type LearnResult = LearnSuccess | LearnFailure;

// ─── Write ──────────────────────────────────────────────────────

/**
 * Learn from a confirmed user correction.
 *
 * Identity: companyId + type + normalized pattern = one logical item.
 *
 * First correction: record() → new MemoryItem (C1).
 * Same classification again: no-op.
 * Different classification for same pattern: update() → C4/C5
 *   (preserves previous version in append-only version history).
 *
 * Returns a result indicating what happened. Never throws.
 * Caller decides policy on failure.
 */
export async function learnFromCorrection(
  adapter: MemoryAdapter,
  companyId: string,
  description: string,
  glAccountId: string,
  direction: 'debit' | 'credit' | 'any',
  transactionId: string,
): Promise<LearnResult> {
  try {
    const pattern = normalizeDescription(description);
    if (!pattern) {
      return { ok: false, error: 'empty_pattern' };
    }

    const content: ClassificationContent = {
      pattern,
      glAccountId,
      direction,
      source: 'user_correction',
      transactionId,
    };
    const contentStr = JSON.stringify(content);

    // C2: Check if exact content already exists (same pattern + same GL)
    const existing = await adapter.getExactContent(companyId, contentStr);
    if (existing) {
      return { ok: true, action: 'no_op', itemId: existing.id };
    }

    // C2: Find existing item with same pattern (deterministic via getByType)
    const allClassifications = await adapter.getByType(companyId, TYPE);
    const samePattern = allClassifications.find((item) => {
      if (item.status !== 'active') return false;
      try {
        const parsed = JSON.parse(item.content) as ClassificationContent;
        return parsed.pattern === pattern;
      } catch {
        return false;
      }
    });

    if (samePattern) {
      const existingContent = JSON.parse(samePattern.content) as ClassificationContent;

      if (existingContent.glAccountId === glAccountId) {
        // Same classification — no-op
        return { ok: true, action: 'no_op', itemId: samePattern.id };
      }

      // Different classification for same pattern — C4/C5: update + version
      // The previous content is preserved in MemoryVersion (append-only)
      await adapter.update(samePattern.id, contentStr, companyId);
      return { ok: true, action: 'updated', itemId: samePattern.id };
    }

    // New pattern — C1: record
    const item = await adapter.record({
      content: contentStr,
      type: TYPE,
      companyId,
      sourceAuthor: 'user',
      sourceName: 'correction',
      sourceObservedAt: new Date(),
      confidence: 'tentative',
    });
    return { ok: true, action: 'recorded', itemId: item.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── Entity-Aware Learning (Phase 3) ────────────────────────────

export interface EntityLearnCreated {
  status: 'CREATED';
  itemId: string;
}

export interface EntityLearnUnchanged {
  status: 'UNCHANGED';
  itemId: string;
}

export interface EntityLearnUpdated {
  status: 'UPDATED';
  itemId: string;
}

export interface EntityLearnAmbiguous {
  status: 'ERROR';
  reason: string;
}

export type EntityLearnResult = EntityLearnCreated | EntityLearnUnchanged | EntityLearnUpdated | EntityLearnAmbiguous;

/**
 * Learn or correct the accounting treatment for a known entity.
 *
 * Identity: companyId + entityId = one logical treatment.
 *
 * Behavior:
 *   0 active treatments → CREATED (C1: new MemoryItem with entityId)
 *   1 active, same GL + direction → UNCHANGED (no-op)
 *   1 active, different GL or direction → UPDATED (C4/C5: update + version)
 *   >1 active → ERROR (ambiguous, nothing modified)
 *
 * Treatment equality: glAccountId + direction.
 * source and transactionId are metadata, not part of treatment identity.
 *
 * Does NOT call AI, read EntityContext, or invoke the rule engine.
 * Does NOT require a pattern/description for identity.
 *
 * @param adapter - MemoryAdapter for data access
 * @param companyId - Tenant scope (mandatory)
 * @param entityId - Entity identity from CompanyKnowledge (mandatory)
 * @param glAccountId - GL account to assign (mandatory)
 * @param direction - Transaction direction (mandatory)
 * @param source - What produced this knowledge
 * @param transactionId - Optional original transaction ID
 * @returns EntityLearnResult: CREATED, UNCHANGED, UPDATED, or ERROR
 */
export async function learnEntityTreatment(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  glAccountId: string,
  direction: 'debit' | 'credit' | 'any',
  source: 'user_correction' | 'import_correction',
  transactionId?: string,
): Promise<EntityLearnResult> {
  if (!companyId || typeof companyId !== 'string') {
    return { status: 'ERROR', reason: 'Invalid companyId' };
  }

  if (!entityId || typeof entityId !== 'string') {
    return { status: 'ERROR', reason: 'Invalid entityId' };
  }

  if (!glAccountId || typeof glAccountId !== 'string') {
    return { status: 'ERROR', reason: 'Invalid glAccountId' };
  }

  if (!direction || !['debit', 'credit', 'any'].includes(direction)) {
    return { status: 'ERROR', reason: 'Invalid direction' };
  }

  try {
    // C2: deterministic lookup — all classification items for this company
    const allClassifications = await adapter.getByType(companyId, TYPE);

    // Collect ALL active items matching this entityId
    const matches: Array<{ id: string; content: ClassificationContent }> = [];

    for (const item of allClassifications) {
      if (item.status !== 'active') continue;

      try {
        const content = JSON.parse(item.content) as ClassificationContent;
        if (content.entityId === entityId) {
          matches.push({ id: item.id, content });
        }
      } catch {
        // Malformed content — skip
      }
    }

    // Multiple active treatments → ambiguous, don't touch
    if (matches.length > 1) {
      return {
        status: 'ERROR',
        reason: `Ambiguous active treatment for entity ${entityId}: ${matches.length} active treatments found`,
      };
    }

    const newContent: ClassificationContent = {
      pattern: '',
      glAccountId,
      direction,
      source,
      transactionId,
      entityId,
    };
    const newContentStr = JSON.stringify(newContent);

    // Zero matches → CREATED
    if (matches.length === 0) {
      const item = await adapter.record({
        content: newContentStr,
        type: TYPE,
        companyId,
        sourceAuthor: 'user',
        sourceName: source === 'user_correction' ? 'correction' : 'import',
        sourceObservedAt: new Date(),
        confidence: 'tentative',
      });
      return { status: 'CREATED', itemId: item.id };
    }

    // Exactly one match — check treatment equality
    const current = matches[0];

    if (current.content.glAccountId === glAccountId && current.content.direction === direction) {
      // Same treatment → UNCHANGED
      return { status: 'UNCHANGED', itemId: current.id };
    }

    // Different treatment → UPDATED (C4/C5)
    await adapter.update(current.id, newContentStr, companyId);
    return { status: 'UPDATED', itemId: current.id };
  } catch (error) {
    return {
      status: 'ERROR',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Read ───────────────────────────────────────────────────────

export interface KEHit {
  kind: 'hit';
  glAccountId: string;
  direction: 'debit' | 'credit' | 'any';
  confidence: ConfidenceLevel;
  itemId: string;
}

export interface KEMiss {
  kind: 'miss';
}

export type KEHitOrMiss = KEHit | KEMiss;

/**
 * Look up classification knowledge before the rule engine.
 *
 * Deterministic lookup: getByType (C2) → in-memory pattern filter.
 * Does NOT depend on pg_trgm similarity ranking.
 *
 * Returns KEHit if a known pattern matches, KEMiss otherwise.
 */
export async function lookupClassification(
  adapter: MemoryAdapter,
  companyId: string,
  description: string,
): Promise<KEHit | KEMiss> {
  const pattern = normalizeDescription(description);
  if (!pattern) return { kind: 'miss' };

  // C2: deterministic lookup — all classification items for this company
  const allClassifications = await adapter.getByType(companyId, TYPE);

  for (const item of allClassifications) {
    if (item.status !== 'active') continue;

    try {
      const content = JSON.parse(item.content) as ClassificationContent;
      if (content.pattern === pattern) {
        return {
          kind: 'hit',
          glAccountId: content.glAccountId,
          direction: content.direction,
          confidence: item.confidence as ConfidenceLevel,
          itemId: item.id,
        };
      }
    } catch {
      // Malformed content — skip
    }
  }

  return { kind: 'miss' };
}

// ─── Classification Observations (GENERALIZACIÓN-002) ─────────────

export const OBSERVATION_TYPE = 'classification_observation';

/**
 * Observation content stored in MemoryItem.content JSON.
 * Represents one confirmed classification observation for an entity.
 */
export interface ClassificationObservation {
  /** Entity identity reference (CompanyKnowledge.id) */
  entityId: string;
  /** Original bank transaction description — preserved, not normalized */
  originalDescription: string;
  /** GL account confirmed for this observation */
  glAccountId: string;
  /** Transaction direction confirmed for this observation */
  direction: 'debit' | 'credit' | 'any';
  /** What produced this observation */
  source: 'user_correction' | 'import_correction';
  /** Original transaction ID for traceability */
  transactionId?: string;
}

/**
 * Result of recording a classification observation.
 */
export interface ObservationRecordResult {
  ok: true;
  observationId: string;
}

export interface ObservationRecordFailure {
  ok: false;
  error: string;
}

export type ObservationRecordOutput = ObservationRecordResult | ObservationRecordFailure;

/**
 * Record a classification observation independently of treatment learning.
 *
 * A new observation is recorded even when the treatment is UNCHANGED,
 * because an additional observation constitutes new evidence.
 *
 * Identity: MemoryItem.id is unique per observation.
 * Two transactions with identical descriptions produce two separate observations.
 * Idempotency: same transactionId + same companyId → returns existing observation.
 *
 * @param adapter - MemoryAdapter for data access
 * @param companyId - Tenant scope (mandatory)
 * @param observation - The observation data to persist
 * @returns ObservationRecordResult with the observation's MemoryItem ID
 */
export async function recordClassificationObservation(
  adapter: MemoryAdapter,
  companyId: string,
  observation: ClassificationObservation,
): Promise<ObservationRecordOutput> {
  try {
    if (!companyId || typeof companyId !== 'string') {
      return { ok: false, error: 'Invalid companyId' };
    }
    if (!observation.entityId || typeof observation.entityId !== 'string') {
      return { ok: false, error: 'Invalid entityId' };
    }
    if (!observation.originalDescription || typeof observation.originalDescription !== 'string') {
      return { ok: false, error: 'Invalid originalDescription' };
    }
    if (!observation.glAccountId || typeof observation.glAccountId !== 'string') {
      return { ok: false, error: 'Invalid glAccountId' };
    }

    const contentStr = JSON.stringify(observation);

    // Idempotency: if same transactionId already recorded for this company, return existing
    if (observation.transactionId) {
      const existing = await adapter.getExactContent(companyId, contentStr);
      if (existing) {
        return { ok: true, observationId: existing.id };
      }
    }

    // C1: record new observation
    const item = await adapter.record({
      content: contentStr,
      type: OBSERVATION_TYPE,
      companyId,
      sourceAuthor: observation.source === 'user_correction' ? 'user' : 'system',
      sourceName: observation.source,
      sourceObservedAt: new Date(),
      confidence: 'tentative',
    });

    return { ok: true, observationId: item.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Retrieve all classification observations for a specific entity within a tenant.
 *
 * Returns observations in order of creation (oldest first).
 * Respects tenant isolation — only returns observations for the given companyId.
 * Preserves original descriptions (not normalized).
 *
 * @param adapter - MemoryAdapter for data access
 * @param companyId - Tenant scope (mandatory)
 * @param entityId - Entity identity to retrieve observations for (mandatory)
 * @returns Array of ClassificationObservation with metadata
 */
export async function getClassificationObservations(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
): Promise<ClassificationObservation[]> {
  if (!companyId || typeof companyId !== 'string') {
    return [];
  }
  if (!entityId || typeof entityId !== 'string') {
    return [];
  }

  try {
    // C2: deterministic lookup — all observation items for this company
    const allObservations = await adapter.getByType(companyId, OBSERVATION_TYPE);

    const results: ClassificationObservation[] = [];

    for (const item of allObservations) {
      if (item.status !== 'active') continue;

      try {
        const content = JSON.parse(item.content) as ClassificationObservation;
        if (content.entityId === entityId) {
          results.push(content);
        }
      } catch {
        // Malformed content — skip
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ─── Structural Candidates (GENERALIZACIÓN-003) ──────────────────
//
// Engine logic, NOT business knowledge. The algorithm below discovers
// deterministic structural segments (stable / variable) from confirmed
// classification observations. It never assigns meaning to a segment;
// it only reports what stayed equal and what changed across observations
// of the same company + entity + treatment (glAccountId + direction).
//
// No candidate produces classification authority: nothing in this file
// writes to the 'classification' type, and no operational flow calls it.
//
// Provenance chain: StructuralCandidate → observationIds
//   → getClassificationObservations / records → original descriptions
//   → confirmed treatments.

export const STRUCTURAL_CANDIDATE_TYPE = 'classification_structural_candidate';

/** Group key — observations compared by this exact treatment identity. */
export interface StructuralGroupKey {
  companyId: string;
  entityId: string;
  glAccountId: string;
  direction: 'debit' | 'credit' | 'any';
}

export type StructuralSegment =
  | { kind: 'stable'; value: string }
  | { kind: 'variable'; evidence: string[] };

/** Persisted candidate content (MemoryItem.content JSON, fixed field order). */
export interface StructuralCandidateContent {
  companyId: string;
  entityId: string;
  glAccountId: string;
  direction: 'debit' | 'credit' | 'any';
  segments: StructuralSegment[];
  observationIds: string[];
}

/** Generic normalization: trim + collapse whitespace + case folding ONLY. */
function normalizeTokensForStructure(description: string): string[] {
  const normalized = description.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized === '') return [];
  return normalized.split(' ');
}

export interface ObservationEvidenceInput {
  observationId: string;
  originalDescription: string;
}

export type StructuralDiscoveryOutput =
  | { kind: 'candidate'; segments: StructuralSegment[]; observationIds: string[] }
  | { kind: 'none'; reason: string };

/**
 * Pure structural discovery — deterministic, no DB, no business semantics.
 *
 * Conservative rules:
 * - Needs >= 2 observations to compare (with 1 there is nothing to differ).
 * - All descriptions must have the same token count; otherwise NO candidate.
 * - A position is STABLE when every observation has the same token there;
 *   otherwise VARIABLE with distinct observed tokens as evidence (first
 *   appearance order).
 * - Zero STABLE positions → NO candidate: there is no reusable anchor.
 * - The output never assigns meaning to any segment.
 */
export function discoverStructuralCandidate(
  observations: ObservationEvidenceInput[],
): StructuralDiscoveryOutput {
  if (!Array.isArray(observations) || observations.length === 0) {
    return { kind: 'none', reason: 'no_observations' };
  }
  if (observations.length === 1) {
    return { kind: 'none', reason: 'single_observation' };
  }

  const tokenizations = observations.map((o) => normalizeTokensForStructure(o.originalDescription));
  const length = tokenizations[0].length;
  for (let i = 1; i < tokenizations.length; i++) {
    if (tokenizations[i].length !== length) {
      return { kind: 'none', reason: 'inconsistent_token_length' };
    }
  }

  const segments: StructuralSegment[] = [];
  let hasStableSegment = false;

  for (let position = 0; position < length; position++) {
    const distinctValues: string[] = [];
    for (const tokens of tokenizations) {
      if (!distinctValues.includes(tokens[position])) {
        distinctValues.push(tokens[position]);
      }
    }
    if (distinctValues.length === 1) {
      hasStableSegment = true;
      segments.push({ kind: 'stable', value: distinctValues[0] });
    } else {
      segments.push({ kind: 'variable', evidence: distinctValues });
    }
  }

  if (!hasStableSegment) {
    return { kind: 'none', reason: 'no_stable_segments' };
  }

  return {
    kind: 'candidate',
    segments,
    observationIds: observations.map((o) => o.observationId),
  };
}

export interface ClassificationObservationRecord {
  /** MemoryItem id of the observation (provenance anchor) */
  id: string;
  observation: ClassificationObservation;
}

function isValidClassificationObservation(content: unknown): content is ClassificationObservation {
  if (!isRecord(content)) return false;
  if (typeof content.entityId !== 'string' || content.entityId === '') return false;
  if (typeof content.originalDescription !== 'string' || content.originalDescription === '') return false;
  if (typeof content.glAccountId !== 'string' || content.glAccountId === '') return false;
  if (content.direction !== 'debit' && content.direction !== 'credit' && content.direction !== 'any') return false;
  if (content.source !== 'user_correction' && content.source !== 'import_correction') return false;
  if (content.transactionId !== undefined && content.transactionId !== null && typeof content.transactionId !== 'string') return false;
  return true;
}

/**
 * Retrieve active classification observations WITH their MemoryItem ids,
 * so discovery can preserve exact provenance (candidate → observation ids).
 * Tenant-isolated: companyId is mandatory and enforced by the adapter.
 */
export async function getClassificationObservationRecords(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
): Promise<ClassificationObservationRecord[]> {
  if (!companyId || typeof companyId !== 'string') return [];
  if (!entityId || typeof entityId !== 'string') return [];

  try {
    const items = await adapter.getByType(companyId, OBSERVATION_TYPE);
    const results: ClassificationObservationRecord[] = [];
    for (const item of items) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (!isValidClassificationObservation(parsed)) continue;
        if (parsed.entityId === entityId) {
          results.push({ id: item.id, observation: parsed });
        }
      } catch {
        // Malformed content — skip
      }
    }
    return results;
  } catch {
    return [];
  }
}

export type GroupDiscoveryOutput =
  | { kind: 'candidate'; candidate: StructuralCandidateContent }
  | { kind: 'none'; reason: string };

/**
 * Discover a structural candidate over one compatible observation group.
 * Group key: companyId (tenant) + entityId + glAccountId + direction.
 * Observations outside the group (different entity / treatment / company)
 * never participate — mixed-treatment groups are preserved separately.
 */
export async function discoverStructuralCandidateForGroup(
  adapter: MemoryAdapter,
  key: StructuralGroupKey,
): Promise<GroupDiscoveryOutput> {
  try {
    const records = await getClassificationObservationRecords(
      adapter,
      key.companyId,
      key.entityId,
    );
    const group = records.filter(
      (r) => r.observation.glAccountId === key.glAccountId && r.observation.direction === key.direction,
    );

    const discovery = discoverStructuralCandidate(
      group.map((g) => ({
        observationId: g.id,
        originalDescription: g.observation.originalDescription,
      })),
    );

    if (discovery.kind === 'none') {
      return { kind: 'none', reason: discovery.reason };
    }

    return {
      kind: 'candidate',
      candidate: {
        companyId: key.companyId,
        entityId: key.entityId,
        glAccountId: key.glAccountId,
        direction: key.direction,
        segments: discovery.segments,
        observationIds: discovery.observationIds,
      },
    };
  } catch (error) {
    return {
      kind: 'none',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export type CandidateRecordResult =
  | { ok: true; candidateId: string }
  | { ok: false; error: string };

/**
 * Persist a structural candidate as MemoryItem type
 * 'classification_structural_candidate'. Candidate carries NO authority:
 * it is stored as diagnostic evidence only.
 *
 * Idempotency: same deterministic content (same group key, same segments,
 * same observationIds) → returns the existing candidate id.
 */
export async function recordStructuralCandidate(
  adapter: MemoryAdapter,
  candidate: StructuralCandidateContent,
): Promise<CandidateRecordResult> {
  try {
    if (!candidate.companyId || typeof candidate.companyId !== 'string') {
      return { ok: false, error: 'Invalid companyId' };
    }
    if (!candidate.entityId || typeof candidate.entityId !== 'string') {
      return { ok: false, error: 'Invalid entityId' };
    }
    if (!candidate.glAccountId || typeof candidate.glAccountId !== 'string') {
      return { ok: false, error: 'Invalid glAccountId' };
    }
    if (!candidate.direction || typeof candidate.direction !== 'string') {
      return { ok: false, error: 'Invalid direction' };
    }
    if (!Array.isArray(candidate.segments) || candidate.segments.length === 0) {
      return { ok: false, error: 'Invalid segments' };
    }
    if (!Array.isArray(candidate.observationIds) || candidate.observationIds.length === 0) {
      return { ok: false, error: 'Invalid observationIds' };
    }

    // Fixed field order → deterministic content string for idempotency
    const contentStr = JSON.stringify({
      companyId: candidate.companyId,
      entityId: candidate.entityId,
      glAccountId: candidate.glAccountId,
      direction: candidate.direction,
      segments: candidate.segments,
      observationIds: candidate.observationIds,
    });

    const existing = await adapter.getExactContent(candidate.companyId, contentStr);
    if (existing) {
      return { ok: true, candidateId: existing.id };
    }

    const item = await adapter.record({
      content: contentStr,
      type: STRUCTURAL_CANDIDATE_TYPE,
      companyId: candidate.companyId,
      sourceAuthor: 'system',
      sourceName: 'structural_discovery',
      sourceObservedAt: new Date(),
      confidence: 'tentative',
    });

    return { ok: true, candidateId: item.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Retrieve structural candidates for an entity within a tenant.
 * Tenant isolation and entity isolation are enforced here.
 * Candidates are diagnostic evidence only — they are NOT consulted by
 * any classification/production flow.
 */
export async function getStructuralCandidates(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
): Promise<StructuralCandidateContent[]> {
  if (!companyId || typeof companyId !== 'string') return [];
  if (!entityId || typeof entityId !== 'string') return [];

  try {
    const items = await adapter.getByType(companyId, STRUCTURAL_CANDIDATE_TYPE);
    const results: StructuralCandidateContent[] = [];
    for (const item of items) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (!isValidStructuralCandidateContent(parsed)) continue;
        if (parsed.entityId === entityId) {
          results.push(parsed);
        }
      } catch {
        // Malformed content — skip
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ─── Authorized Patterns (GENERALIZACIÓN-004) ────────────────────
//
// STRUCTURAL_DISCOVERY ≠ BUSINESS_AUTHORIZATION.
// The engine discovers structure (GENERALIZACIÓN-003); a human explicitly
// authorizes that structure as reusable knowledge for one company + entity
// + treatment. Authorization NEVER arises from observation counts,
// confidence, similarity, AI, rule engine, or frequency — only from an
// explicit confirmation action carrying a concrete authorizedBy identity.
//
// The authorized pattern is PERSISTED AUTHORITY, not yet CONSUMED
// authority: no operational flow (import, classification, rule engine,
// AI, entity resolution) reads it in this slice, and no
// matchesAuthorizedPattern(...) exists yet.

export const AUTHORIZED_PATTERN_TYPE = 'classification_authorized_pattern';

/** Persisted authorization content (MemoryItem.content JSON, fixed field order). */
export interface AuthorizedPatternContent {
  companyId: string;
  entityId: string;
  glAccountId: string;
  direction: 'debit' | 'credit' | 'any';
  segments: StructuralSegment[];
  /** MemoryItem id of the structural candidate this authorization came from */
  sourceCandidateId: string;
  observationIds: string[];
  authorizedBy: string;
  /** ISO-8601 timestamp generated by the system at authorization time */
  authorizedAt: string;
}

export type AuthorizationStatus = 'AUTHORIZED' | 'ALREADY_AUTHORIZED' | 'NOT_FOUND' | 'ERROR' | 'CONFLICT';

export type AuthorizationResult =
  | { status: 'AUTHORIZED'; authorizedPatternId: string }
  | { status: 'ALREADY_AUTHORIZED'; authorizedPatternId: string }
  | { status: 'NOT_FOUND' }
  | { status: 'CONFLICT'; conflictingPatternIds: string[] }
  | { status: 'ERROR'; error: string };

function isValidStructuralCandidateContent(content: unknown): content is StructuralCandidateContent {
  if (!isRecord(content)) return false;
  if (typeof content.companyId !== 'string' || content.companyId === '') return false;
  if (typeof content.entityId !== 'string' || content.entityId === '') return false;
  if (typeof content.glAccountId !== 'string' || content.glAccountId === '') return false;
  if (content.direction !== 'debit' && content.direction !== 'credit' && content.direction !== 'any') return false;
  if (!Array.isArray(content.segments) || content.segments.length === 0) return false;
  for (const segment of content.segments) {
    if (!isRecord(segment)) return false;
    if (segment.kind === 'stable') {
      if (typeof segment.value !== 'string') return false;
    } else if (segment.kind === 'variable') {
      if (!Array.isArray(segment.evidence)) return false;
    } else {
      return false;
    }
  }
  if (!Array.isArray(content.observationIds) || content.observationIds.length === 0) return false;
  if (!content.observationIds.every((id) => typeof id === 'string')) return false;
  return true;
}

/**
 * Authorize a PERSISTED structural candidate explicitly (human action).
 *
 * Validation before authorization: candidate exists (NOT_FOUND otherwise);
 * belongs to the tenant (cross-tenant id → NOT_FOUND, no existence leak);
 * has the candidate MemoryItem type (wrong type → NOT_FOUND); content is a
 * well-formed candidate (malformed → ERROR); authorizedBy must be a
 * non-empty user identity (anonymous → ERROR, nothing persisted).
 *
 * Idempotency: re-authorizing the same candidate returns the existing
 * authorized pattern id (no duplicate, no new version).
 *
 * Conflict policy: if an authorized pattern already exists for the same
 * companyId + entityId + direction with a DIFFERENT glAccountId, the
 * operation returns CONFLICT without persisting anything. Neither pattern
 * is selected, revoked, or modified — resolution is out of scope.
 */
export async function authorizeStructuralCandidate(
  adapter: MemoryAdapter,
  companyId: string,
  candidateId: string,
  authorizedBy: string,
): Promise<AuthorizationResult> {
  const invalidInput = !companyId || typeof companyId !== 'string'
    || !candidateId || typeof candidateId !== 'string'
    || !authorizedBy || typeof authorizedBy !== 'string' || authorizedBy.trim() === '';
  if (invalidInput) {
    return { status: 'ERROR', error: 'companyId, candidateId and authorizedBy are required' };
  }

  try {
    // Tenant-safe retrieval: returns null for missing OR other-company items
    const item = await adapter.getById(candidateId, companyId);
    if (!item || item.type !== STRUCTURAL_CANDIDATE_TYPE) {
      return { status: 'NOT_FOUND' };
    }

    let candidateContent: StructuralCandidateContent;
    try {
      const parsed: unknown = JSON.parse(item.content);
      if (!isValidStructuralCandidateContent(parsed)) {
        return { status: 'ERROR', error: 'Malformed candidate content' };
      }
      candidateContent = parsed;
    } catch {
      return { status: 'ERROR', error: 'Malformed candidate content' };
    }
    if (candidateContent.companyId !== companyId) {
      return { status: 'ERROR', error: 'Malformed candidate content' };
    }

    // Idempotency — idempotent on the authorization event, not on content
    const existingAuthorizations = await adapter.getByType(companyId, AUTHORIZED_PATTERN_TYPE);
    for (const authorization of existingAuthorizations) {
      if (authorization.status !== 'active') continue;
      try {
        const existing: unknown = JSON.parse(authorization.content);
        if (isRecord(existing) && typeof existing.sourceCandidateId === 'string' && existing.sourceCandidateId === candidateId) {
          return { status: 'ALREADY_AUTHORIZED', authorizedPatternId: authorization.id };
        }
      } catch {
        // Malformed authorization — not a duplicate of ours
      }
    }

    // Conflict detection: same entity+direction must keep ONE treatment.
    // Never auto-select, never revoke, never use confidence.
    const conflictingPatternIds: string[] = [];
    for (const authorization of existingAuthorizations) {
      if (authorization.status !== 'active') continue;
      try {
        const existing: unknown = JSON.parse(authorization.content);
        if (
          isRecord(existing)
          && typeof existing.entityId === 'string'
          && typeof existing.direction === 'string'
          && typeof existing.glAccountId === 'string'
          && existing.entityId === candidateContent.entityId
          && existing.direction === candidateContent.direction
          && existing.glAccountId !== candidateContent.glAccountId
        ) {
          conflictingPatternIds.push(authorization.id);
        }
      } catch {
        // Malformed authorization — ignore for conflict purposes
      }
    }
    if (conflictingPatternIds.length > 0) {
      return { status: 'CONFLICT', conflictingPatternIds };
    }

    const authorizedPatternContent: AuthorizedPatternContent = {
      companyId,
      entityId: candidateContent.entityId,
      glAccountId: candidateContent.glAccountId,
      direction: candidateContent.direction,
      segments: candidateContent.segments,
      sourceCandidateId: candidateId,
      observationIds: candidateContent.observationIds,
      authorizedBy,
      authorizedAt: new Date().toISOString(),
    };

    const created = await adapter.record({
      content: JSON.stringify(authorizedPatternContent),
      type: AUTHORIZED_PATTERN_TYPE,
      companyId,
      sourceAuthor: authorizedBy,
      sourceName: 'pattern_authorization',
      sourceObservedAt: new Date(),
      confidence: 'certain',
    });

    return { status: 'AUTHORIZED', authorizedPatternId: created.id };
  } catch (error) {
    return { status: 'ERROR', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Retrieve authorized patterns for an entity within a tenant.
 * Authorization metadata (authorizedBy, authorizedAt) travels inside the
 * content. Full provenance: sourceCandidateId → structural candidate
 * (getStructuralCandidates / getClassificationObservationRecords)
 * → observationIds → original descriptions → confirmed treatment.
 */
export async function getAuthorizedPatterns(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
): Promise<AuthorizedPatternContent[]> {
  if (!companyId || typeof companyId !== 'string') return [];
  if (!entityId || typeof entityId !== 'string') return [];

  try {
    const items = await adapter.getByType(companyId, AUTHORIZED_PATTERN_TYPE);
    const results: AuthorizedPatternContent[] = [];
    for (const item of items) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (!isValidAuthorizedPatternContent(parsed)) continue;
        if (parsed.entityId === entityId) {
          results.push(parsed);
        }
      } catch {
        // Malformed content — skip
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ─── Productive Structural Matching (GENERALIZACIÓN-005) ─────────
//
// Executes PERSISTED, HUMAN-AUTHORIZED structural knowledge. The matcher
// invents nothing: STABLE positions must equal exactly, VARIABLE positions
// accept any single token (including never-before-seen values). Token
// count must match exactly the authorized segment count. The very same
// normalization/tokenization used at discovery time is reused here.
//
// No fuzzy, no distance metrics, no embeddings, no AI, no lists, no
// confidence scoring, no auto-authorization, no pattern mutation.

export type AuthorizedPatternMatch =
  | {
      kind: 'match';
      /** Deterministic primary pattern id (first in creation order) */
      authorizedPatternId: string;
      /** All authorized patterns that matched (traceability) */
      matchedPatternIds: string[];
      entityId: string;
      glAccountId: string;
      direction: 'debit' | 'credit' | 'any';
      sourceCandidateId: string;
      observationIds: string[];
      /**
       * Real MemoryItem.confidence of the matched authorized pattern item
       * (KE-EVOL-003). Exposed verbatim; the matcher never converts an
       * uncertain match into no_match — authority is decided by the consumer.
       */
      confidence?: ConfidenceLevel;
    }
  | { kind: 'no_match' }
  | { kind: 'ambiguous'; matchedPatternIds: string[] }
  | { kind: 'error'; reason: string };

/**
 * Direction compatibility follows existing system semantics: 'any' on
 * either side is compatible; otherwise both must be identical.
 */
function directionsCompatible(requested: 'debit' | 'credit' | 'any', pattern: 'debit' | 'credit' | 'any'): boolean {
  return requested === 'any' || pattern === 'any' || requested === pattern;
}

function structuralMatch(tokens: string[], segments: StructuralSegment[]): boolean {
  if (tokens.length !== segments.length) return false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.kind === 'stable' && tokens[i] !== segment.value) return false;
    // VARIABLE accepts any token at this position (including unseen values)
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidAuthorizedPatternContent(content: unknown): content is AuthorizedPatternContent {
  if (!isRecord(content)) return false;
  const companyId = content.companyId;
  const entityId = content.entityId;
  const glAccountId = content.glAccountId;
  const direction = content.direction;
  const segments = content.segments;
  const observationIds = content.observationIds;
  const sourceCandidateId = content.sourceCandidateId;
  const authorizedBy = content.authorizedBy;
  const authorizedAt = content.authorizedAt;

  const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value !== '';

  if (!nonEmptyString(companyId) || !nonEmptyString(entityId) || !nonEmptyString(glAccountId)) {
    return false;
  }
  if (direction !== 'debit' && direction !== 'credit' && direction !== 'any') return false;

  if (!Array.isArray(segments) || segments.length === 0) return false;
  for (const segment of segments) {
    if (!isRecord(segment)) return false;
    if (segment.kind === 'stable') {
      if (typeof segment.value !== 'string') return false;
    } else if (segment.kind === 'variable') {
      if (!Array.isArray(segment.evidence)) return false;
    } else {
      return false;
    }
  }

  if (!Array.isArray(observationIds) || observationIds.length === 0) return false;
  if (!observationIds.every((id) => typeof id === 'string')) return false;

  if (!nonEmptyString(sourceCandidateId) || !nonEmptyString(authorizedBy) || !nonEmptyString(authorizedAt)) {
    return false;
  }
  return true;
}

/**
 * Productive structural matching of AUTHORIZED patterns only.
 *
 * Scope: companyId (tenant) + entityId + direction compatibility.
 * Exact treatment lookup (lookupTreatment) is NOT replaced — the matcher
 * runs only where the exact knowledge did not resolve. It does not call
 * the rule engine or AI, does not mutate any stored item, does not
 * authorize anything, and never invents a decision on multiple
 * incompatible matches (AMBIGUOUS).
 *
 * Multiple compatible matches (same glAccountId AND same direction)
 * resolve deterministically to that single treatment while preserving
 * every matched pattern id for traceability.
 *
 * ERROR is explicit and distinct from NO_MATCH: a DB/adapter failure or a
 * malformed authorized pattern item NEVER degrades to "no knowledge".
 */
export async function matchAuthorizedPattern(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  description: string,
  direction: 'debit' | 'credit' | 'any',
): Promise<AuthorizedPatternMatch> {
  if (!companyId || typeof companyId !== 'string') {
    return { kind: 'error', reason: 'Invalid companyId' };
  }
  if (!entityId || typeof entityId !== 'string') {
    return { kind: 'error', reason: 'Invalid entityId' };
  }
  if (direction !== 'debit' && direction !== 'credit' && direction !== 'any') {
    return { kind: 'error', reason: 'Invalid direction' };
  }

  let items: Array<{ id: string; content: string; status: string; confidence?: ConfidenceLevel }>;
  try {
    items = await adapter.getByType(companyId, AUTHORIZED_PATTERN_TYPE);
  } catch (error) {
    return {
      kind: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const tokens = normalizeTokensForStructure(description);
  const matched: Array<{ id: string; content: AuthorizedPatternContent; confidence?: ConfidenceLevel }> = [];

  for (const item of items) {
    if (item.status !== 'active') continue;

    let content: AuthorizedPatternContent;
    try {
      const parsed: unknown = JSON.parse(item.content);
      if (!isValidAuthorizedPatternContent(parsed)) {
        return { kind: 'error', reason: 'Malformed authorized pattern content' };
      }
      content = parsed;
    } catch {
      return { kind: 'error', reason: 'Malformed authorized pattern content' };
    }

    // Scope filters — valid patterns outside the scope are simply skipped
    if (content.entityId !== entityId) continue;
    if (!directionsCompatible(direction, content.direction)) continue;
    if (structuralMatch(tokens, content.segments)) {
      matched.push({ id: item.id, content, confidence: item.confidence });
    }
  }

  if (matched.length === 0) {
    return { kind: 'no_match' };
  }

  const primary = matched[0].content;
  const compatible = matched.every(
    (m) => m.content.glAccountId === primary.glAccountId && m.content.direction === primary.direction,
  );
  if (!compatible) {
    return { kind: 'ambiguous', matchedPatternIds: matched.map((m) => m.id) };
  }

  return {
    kind: 'match',
    authorizedPatternId: matched[0].id,
    matchedPatternIds: matched.map((m) => m.id),
    entityId,
    glAccountId: primary.glAccountId,
    direction: primary.direction,
    sourceCandidateId: primary.sourceCandidateId,
    observationIds: primary.observationIds,
    confidence: matched[0].confidence,
  };
}

// ─── Conflicting Pattern Detection (KE-EVOL-001) ────────────────
//
// Detects and persists evidence that authorized structural knowledge
// has been contradicted by subsequent evidence. Does NOT resolve,
// invalidate, supersede, or modify any existing knowledge.
//
// Three deterministic conflict kinds:
//   OBSERVATION_VS_AUTHORIZED  — new observation contradicts authorized pattern
//   AUTHORIZED_VS_EXACT       — exact treatment evolved away from authorized pattern
//   AUTHORIZED_VS_AUTHORIZED  — two authorized patterns propose different treatments

export const CONFLICTING_PATTERN_TYPE = 'classification_conflicting_pattern';

export type ConflictKind =
  | 'OBSERVATION_VS_AUTHORIZED'
  | 'AUTHORIZED_VS_EXACT'
  | 'AUTHORIZED_VS_AUTHORIZED';

/** Persisted conflict content (MemoryItem.content JSON, fixed field order). */
export interface ConflictingPatternContent {
  companyId: string;
  entityId: string;
  direction: 'debit' | 'credit' | 'any';
  kind: ConflictKind;
  authorizedPatternIds: string[];
  conflictingGlAccountId: string;
  observationIds: string[];
  detectedAt: string;
  sourceCandidateId?: string;
  /**
   * Exact-treatment MemoryItem ids implicated by an AUTHORIZED_VS_EXACT
   * conflict, captured at detection time so degradation hits exactly the
   * implicated item and not other treatments of the same entity.
   * Legacy conflicts (pre KE-EVOL-002) omit this field.
   */
  exactTreatmentItemIds?: string[];
}

export type ConflictDetectionResult =
  | { status: 'RECORDED'; conflictId: string; kind: ConflictKind }
  | { status: 'ALREADY_RECORDED'; conflictId: string; kind: ConflictKind }
  | { status: 'NO_CONFLICT' }
  | { status: 'ERROR'; error: string };

function isDirection(value: unknown): value is 'debit' | 'credit' | 'any' {
  return value === 'debit' || value === 'credit' || value === 'any';
}

function isConflictKind(value: unknown): value is ConflictKind {
  return value === 'OBSERVATION_VS_AUTHORIZED'
    || value === 'AUTHORIZED_VS_EXACT'
    || value === 'AUTHORIZED_VS_AUTHORIZED';
}

function isValidConflictingPatternContent(content: unknown): content is ConflictingPatternContent {
  if (!isRecord(content)) return false;
  if (typeof content.companyId !== 'string' || content.companyId === '') return false;
  if (typeof content.entityId !== 'string' || content.entityId === '') return false;
  if (!isDirection(content.direction)) return false;
  if (!isConflictKind(content.kind)) return false;
  if (!Array.isArray(content.authorizedPatternIds)) return false;
  if (typeof content.conflictingGlAccountId !== 'string' || content.conflictingGlAccountId === '') return false;
  if (!Array.isArray(content.observationIds)) return false;
  if (typeof content.detectedAt !== 'string' || content.detectedAt === '') return false;
  if (content.exactTreatmentItemIds !== undefined) {
    if (!Array.isArray(content.exactTreatmentItemIds)) return false;
    if (!content.exactTreatmentItemIds.every((id) => typeof id === 'string')) return false;
  }
  return true;
}

/**
 * Build a deterministic identity key for idempotency comparison.
 * Fixed field order ensures identical logical conflicts produce identical strings.
 * Does NOT include detectedAt or sourceCandidateId — these are metadata, not identity.
 */
function buildConflictIdentityKey(content: ConflictingPatternContent): string {
  return JSON.stringify({
    companyId: content.companyId,
    entityId: content.entityId,
    direction: content.direction,
    kind: content.kind,
    authorizedPatternIds: [...content.authorizedPatternIds].sort(),
    conflictingGlAccountId: content.conflictingGlAccountId,
    observationIds: [...content.observationIds].sort(),
  });
}

/**
 * Check if an existing conflict has the same logical identity as the candidate.
 * Identity excludes detectedAt (timestamp) and sourceCandidateId (metadata).
 */
function hasSameConflictIdentity(existing: ConflictingPatternContent, candidate: ConflictingPatternContent): boolean {
  return buildConflictIdentityKey(existing) === buildConflictIdentityKey(candidate);
}

/**
 * Structural, valid classification item for an entity (exact treatment side).
 */
function isValidEntityClassificationContent(content: unknown): content is ClassificationContent {
  if (!isRecord(content)) return false;
  const entityId = content.entityId;
  if (typeof entityId !== 'string' || entityId === '') return false;
  const glAccountId = content.glAccountId;
  if (typeof glAccountId !== 'string' || glAccountId === '') return false;
  if (!isDirection(content.direction)) return false;
  return true;
}

/**
 * Two structural patterns are applicable to at least one common input iff
 * they have the same token count and no stable position demands two
 * different fixed values. VARIABLE positions accept any token, so a
 * stable/variable pair at the same position is always compatible.
 * Same semantics as the matcher: shared structuralMatch rules, no new matcher.
 */
function structuralSegmentsOverlap(a: StructuralSegment[], b: StructuralSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i];
    const sb = b[i];
    if (sa.kind === 'stable' && sb.kind === 'stable' && sa.value !== sb.value) return false;
  }
  return true;
}

/**
 * Idempotency check + persistence of one conflict.
 * Deterministic identity scan first (ALREADY_RECORDED), then C1 record.
 */
async function persistConflict(
  adapter: MemoryAdapter,
  companyId: string,
  conflictContent: ConflictingPatternContent,
): Promise<ConflictDetectionResult> {
  const existingConflicts = await adapter.getByType(companyId, CONFLICTING_PATTERN_TYPE);
  for (const item of existingConflicts) {
    if (item.status !== 'active') continue;
    try {
      const parsed: unknown = JSON.parse(item.content);
      if (isValidConflictingPatternContent(parsed) && hasSameConflictIdentity(parsed, conflictContent)) {
        return { status: 'ALREADY_RECORDED', conflictId: item.id, kind: conflictContent.kind };
      }
    } catch {
      // Malformed existing conflict — not a duplicate of ours
    }
  }

  const created = await adapter.record({
    content: JSON.stringify(conflictContent),
    type: CONFLICTING_PATTERN_TYPE,
    companyId,
    sourceAuthor: 'system',
    sourceName: 'conflict_detection',
    sourceObservedAt: new Date(),
    confidence: 'tentative',
  });
  return { status: 'RECORDED', conflictId: created.id, kind: conflictContent.kind };
}

/**
 * Detect and persist conflicts between authorized structural knowledge
 * and subsequent evidence. Deterministic, no AI, no fuzzy.
 *
 * Three conflict kinds:
 *   OBSERVATION_VS_AUTHORIZED — observation GL differs from authorized pattern GL
 *   AUTHORIZED_VS_EXACT — exact treatment GL differs from authorized pattern GL
 *   AUTHORIZED_VS_AUTHORIZED — two authorized patterns with different GL accounts
 *
 * Identity: kind + companyId + entityId + direction + sorted authorizedPatternIds
 *           + sorted observationIds + conflictingGlAccountId.
 * Same logical evidence → ALREADY_RECORDED. New evidence → RECORDED.
 *
 * Does NOT modify authorized patterns, exact treatment, or create candidates.
 */
export async function detectConflictingPattern(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
  direction: 'debit' | 'credit' | 'any',
): Promise<ConflictDetectionResult> {
  if (!companyId || typeof companyId !== 'string') {
    return { status: 'ERROR', error: 'Invalid companyId' };
  }
  if (!entityId || typeof entityId !== 'string') {
    return { status: 'ERROR', error: 'Invalid entityId' };
  }
  if (direction !== 'debit' && direction !== 'credit' && direction !== 'any') {
    return { status: 'ERROR', error: 'Invalid direction' };
  }

  try {
    // Gather authorized patterns for this entity+direction
    const allAuthorized = await adapter.getByType(companyId, AUTHORIZED_PATTERN_TYPE);
    const patterns: Array<{ id: string; content: AuthorizedPatternContent }> = [];
    for (const item of allAuthorized) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (!isValidAuthorizedPatternContent(parsed)) continue;
        if (parsed.entityId === entityId && directionsCompatible(direction, parsed.direction)) {
          patterns.push({ id: item.id, content: parsed });
        }
      } catch {
        // Malformed — skip
      }
    }

    if (patterns.length === 0) {
      return { status: 'NO_CONFLICT' };
    }

    // Gather observations for this entity (validated observation content only)
    const allObservations = await adapter.getByType(companyId, OBSERVATION_TYPE);
    const observations: Array<{ id: string; glAccountId: string; direction: 'debit' | 'credit' | 'any'; originalDescription: string }> = [];
    for (const item of allObservations) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (!isValidClassificationObservation(parsed)) continue;
        if (parsed.entityId === entityId) {
          observations.push({
            id: item.id,
            glAccountId: parsed.glAccountId,
            direction: parsed.direction,
            originalDescription: parsed.originalDescription,
          });
        }
      } catch {
        // Malformed — skip
      }
    }

    // Gather exact treatment for this entity (validated classification content only)
    const allClassifications = await adapter.getByType(companyId, TYPE);
    const exactMatches: Array<{ id: string; glAccountId: string; direction: 'debit' | 'credit' | 'any' }> = [];
    for (const item of allClassifications) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (!isValidEntityClassificationContent(parsed)) continue;
        if (parsed.entityId === entityId) {
          exactMatches.push({
            id: item.id,
            glAccountId: parsed.glAccountId,
            direction: parsed.direction,
          });
        }
      } catch {
        // Malformed — skip
      }
    }

    // ── AUTHORIZED_VS_AUTHORIZED ──────────────────────────────────
    // Two patterns that are BOTH applicable to a common structural input
    // (real segment overlap, not merely same entity) propose different GL.
    if (patterns.length >= 2) {
      const overlapPatternIds: string[] = [];
      let overlapConflictingGlAccountId = '';
      for (let i = 0; i < patterns.length - 1; i++) {
        for (let j = i + 1; j < patterns.length; j++) {
          const a = patterns[i].content;
          const b = patterns[j].content;
          if (a.glAccountId === b.glAccountId) continue;
          if (!directionsCompatible(a.direction, b.direction)) continue;
          if (!structuralSegmentsOverlap(a.segments, b.segments)) continue;
          overlapPatternIds.push(...[patterns[i].id, patterns[j].id].sort());
          overlapConflictingGlAccountId = b.glAccountId;
          i = patterns.length; // break outer loop — first real overlap wins
          break;
        }
      }

      if (overlapPatternIds.length === 2 && overlapConflictingGlAccountId !== '') {
        const conflictContent: ConflictingPatternContent = {
          companyId,
          entityId,
          direction,
          kind: 'AUTHORIZED_VS_AUTHORIZED',
          authorizedPatternIds: overlapPatternIds,
          conflictingGlAccountId: overlapConflictingGlAccountId,
          observationIds: [],
          detectedAt: new Date().toISOString(),
        };
        return await persistConflict(adapter, companyId, conflictContent);
      }
    }

    // ── OBSERVATION_VS_AUTHORIZED ─────────────────────────────────
    // Observation STRUCTURALLY MATCHES the authorized pattern (same rules
    // as the matcher: structuralMatch on the same normalization) AND its
    // confirmed GL differs from the authorized GL.
    for (const pattern of patterns) {
      const conflictingObs = observations.filter(
        (obs) => obs.glAccountId !== pattern.content.glAccountId
          && directionsCompatible(obs.direction, pattern.content.direction)
          && structuralMatch(normalizeTokensForStructure(obs.originalDescription), pattern.content.segments),
      );

      if (conflictingObs.length > 0) {
        const conflictContent: ConflictingPatternContent = {
          companyId,
          entityId,
          direction,
          kind: 'OBSERVATION_VS_AUTHORIZED',
          authorizedPatternIds: [pattern.id],
          conflictingGlAccountId: conflictingObs[0].glAccountId,
          observationIds: conflictingObs.map((o) => o.id).sort(),
          detectedAt: new Date().toISOString(),
          sourceCandidateId: pattern.content.sourceCandidateId,
        };
        return await persistConflict(adapter, companyId, conflictContent);
      }
    }

    // ── AUTHORIZED_VS_EXACT ───────────────────────────────────────
    // Exact treatment GL differs from authorized pattern GL
    if (exactMatches.length === 1) {
      for (const pattern of patterns) {
        if (exactMatches[0].glAccountId !== pattern.content.glAccountId) {
          const conflictContent: ConflictingPatternContent = {
            companyId,
            entityId,
            direction,
            kind: 'AUTHORIZED_VS_EXACT',
            authorizedPatternIds: [pattern.id],
            conflictingGlAccountId: exactMatches[0].glAccountId,
            observationIds: [],
            detectedAt: new Date().toISOString(),
            sourceCandidateId: pattern.content.sourceCandidateId,
            exactTreatmentItemIds: [exactMatches[0].id],
          };
          return await persistConflict(adapter, companyId, conflictContent);
        }
      }
    }

    return { status: 'NO_CONFLICT' };
  } catch (error) {
    return { status: 'ERROR', error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── Treatment Lookup (Phase 2: entity→treatment) ────────────────

export interface TreatmentFound {
  status: 'FOUND';
  glAccountId: string;
  direction: 'debit' | 'credit' | 'any';
  confidence: ConfidenceLevel;
  memoryItemId: string;
}

export interface TreatmentNotFound {
  status: 'NOT_FOUND';
}

export interface TreatmentError {
  status: 'ERROR';
  reason: string;
}

export type TreatmentLookup = TreatmentFound | TreatmentNotFound | TreatmentError;

/**
 * Look up accounting treatment for a known entity within a tenant.
 *
 * Identity: companyId + entityId = one logical treatment.
 *
 * Reads ALL active classification items for the given entityId.
 *   0 matches → NOT_FOUND
 *   1 match   → FOUND (complete: glAccountId, direction, confidence, memoryItemId)
 *   >1 matches → ERROR (multiple active treatments = ambiguous, order-independent)
 *
 * The write path (learnFromCorrection) enforces identity on
 * companyId + type + pattern, NOT companyId + entityId. Therefore
 * multiple active MemoryItems per entity IS a valid write state.
 * Any >1 active match is inherently ambiguous — even with identical GL —
 * because direction, confidence, or identity may differ.
 *
 * Does NOT call AI, read EntityContext, or invoke the rule engine.
 * Does NOT modify any data.
 *
 * @param adapter - MemoryAdapter for data access
 * @param companyId - Tenant scope (mandatory)
 * @param entityId - Entity identity from CompanyKnowledge (mandatory)
 * @returns TreatmentLookup: FOUND, NOT_FOUND, or ERROR
 */
export async function lookupTreatment(
  adapter: MemoryAdapter,
  companyId: string,
  entityId: string,
): Promise<TreatmentLookup> {
  if (!companyId || typeof companyId !== 'string') {
    return { status: 'ERROR', reason: 'Invalid companyId' };
  }

  if (!entityId || typeof entityId !== 'string') {
    return { status: 'ERROR', reason: 'Invalid entityId' };
  }

  try {
    // C2: deterministic lookup — all classification items for this company
    const allClassifications = await adapter.getByType(companyId, TYPE);

    // Collect ALL active items matching this entityId
    const matches: Array<{ content: ClassificationContent; confidence: ConfidenceLevel; itemId: string }> = [];

    for (const item of allClassifications) {
      if (item.status !== 'active') continue;

      try {
        const content = JSON.parse(item.content) as ClassificationContent;
        if (content.entityId === entityId) {
          matches.push({
            content,
            confidence: item.confidence as ConfidenceLevel,
            itemId: item.id,
          });
        }
      } catch {
        // Malformed content — skip
      }
    }

    if (matches.length === 0) {
      return { status: 'NOT_FOUND' };
    }

    if (matches.length === 1) {
      return {
        status: 'FOUND',
        glAccountId: matches[0].content.glAccountId,
        direction: matches[0].content.direction,
        confidence: matches[0].confidence,
        memoryItemId: matches[0].itemId,
      };
    }

    // Multiple active matches — ambiguous regardless of content
    // The write path does not enforce entityId-level uniqueness,
    // so >1 active match means the treatment identity is undefined.
    return {
      status: 'ERROR',
      reason: `Ambiguous active treatment for entity ${entityId}: ${matches.length} active treatments found`,
    };
  } catch (error) {
    return {
      status: 'ERROR',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Confidence Evolution (KE-EVOL-002) ─────────────────────────
//
// Activates the EXISTING C11 infrastructure (updateConfidence →
// ConfidenceLog + TraceabilityLog) with deterministic signals only:
//   human_confirmation     → certain (explicit user correction authority)
//   deterministic_conflict → uncertain (persisted conflict evidence)
//
// No scoring, no percentages, no thresholds, no counts, no decay,
// no probabilities, no automatic rehabilitation. Compatible evidence
// NEVER changes confidence by itself.

export type ConfidenceEvolutionReason = 'human_confirmation' | 'deterministic_conflict';

export type ConfidenceEvolutionResult =
  | {
      status: 'UPDATED';
      itemId: string;
      previousConfidence: ConfidenceLevel;
      newConfidence: ConfidenceLevel;
    }
  | { status: 'UNCHANGED'; itemId: string; confidence: ConfidenceLevel }
  | { status: 'NOT_FOUND' }
  | { status: 'ERROR'; error: string };

/**
 * Evolve the confidence of ONE knowledge item through the existing C11
 * infrastructure (adapter.updateConfidence, which writes ConfidenceLog +
 * TraceabilityLog action=confidence_changed).
 *
 * Idempotent by refusal: if the item's current confidence already equals
 * the requested level, returns UNCHANGED WITHOUT writing any log row —
 * no fake ConfidenceLog for a non-change.
 *
 * ERROR is explicit and distinct from UNCHANGED: a read/write failure
 * never degrades into "nothing to do".
 */
export async function evolveClassificationConfidence(
  adapter: MemoryAdapter,
  companyId: string,
  itemId: string,
  newConfidence: ConfidenceLevel,
  reason: ConfidenceEvolutionReason,
): Promise<ConfidenceEvolutionResult> {
  if (!companyId || typeof companyId !== 'string') {
    return { status: 'ERROR', error: 'Invalid companyId' };
  }
  if (!itemId || typeof itemId !== 'string') {
    return { status: 'ERROR', error: 'Invalid itemId' };
  }
  if (newConfidence !== 'certain' && newConfidence !== 'tentative' && newConfidence !== 'uncertain') {
    return { status: 'ERROR', error: 'Invalid newConfidence' };
  }
  if (reason !== 'human_confirmation' && reason !== 'deterministic_conflict') {
    return { status: 'ERROR', error: 'Invalid reason' };
  }

  try {
    const item = await adapter.getById(itemId, companyId);
    if (!item) {
      return { status: 'NOT_FOUND' };
    }

    if (item.confidence === newConfidence) {
      return {
        status: 'UNCHANGED',
        itemId,
        confidence: item.confidence,
      };
    }

    // Snapshot BEFORE the mutation: practitioners may hand back
    // shared-reference objects that updateConfidence mutates in place.
    const previousConfidence = item.confidence;

    await adapter.updateConfidence(itemId, newConfidence, reason, companyId);
    return {
      status: 'UPDATED',
      itemId,
      previousConfidence,
      newConfidence,
    };
  } catch (error) {
    return {
      status: 'ERROR',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type ConflictDegradationResult =
  | { status: 'UPDATED'; degradedItemIds: string[] }
  | { status: 'UNCHANGED' }
  | { status: 'NOT_FOUND' }
  | { status: 'ERROR'; error: string };

/**
 * Degrade to 'uncertain' every ACTIVE knowledge item really questioned by
 * a persisted deterministic conflict:
 *   OBSERVATION_VS_AUTHORIZED → the contradicted authorized pattern(s)
 *   AUTHORIZED_VS_EXACT       → the authorized pattern AND the exact treatment
 *   AUTHORIZED_VS_AUTHORIZED  → every participating authorized pattern
 *
 * The conflict item itself is NEVER degraded or promoted: the certainty
 * that a divergence was DETECTED is different from trust in WHICH
 * treatment is correct.
 *
 * Deterministic: if any target is missing or foreign to the tenant →
 * NOT_FOUND and NOTHING is modified. Idempotent: re-running after a
 * first degradation returns UNCHANGED without writing new log rows.
 *
 * All real changes flow through evolveClassificationConfidence → existing
 * C11 infrastructure (ConfidenceLog + TraceabilityLog) with reason
 * 'deterministic_conflict'.
 */
export async function degradeKnowledgeOnConflict(
  adapter: MemoryAdapter,
  companyId: string,
  conflictId: string,
): Promise<ConflictDegradationResult> {
  if (!companyId || typeof companyId !== 'string') {
    return { status: 'ERROR', error: 'Invalid companyId' };
  }
  if (!conflictId || typeof conflictId !== 'string') {
    return { status: 'ERROR', error: 'Invalid conflictId' };
  }

  try {
    const conflictItem = await adapter.getById(conflictId, companyId);
    if (!conflictItem || conflictItem.type !== CONFLICTING_PATTERN_TYPE) {
      return { status: 'NOT_FOUND' };
    }

    let conflictContent: ConflictingPatternContent;
    try {
      const parsed: unknown = JSON.parse(conflictItem.content);
      if (!isValidConflictingPatternContent(parsed)) {
        return { status: 'ERROR', error: 'Malformed conflict content' };
      }
      if (parsed.companyId !== companyId) {
        return { status: 'ERROR', error: 'Malformed conflict content' };
      }
      conflictContent = parsed;
    } catch {
      return { status: 'ERROR', error: 'Malformed conflict content' };
    }

    // Target set from REAL persisted conflict data
    const targetIds: string[] = [];
    for (const patternId of conflictContent.authorizedPatternIds) {
      if (!targetIds.includes(patternId)) {
        targetIds.push(patternId);
      }
    }

    if (conflictContent.kind === 'AUTHORIZED_VS_EXACT') {
      // Degrade EXACTLY the implicated exact treatment item(s) captured at
      // detection time — never other treatments of the same entity.
      if (Array.isArray(conflictContent.exactTreatmentItemIds)
          && conflictContent.exactTreatmentItemIds.length > 0) {
        for (const exactId of conflictContent.exactTreatmentItemIds) {
          if (!targetIds.includes(exactId)) {
            targetIds.push(exactId);
          }
        }
      } else {
        // Legacy conflicts (pre KE-EVOL-002): fall back to the CURRENT
        // active exact treatment for the same entity+direction. A working
        // detection state for this kind can only have had ONE exact match.
        const allClassifications = await adapter.getByType(companyId, TYPE);
        const legacyExactIds: Array<{ id: string; glAccountId: string }> = [];
        for (const item of allClassifications) {
          if (item.status !== 'active') continue;
          try {
            const parsed: unknown = JSON.parse(item.content);
            if (!isValidEntityClassificationContent(parsed)) continue;
            if (parsed.entityId === conflictContent.entityId
                && directionsCompatible(conflictContent.direction, parsed.direction)) {
              legacyExactIds.push({ id: item.id, glAccountId: parsed.glAccountId });
            }
          } catch {
            // Malformed — skip
          }
        }
        // Only degrade when the state still matches the persisted conflict
        // (exactly one exact treatment AND its GL is the conflicting one)
        if (legacyExactIds.length === 1
            && legacyExactIds[0].glAccountId === conflictContent.conflictingGlAccountId) {
          if (!targetIds.includes(legacyExactIds[0].id)) {
            targetIds.push(legacyExactIds[0].id);
          }
        }
      }
    }

    // Verify ALL targets exist within this tenant BEFORE touching anything
    const targets: Array<{ id: string; item: NonNullable<Awaited<ReturnType<typeof adapter.getById>>> }> = [];
    for (const id of targetIds) {
      const item = await adapter.getById(id, companyId);
      if (!item) {
        return { status: 'NOT_FOUND' };
      }
      targets.push({ id, item });
    }

    // Idempotent ordering: only evolve items whose confidence differs
    const degradedItemIds: string[] = [];
    for (const { id, item } of targets) {
      if (item.confidence === 'uncertain') continue;
      const evolved = await evolveClassificationConfidence(
        adapter,
        companyId,
        id,
        'uncertain',
        'deterministic_conflict',
      );
      if (evolved.status === 'ERROR') {
        return { status: 'ERROR', error: evolved.error };
      }
      if (evolved.status === 'UPDATED') {
        degradedItemIds.push(id);
      }
    }

    if (degradedItemIds.length > 0) {
      return { status: 'UPDATED', degradedItemIds };
    }
    return { status: 'UNCHANGED' };
  } catch (error) {
    return {
      status: 'ERROR',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Pending Conflicts Read (KE-EVOL-001, KE-EVOL-004) ───────────

/**
 * One pending conflict as exposed by getPendingConflicts.
 * conflictItemId is the REAL MemoryItem id of the
 * classification_conflicting_pattern item (no derived id, no index,
 * no substitute hash) — required for later explicit resolution.
 */
export interface PendingConflictEntry {
  conflictItemId: string;
  content: ConflictingPatternContent;
}

export type PendingConflictsResult =
  | { status: 'FOUND'; conflicts: PendingConflictEntry[] }
  | { status: 'EMPTY' }
  | { status: 'ERROR'; error: string };

/**
 * Retrieve PENDING (unresolved) conflict records for a company, optionally
 * filtered by entity.
 *
 * Pending = the persisted conflict has NO recorded human resolution yet.
 * Resolved conflicts are excluded here but remain historically observable
 * via the persisted conflict resolution items (getConflictResolutions).
 *
 * Deterministic contract: an adapter/read failure is an explicit ERROR and
 * is NEVER converted into an empty result.
 *
 * @param adapter - MemoryAdapter for data access
 * @param companyId - Tenant scope (mandatory)
 * @param entityId - Optional entity filter
 * @returns FOUND (1+ unresolved conflicts), EMPTY (0 unresolved conflicts), or ERROR
 */
export async function getPendingConflicts(
  adapter: MemoryAdapter,
  companyId: string,
  entityId?: string,
): Promise<PendingConflictsResult> {
  if (!companyId || typeof companyId !== 'string') {
    return { status: 'ERROR', error: 'Invalid companyId' };
  }

  try {
    // Conflicts explicitly resolved by a human are no longer pending.
    const resolutionItems = await adapter.getByType(companyId, CONFLICT_RESOLUTION_TYPE);
    const resolvedConflictItemIds = new Set<string>();
    for (const item of resolutionItems) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (
          isRecord(parsed)
          && typeof parsed.conflictItemId === 'string'
          && parsed.conflictItemId !== ''
          && parsed.companyId === companyId
        ) {
          resolvedConflictItemIds.add(parsed.conflictItemId);
        }
      } catch {
        // Malformed resolution content — cannot prove resolution; skip
      }
    }

    const items = await adapter.getByType(companyId, CONFLICTING_PATTERN_TYPE);
    const results: PendingConflictEntry[] = [];
    for (const item of items) {
      if (item.status !== 'active') continue;
      if (resolvedConflictItemIds.has(item.id)) continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (!isValidConflictingPatternContent(parsed)) continue;
        if (entityId && parsed.entityId !== entityId) continue;
        results.push({ conflictItemId: item.id, content: parsed });
      } catch {
        // Malformed content — skip
      }
    }
    if (results.length === 0) {
      return { status: 'EMPTY' };
    }
    return { status: 'FOUND', conflicts: results };
  } catch (error) {
    return {
      status: 'ERROR',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Explicit Conflict Resolution (KE-EVOL-004) ─────────────────
//
// A deterministic conflict is a verdict ("this divergence was detected"),
// NOT an accounting truth. Which treatment is correct is a HUMAN
// decision. This layer records that human decision explicitly and
// traceably WITHOUT:
//   - rehabilitating, promoting, or downgrading any knowledge item
//   - changing any confidence (pattern, exact treatment, or conflict)
//   - selecting a winner or modifying any GL account
//   - deleting the conflict or rewriting its original evidence
//
// Storage: a SEPARATE MemoryItem of type 'classification_conflict_resolution'
// referencing the conflict by its REAL MemoryItem id. The original conflict
// item is never mutated (append-only evidence preservation); the conflict's
// own status field is never repurposed (read filters treat status !==
// 'active' as excluded everywhere, so a status transition would silently
// hide the conflict from ALL queries, not only from "pending").

export const CONFLICT_RESOLUTION_TYPE = 'classification_conflict_resolution';

/** Persisted resolution content (MemoryItem.content JSON, fixed field order). */
export interface ConflictResolutionContent {
  companyId: string;
  /** Real MemoryItem id of the resolved classification_conflicting_pattern */
  conflictItemId: string;
  /** Non-empty human identity who made the resolution decision */
  resolvedBy: string;
  /** Non-free human record of WHY (mandatory, audited verbatim) */
  resolutionReason: string;
  /** ISO-8601 timestamp generated by the system at resolution time */
  resolvedAt: string;
}

export type ConflictResolutionResult =
  | { status: 'RESOLVED'; conflictItemId: string; resolutionId: string }
  | { status: 'ALREADY_RESOLVED'; conflictItemId: string; resolutionId: string }
  | { status: 'NOT_FOUND' }
  | { status: 'ERROR'; error: string };

function isValidConflictResolutionContent(content: unknown): content is ConflictResolutionContent {
  if (!isRecord(content)) return false;
  const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value !== '';
  if (!nonEmptyString(content.companyId)) return false;
  if (!nonEmptyString(content.conflictItemId)) return false;
  if (!nonEmptyString(content.resolvedBy)) return false;
  if (!nonEmptyString(content.resolutionReason)) return false;
  if (!nonEmptyString(content.resolvedAt)) return false;
  return true;
}

/**
 * Explicitly resolve one persisted deterministic conflict (HUMAN action).
 *
 * Validation: conflictId must exist within the tenant (missing or foreign
 * → NOT_FOUND, no existence leak); must be of type
 * classification_conflicting_pattern (wrong type → NOT_FOUND); content
 * must be well-formed and match the tenant (else ERROR); resolvedBy and
 * resolutionReason must be non-empty human-provided strings (else ERROR,
 * nothing persisted).
 *
 * Explicit human resolution: nothing in this operation derives the
 * decision from observations, counts, time, similarity, confidence,
 * absence of new conflicts, or any automatic signal.
 *
 * Idempotent: resolving the same conflict again returns ALREADY_RESOLVED
 * with the existing resolution id — no duplicate record, no second
 * decision event for the same conflict.
 *
 * Traceability: the resolution preserves conflictItemId, companyId,
 * resolvedBy, resolutionReason, and resolvedAt. The original conflict
 * item is NEVER modified, never deleted, and its evidence
 * (detectedAt, observationIds, authorizedPatternIds,
 * exactTreatmentItemIds, conflictingGlAccountId) stays untouched.
 *
 * Does NOT rehabilitate any knowledge item, does NOT change any
 * confidence, does NOT choose a winner, does NOT modify GL accounts,
 * and does NOT invoke any other engine.
 */
export async function resolveClassificationConflict(
  adapter: MemoryAdapter,
  companyId: string,
  conflictItemId: string,
  resolvedBy: string,
  resolutionReason: string,
): Promise<ConflictResolutionResult> {
  const invalidInput = !companyId || typeof companyId !== 'string'
    || !conflictItemId || typeof conflictItemId !== 'string'
    || !resolvedBy || typeof resolvedBy !== 'string' || resolvedBy.trim() === ''
    || !resolutionReason || typeof resolutionReason !== 'string' || resolutionReason.trim() === '';
  if (invalidInput) {
    return { status: 'ERROR', error: 'companyId, conflictItemId, resolvedBy and resolutionReason are required' };
  }

  try {
    // Tenant-safe retrieval: returns null for missing OR other-company items
    const item = await adapter.getById(conflictItemId, companyId);
    if (!item || item.type !== CONFLICTING_PATTERN_TYPE) {
      return { status: 'NOT_FOUND' };
    }

    try {
      const parsed: unknown = JSON.parse(item.content);
      if (!isValidConflictingPatternContent(parsed)) {
        return { status: 'ERROR', error: 'Malformed conflict content' };
      }
      if (parsed.companyId !== companyId) {
        return { status: 'ERROR', error: 'Malformed conflict content' };
      }
    } catch {
      return { status: 'ERROR', error: 'Malformed conflict content' };
    }

    // Idempotency: one resolution event per conflict
    const existingResolutions = await adapter.getByType(companyId, CONFLICT_RESOLUTION_TYPE);
    for (const existing of existingResolutions) {
      if (existing.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(existing.content);
        if (
          isRecord(parsed)
          && typeof parsed.conflictItemId === 'string'
          && parsed.conflictItemId === conflictItemId
          && typeof parsed.companyId === 'string'
          && parsed.companyId === companyId
        ) {
          return {
            status: 'ALREADY_RESOLVED',
            conflictItemId,
            resolutionId: existing.id,
          };
        }
      } catch {
        // Malformed existing resolution — not a duplicate of ours
      }
    }

    const resolutionContent: ConflictResolutionContent = {
      companyId,
      conflictItemId,
      resolvedBy,
      resolutionReason,
      resolvedAt: new Date().toISOString(),
    };

    const created = await adapter.record({
      content: JSON.stringify(resolutionContent),
      type: CONFLICT_RESOLUTION_TYPE,
      companyId,
      sourceAuthor: resolvedBy,
      sourceName: 'conflict_resolution',
      sourceObservedAt: new Date(),
      confidence: 'certain',
    });

    return {
      status: 'RESOLVED',
      conflictItemId,
      resolutionId: created.id,
    };
  } catch (error) {
    return {
      status: 'ERROR',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Retrieve ALL persisted conflict resolutions for a company (tenant-scoped).
 * Historical observability surface: resolutions of already-resolved
 * conflicts stay readable here even though those conflicts no longer
 * appear in getPendingConflicts.
 */
export async function getConflictResolutions(
  adapter: MemoryAdapter,
  companyId: string,
): Promise<ConflictResolutionContent[]> {
  if (!companyId || typeof companyId !== 'string') return [];

  try {
    const items = await adapter.getByType(companyId, CONFLICT_RESOLUTION_TYPE);
    const results: ConflictResolutionContent[] = [];
    for (const item of items) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        if (!isValidConflictResolutionContent(parsed)) continue;
        if (parsed.companyId !== companyId) continue;
        results.push(parsed);
      } catch {
        // Malformed content — skip
      }
    }
    return results;
  } catch {
    return [];
  }
}
