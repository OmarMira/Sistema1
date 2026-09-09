// Memory Core — Repository (C1-C6, C8-C11)
// Prisma-based data access layer with companyId isolation at the boundary

import { Prisma, MemoryStatus, ConfidenceLevel } from '@prisma/client';
import type {
  RecordInput,
  RelateInput,
  UpdateInput,
  SearchResult,
} from './types';
import type { MemoryPrismaClient, TransactionRunner } from './prisma-types';

export class MemoryRepository {
  constructor(
    private readonly prisma: MemoryPrismaClient,
    private readonly runTx: TransactionRunner,
  ) {}

  // ─── C1 — Record ───────────────────────────────────────────────

  /**
   * C1 — Record with C5 initial version (atomic via TransactionRunner).
   * MemoryItem + MemoryVersion persist together or not at all.
   */
  async create(input: RecordInput) {
    return this.runTx(async (tx) => {
      const item = await tx.memoryItem.create({
        data: {
          content: input.content,
          type: input.type,
          companyId: input.companyId,
          sourceAuthor: input.sourceAuthor,
          sourceName: input.sourceName,
          sourceObservedAt: input.sourceObservedAt,
          confidence: input.confidence ?? 'tentative',
        },
      });

      // C5: initial version (version 1) — the first snapshot
      await tx.memoryVersion.create({
        data: {
          itemId: item.id,
          versionNumber: 1,
          content: item.content,
          snapshot: item as unknown as Prisma.InputJsonValue,
        },
      });

      return item;
    });
  }

  // ─── C2 — Retrieve ─────────────────────────────────────────────

  /**
   * C2 — Find by ID scoped to companyId.
   * Returns null if item does not exist or does not belong to companyId.
   */
  async findById(id: string, companyId: string) {
    return this.prisma.memoryItem.findFirst({
      where: { id, companyId },
    });
  }

  async findByType(companyId: string, type: string) {
    return this.prisma.memoryItem.findMany({
      where: { companyId, type, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async search(companyId: string, query: string) {
    return this.prisma.memoryItem.findMany({
      where: {
        companyId,
        status: 'active',
        content: { contains: query, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * C2 — Search with pg_trgm ranking.
   * Uses PostgreSQL pg_trgm for similarity-based ranking.
   * Errors propagate directly — no silent fallback.
   */
  async searchRanked(companyId: string, query: string, limit = 50): Promise<SearchResult[]> {
    const results = await this.prisma.$queryRaw<
      Array<{ id: string; rank: number }>
    >`
      SELECT id, similarity(content, ${query}) AS rank
      FROM "MemoryItem"
      WHERE "companyId" = ${companyId}
        AND status = 'active'
        AND content ILIKE ${'%' + query + '%'}
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    if (results.length === 0) return [];

    const ids = results.map((r) => r.id);
    const items = await this.prisma.memoryItem.findMany({
      where: { id: { in: ids }, companyId },
    });

    const itemMap = new Map(items.map((item) => [item.id, item]));
    return results
      .map((r) => ({ item: itemMap.get(r.id)!, rank: r.rank }))
      .filter((r) => r.item);
  }

  // ─── C2 — Exact Content ────────────────────────────────────────

  /** C2 — Find by exact content within a company */
  async findByExactContent(companyId: string, content: string) {
    return this.prisma.memoryItem.findFirst({
      where: { companyId, content, status: 'active' },
    });
  }

  // ─── C3 — Relate ───────────────────────────────────────────────

  /**
   * C3 — Create relationship.
   * Validates both items belong to the same companyId before creating.
   */
  async createRelationship(input: RelateInput, companyId: string) {
    // Validate both items exist and belong to the same company
    const source = await this.findById(input.sourceId, companyId);
    if (!source) {
      throw new Error(`Source item not found or not accessible: ${input.sourceId}`);
    }
    const target = await this.findById(input.targetId, companyId);
    if (!target) {
      throw new Error(`Target item not found or not accessible: ${input.targetId}`);
    }

    return this.prisma.relationship.create({
      data: {
        sourceId: input.sourceId,
        targetId: input.targetId,
        label: input.label,
      },
    });
  }

  async getRelationships(itemId: string, companyId: string) {
    // Validate item exists within company
    const item = await this.findById(itemId, companyId);
    if (!item) return [];

    return this.prisma.relationship.findMany({
      where: {
        OR: [{ sourceId: itemId }, { targetId: itemId }],
      },
      include: { source: true, target: true },
    });
  }

  // ─── C4/C5 — Update / Version ──────────────────────────────────

  /**
   * C4/C5 — Update with companyId validation and atomic versioning.
   * read current + create version + update current — all within one transaction.
   */
  async update(input: UpdateInput, companyId: string) {
    return this.runTx(async (tx) => {
      // Get current item for version snapshot — scoped to company
      const current = await tx.memoryItem.findFirst({
        where: { id: input.id, companyId },
      });
      if (!current) throw new Error(`MemoryItem not found or not accessible: ${input.id}`);

      // C5: determine next version number from max existing version
      const lastVersion = await tx.memoryVersion.findFirst({
        where: { itemId: input.id },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });
      const nextVersionNumber = (lastVersion?.versionNumber ?? 0) + 1;

      // Create version record (append-only)
      await tx.memoryVersion.create({
        data: {
          itemId: input.id,
          versionNumber: nextVersionNumber,
          content: current.content,
          snapshot: current as unknown as Prisma.InputJsonValue,
        },
      });

      // Update current content
      return tx.memoryItem.update({
        where: { id: input.id },
        data: { content: input.content },
      });
    });
  }

  async getVersions(itemId: string, companyId: string) {
    // Validate item exists within company
    const item = await this.findById(itemId, companyId);
    if (!item) return [];

    return this.prisma.memoryVersion.findMany({
      where: { itemId },
      orderBy: { versionNumber: 'asc' },
    });
  }

  // ─── C6 — Distinguish Types ────────────────────────────────────

  // Handled by findByType in C2 — type is a field, not a separate model

  // ─── C7 — Contradiction (persistence only) ─────────────────────

  /**
   * C7 — Create contradiction record.
   * Validates both items belong to the same companyId.
   */
  async createContradiction(data: {
    itemAId: string;
    itemBId: string;
    evidence: string;
    confidence: number;
  }, companyId: string) {
    // Validate both items exist within company
    const itemA = await this.findById(data.itemAId, companyId);
    if (!itemA) throw new Error(`Item A not found or not accessible: ${data.itemAId}`);
    const itemB = await this.findById(data.itemBId, companyId);
    if (!itemB) throw new Error(`Item B not found or not accessible: ${data.itemBId}`);

    return this.prisma.contradiction.create({ data });
  }

  async findContradictions(itemId: string, companyId: string) {
    // Validate item exists within company
    const item = await this.findById(itemId, companyId);
    if (!item) return [];

    return this.prisma.contradiction.findMany({
      where: {
        OR: [{ itemAId: itemId }, { itemBId: itemId }],
      },
    });
  }

  // ─── C8 — Traceability ─────────────────────────────────────────

  async addTraceabilityLog(data: {
    itemId: string;
    action: string;
    actor: string;
    details: Record<string, unknown>;
  }) {
    return this.prisma.traceabilityLog.create({
      data: {
        itemId: data.itemId,
        action: data.action,
        actor: data.actor,
        details: data.details as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async getTraceabilityLogs(itemId: string, companyId: string) {
    // Validate item exists within company
    const item = await this.findById(itemId, companyId);
    if (!item) return [];

    return this.prisma.traceabilityLog.findMany({
      where: { itemId },
      orderBy: { timestamp: 'asc' },
    });
  }

  // ─── C9 — Evolve ───────────────────────────────────────────────

  /**
   * C9 — Create evolution link.
   * Validates both items belong to the same companyId.
   */
  async createEvolutionLink(data: {
    supersededId: string;
    supersededById: string;
    linkType?: string;
  }, companyId: string) {
    // Validate both items exist within company
    const current = await this.findById(data.supersededId, companyId);
    if (!current) throw new Error(`Current item not found or not accessible: ${data.supersededId}`);
    const supersededBy = await this.findById(data.supersededById, companyId);
    if (!supersededBy) throw new Error(`Superseding item not found or not accessible: ${data.supersededById}`);

    return this.prisma.evolutionLink.create({
      data: {
        supersededId: data.supersededId,
        supersededById: data.supersededById,
        linkType: data.linkType ?? 'supersedes',
      },
    });
  }

  async getEvolutionLinks(itemId: string, companyId: string) {
    // Validate item exists within company
    const item = await this.findById(itemId, companyId);
    if (!item) return [];

    return this.prisma.evolutionLink.findMany({
      where: {
        OR: [
          { supersededId: itemId },
          { supersededById: itemId },
        ],
      },
    });
  }

  // ─── C10 — Forget ──────────────────────────────────────────────

  /**
   * C10 — Set status with companyId validation.
   * Returns null if item does not exist or does not belong to companyId.
   */
  async setStatus(id: string, status: MemoryStatus, companyId: string, reason?: string) {
    // Validate item exists within company
    const item = await this.findById(id, companyId);
    if (!item) return null;

    return this.prisma.memoryItem.update({
      where: { id },
      data: {
        status,
        ...(reason ? { forgetReason: reason } : {}),
      },
    });
  }

  // ─── C11 — Confidence ──────────────────────────────────────────

  /**
   * C11 — Update confidence with companyId validation.
   * Returns null if item does not exist or does not belong to companyId.
   */
  async updateConfidence(id: string, level: ConfidenceLevel, companyId: string) {
    // Validate item exists within company
    const item = await this.findById(id, companyId);
    if (!item) return null;

    return this.prisma.memoryItem.update({
      where: { id },
      data: { confidence: level },
    });
  }

  async createConfidenceLog(data: {
    itemId: string;
    previousLevel: ConfidenceLevel;
    newLevel: ConfidenceLevel;
    reason: string;
  }) {
    return this.prisma.confidenceLog.create({ data });
  }

  async getConfidenceLogs(itemId: string, companyId: string) {
    // Validate item exists within company
    const item = await this.findById(itemId, companyId);
    if (!item) return [];

    return this.prisma.confidenceLog.findMany({
      where: { itemId },
      orderBy: { changedAt: 'asc' },
    });
  }
}
