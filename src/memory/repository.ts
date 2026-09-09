// Memory Core — Repository (C1-C6, C8-C11)
// Prisma-based data access layer

import { PrismaClient, Prisma, MemoryStatus, ConfidenceLevel } from '@prisma/client';
import type {
  RecordInput,
  RelateInput,
  UpdateInput,
  SearchResult,
} from './types';

export class MemoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── C1 — Record ───────────────────────────────────────────────

  async create(input: RecordInput) {
    // C5: create item + initial version atomically
    return this.prisma.$transaction(async (tx) => {
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

  async findById(id: string) {
    return this.prisma.memoryItem.findUnique({ where: { id } });
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
   * Falls back to ILIKE-based ordering if pg_trgm is not available.
   */
  async searchRanked(companyId: string, query: string, limit = 50): Promise<SearchResult[]> {
    try {
      // Try pg_trgm similarity ranking
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
        where: { id: { in: ids } },
      });

      const itemMap = new Map(items.map((item) => [item.id, item]));
      return results
        .map((r) => ({ item: itemMap.get(r.id)!, rank: r.rank }))
        .filter((r) => r.item);
    } catch {
      // Fallback: basic ILIKE search without ranking
      const items = await this.search(companyId, query);
      return items.map((item, index) => ({ item, rank: 1 / (index + 1) }));
    }
  }

  // ─── C3 — Relate ───────────────────────────────────────────────

  async createRelationship(input: RelateInput) {
    return this.prisma.relationship.create({
      data: {
        sourceId: input.sourceId,
        targetId: input.targetId,
        label: input.label,
      },
    });
  }

  async getRelationships(itemId: string) {
    return this.prisma.relationship.findMany({
      where: {
        OR: [{ sourceId: itemId }, { targetId: itemId }],
      },
      include: { source: true, target: true },
    });
  }

  // ─── C4/C5 — Update / Version ──────────────────────────────────

  async update(input: UpdateInput) {
    // C4/C5: atomic operation — version creation + item update in one transaction
    return this.prisma.$transaction(async (tx) => {
      // Get current item for version snapshot
      const current = await tx.memoryItem.findUnique({
        where: { id: input.id },
      });
      if (!current) throw new Error(`MemoryItem not found: ${input.id}`);

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

  async getVersions(itemId: string) {
    return this.prisma.memoryVersion.findMany({
      where: { itemId },
      orderBy: { versionNumber: 'asc' },
    });
  }

  // ─── C6 — Distinguish Types ────────────────────────────────────

  // Handled by findByType in C2 — type is a field, not a separate model

  // ─── C7 — Contradiction (persistence only) ─────────────────────

  async createContradiction(data: {
    itemAId: string;
    itemBId: string;
    evidence: string;
    confidence: number;
  }) {
    return this.prisma.contradiction.create({ data });
  }

  async findContradictions(itemId: string) {
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

  async getTraceabilityLogs(itemId: string) {
    return this.prisma.traceabilityLog.findMany({
      where: { itemId },
      orderBy: { timestamp: 'asc' },
    });
  }

  // ─── C9 — Evolve ───────────────────────────────────────────────

  async createEvolutionLink(data: {
    supersededId: string;
    supersededById: string;
    linkType?: string;
  }) {
    return this.prisma.evolutionLink.create({
      data: {
        supersededId: data.supersededId,
        supersededById: data.supersededById,
        linkType: data.linkType ?? 'supersedes',
      },
    });
  }

  async getEvolutionLinks(itemId: string) {
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

  async setStatus(id: string, status: MemoryStatus, reason?: string) {
    return this.prisma.memoryItem.update({
      where: { id },
      data: {
        status,
        ...(reason ? { forgetReason: reason } : {}),
      },
    });
  }

  // ─── C11 — Confidence ──────────────────────────────────────────

  async updateConfidence(id: string, level: ConfidenceLevel) {
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

  async getConfidenceLogs(itemId: string) {
    return this.prisma.confidenceLog.findMany({
      where: { itemId },
      orderBy: { changedAt: 'asc' },
    });
  }
}
