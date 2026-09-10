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
