// Memory Core — Service (C1-C11)
// Functional/orchestration layer delegating to repository and detector
// Repository enforces companyId isolation at the persistence boundary

import type { MemoryStatus, ConfidenceLevel } from '@prisma/client';
import { MemoryRepository } from './repository';
import { detectDeterministic } from './detector';
import type {
  RecordInput,
  RelateInput,
  UpdateInput,
  SearchResult,
  ContradictionResult,
} from './types';
import type { MemoryPrismaClient, TransactionRunner } from './prisma-types';

// ─── Errors ──────────────────────────────────────────────────────

export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}

function assertCompanyId(companyId: string): void {
  if (!companyId || typeof companyId !== 'string' || companyId.trim() === '') {
    throw new MemoryError('companyId is required', 'COMPANY_ID_REQUIRED');
  }
}

// ─── Service ──────────────────────────────────────────────────────

export class MemoryService {
  private readonly repo: MemoryRepository;

  constructor(
    private readonly prisma: MemoryPrismaClient,
    runTx: TransactionRunner,
  ) {
    this.repo = new MemoryRepository(prisma, runTx);
  }

  // ─── C1 — Record ───────────────────────────────────────────────

  async record(input: RecordInput) {
    assertCompanyId(input.companyId);

    const item = await this.repo.create(input);

    // C8: traceability log
    await this.repo.addTraceabilityLog({
      itemId: item.id,
      action: 'recorded',
      actor: input.sourceAuthor,
      details: { type: input.type, source: input.sourceName },
    });

    return item;
  }

  // ─── C2 — Retrieve ─────────────────────────────────────────────

  /** C2 — Retrieve by ID. Returns null if not found or not in companyId. */
  async getById(id: string, companyId: string) {
    assertCompanyId(companyId);
    // Repository enforces companyId boundary
    return this.repo.findById(id, companyId);
  }

  /** C2 — Retrieve by exact content within a company */
  async getExactContent(companyId: string, content: string) {
    assertCompanyId(companyId);
    return this.repo.findByExactContent(companyId, content);
  }

  /** C2 — Ranked search (pg_trgm). Errors propagate directly. */
  async searchRanked(companyId: string, query: string, limit?: number) {
    assertCompanyId(companyId);
    return this.repo.searchRanked(companyId, query, limit);
  }

  /** C2 — Retrieve by type */
  async getByType(companyId: string, type: string) {
    assertCompanyId(companyId);
    return this.repo.findByType(companyId, type);
  }

  // ─── C3 — Relate ───────────────────────────────────────────────

  async relate(input: RelateInput, companyId: string) {
    assertCompanyId(companyId);
    // Repository validates both items belong to companyId
    const relationship = await this.repo.createRelationship(input, companyId);

    // C8: traceability
    await this.repo.addTraceabilityLog({
      itemId: input.sourceId,
      action: 'related',
      actor: 'system',
      details: { targetId: input.targetId, label: input.label },
    });

    return relationship;
  }

  async getRelationships(id: string, companyId: string) {
    assertCompanyId(companyId);
    return this.repo.getRelationships(id, companyId);
  }

  // ─── C4 — Update ───────────────────────────────────────────────

  async update(id: string, newContent: string, companyId: string) {
    assertCompanyId(companyId);
    // Read current content BEFORE update for traceability
    const current = await this.repo.findById(id, companyId);
    if (!current) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }
    const oldContent = current.content;

    // Repository validates companyId before update
    const updated = await this.repo.update({ id, content: newContent }, companyId);

    // C8: traceability — previousContent is the OLD content (before update)
    await this.repo.addTraceabilityLog({
      itemId: id,
      action: 'updated',
      actor: 'system',
      details: { previousContent: oldContent },
    });

    return updated;
  }

  // ─── C5 — Version History ──────────────────────────────────────

  async getVersionHistory(id: string, companyId: string) {
    assertCompanyId(companyId);
    return this.repo.getVersions(id, companyId);
  }

  // ─── C6 — Retrieve by Type ─────────────────────────────────────

  // Handled by getByType in C2

  // ─── C7 — Consistency Verification ─────────────────────────────

  /** C7 — Deterministic contradiction detection only */
  async verifyConsistency(
    itemAId: string,
    itemBId: string,
    companyId: string,
  ): Promise<ContradictionResult> {
    assertCompanyId(companyId);

    // Repository validates both items belong to companyId
    const itemA = await this.repo.findById(itemAId, companyId);
    if (!itemA) {
      throw new MemoryError(`MemoryItem not found: ${itemAId}`, 'NOT_FOUND');
    }
    const itemB = await this.repo.findById(itemBId, companyId);
    if (!itemB) {
      throw new MemoryError(`MemoryItem not found: ${itemBId}`, 'NOT_FOUND');
    }

    // Delegate to deterministic detector ONLY
    const result = detectDeterministic(
      { content: itemA.content },
      { content: itemB.content },
    );

    // If contradiction found, persist it
    if (result.isContradiction) {
      await this.repo.createContradiction({
        itemAId,
        itemBId,
        evidence: result.evidence,
        confidence: result.confidence,
      }, companyId);

      // C8: traceability
      await this.repo.addTraceabilityLog({
        itemId: itemAId,
        action: 'contradiction_detected',
        actor: 'system',
        details: { itemBId, type: result.type, confidence: result.confidence },
      });
    }

    return result;
  }

  // ─── C8 — Traceability ─────────────────────────────────────────

  async getTraceability(id: string, companyId: string) {
    assertCompanyId(companyId);
    return this.repo.getTraceabilityLogs(id, companyId);
  }

  // ─── C9 — Evolve ───────────────────────────────────────────────

  async evolve(
    currentId: string,
    newContent: string,
    supersededById: string,
    companyId: string,
    linkType?: 'supersedes' | 'complements',
  ) {
    assertCompanyId(companyId);

    // Repository validates both items belong to companyId
    const current = await this.repo.findById(currentId, companyId);
    if (!current) {
      throw new MemoryError(`MemoryItem not found: ${currentId}`, 'NOT_FOUND');
    }
    const supersededBy = await this.repo.findById(supersededById, companyId);
    if (!supersededBy) {
      throw new MemoryError(`MemoryItem not found: ${supersededById}`, 'NOT_FOUND');
    }

    // Update current item with new content (creates version automatically)
    const updated = await this.repo.update({ id: currentId, content: newContent }, companyId);

    // Create evolution link — Repository validates both items
    const link = await this.repo.createEvolutionLink({
      supersededId: currentId,
      supersededById,
      linkType,
    }, companyId);

    // C8: traceability
    await this.repo.addTraceabilityLog({
      itemId: currentId,
      action: 'superseded',
      actor: 'system',
      details: { supersededById, linkType: linkType ?? 'supersedes' },
    });

    return { item: updated, link };
  }

  // ─── C10 — Forget ──────────────────────────────────────────────

  async forget(id: string, reason: string, companyId: string) {
    assertCompanyId(companyId);
    // Read current status BEFORE change for traceability
    const current = await this.repo.findById(id, companyId);
    if (!current) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }
    const previousStatus = current.status;

    // Repository validates companyId before setting status
    const updated = await this.repo.setStatus(id, 'forgotten', companyId, reason);
    if (!updated) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }

    // C8: traceability
    await this.repo.addTraceabilityLog({
      itemId: id,
      action: 'forgotten',
      actor: 'system',
      details: { previousStatus, newStatus: 'forgotten', reason },
    });

    return updated;
  }

  // ─── C10b — Confirm / Reject (P5 Human Validation) ───────────

  async confirm(id: string, companyId: string, actor: string) {
    assertCompanyId(companyId);
    // Read current status BEFORE change for traceability
    const current = await this.repo.findById(id, companyId);
    if (!current) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }
    const previousStatus = current.status;

    const updated = await this.repo.setStatus(id, 'confirmed', companyId);
    if (!updated) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }
    await this.repo.addTraceabilityLog({
      itemId: id,
      action: 'confirmed',
      actor: actor,
      details: { previousStatus, newStatus: 'confirmed' },
    });
    return updated;
  }

  async reject(id: string, companyId: string, actor: string, reason: string) {
    assertCompanyId(companyId);
    const trimmed = reason?.trim();
    if (!trimmed) {
      throw new MemoryError('Reject reason is required', 'BAD_REQUEST');
    }
    // Read current status BEFORE change for traceability
    const current = await this.repo.findById(id, companyId);
    if (!current) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }
    const previousStatus = current.status;

    const updated = await this.repo.setStatus(id, 'rejected', companyId, trimmed);
    if (!updated) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }
    await this.repo.addTraceabilityLog({
      itemId: id,
      action: 'rejected',
      actor: actor,
      details: { previousStatus, newStatus: 'rejected', reason: trimmed },
    });
    return updated;
  }

  // ─── C11 — Confidence ──────────────────────────────────────────

  async updateConfidence(
    id: string,
    newLevel: ConfidenceLevel,
    reason: string,
    companyId: string,
  ) {
    assertCompanyId(companyId);

    // Get current confidence for log — Repository validates companyId
    const current = await this.repo.findById(id, companyId);
    if (!current) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }
    const previousLevel = current.confidence as ConfidenceLevel;

    // Repository validates companyId before update
    const updated = await this.repo.updateConfidence(id, newLevel, companyId);
    if (!updated) {
      throw new MemoryError(`MemoryItem not found: ${id}`, 'NOT_FOUND');
    }

    await this.repo.createConfidenceLog({
      itemId: id,
      previousLevel,
      newLevel,
      reason,
    });

    // C8: traceability
    await this.repo.addTraceabilityLog({
      itemId: id,
      action: 'confidence_changed',
      actor: 'system',
      details: { previousLevel, newLevel, reason },
    });

    return updated;
  }

  async getConfidenceLogs(id: string, companyId: string) {
    assertCompanyId(companyId);
    return this.repo.getConfidenceLogs(id, companyId);
  }
}
