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
