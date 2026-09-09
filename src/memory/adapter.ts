// Memory Core — Adapter (Task 6.1)
// Translates external/internal operations to MemoryService
// Flow: Adapter → Service → Repository

import type { ConfidenceLevel } from '@prisma/client';
import { MemoryService, MemoryError } from './service';
import type {
  RecordInput,
  RelateInput,
  SearchResult,
  ContradictionResult,
} from './types';
import type { MemoryPrismaClient, TransactionRunner } from './prisma-types';

// ─── Adapter ──────────────────────────────────────────────────────

export class MemoryAdapter {
  private readonly service: MemoryService;

  constructor(
    prisma: MemoryPrismaClient,
    runTx: TransactionRunner,
  ) {
    this.service = new MemoryService(prisma, runTx);
  }

  // ─── C1 — Record ───────────────────────────────────────────────

  async record(input: RecordInput) {
    return this.service.record(input);
  }

  // ─── C2 — Retrieve ─────────────────────────────────────────────

  async getById(id: string, companyId: string) {
    return this.service.getById(id, companyId);
  }

  async getExactContent(companyId: string, content: string) {
    return this.service.getExactContent(companyId, content);
  }

  async searchRanked(companyId: string, query: string, limit?: number): Promise<SearchResult[]> {
    return this.service.searchRanked(companyId, query, limit);
  }

  async getByType(companyId: string, type: string) {
    return this.service.getByType(companyId, type);
  }

  // ─── C3 — Relate ───────────────────────────────────────────────

  async relate(input: RelateInput, companyId: string) {
    return this.service.relate(input, companyId);
  }

  async getRelationships(id: string, companyId: string) {
    return this.service.getRelationships(id, companyId);
  }

  // ─── C4 — Update ───────────────────────────────────────────────

  async update(id: string, newContent: string, companyId: string) {
    return this.service.update(id, newContent, companyId);
  }

  // ─── C5 — Version History ──────────────────────────────────────

  async getVersionHistory(id: string, companyId: string) {
    return this.service.getVersionHistory(id, companyId);
  }

  // ─── C6 — Type ─────────────────────────────────────────────────

  // Handled by getByType in C2

  // ─── C7 — Consistency ──────────────────────────────────────────

  async verifyConsistency(
    itemAId: string,
    itemBId: string,
    companyId: string,
  ): Promise<ContradictionResult> {
    return this.service.verifyConsistency(itemAId, itemBId, companyId);
  }

  // ─── C8 — Traceability ─────────────────────────────────────────

  async getTraceability(id: string, companyId: string) {
    return this.service.getTraceability(id, companyId);
  }

  // ─── C9 — Evolve ───────────────────────────────────────────────

  async evolve(
    currentId: string,
    newContent: string,
    supersededById: string,
    companyId: string,
    linkType?: 'supersedes' | 'complements',
  ) {
    return this.service.evolve(currentId, newContent, supersededById, companyId, linkType);
  }

  // ─── C10 — Forget ──────────────────────────────────────────────

  async forget(id: string, reason: string, companyId: string) {
    return this.service.forget(id, reason, companyId);
  }

  // ─── C11 — Confidence ──────────────────────────────────────────

  async updateConfidence(
    id: string,
    newLevel: ConfidenceLevel,
    reason: string,
    companyId: string,
  ) {
    return this.service.updateConfidence(id, newLevel, reason, companyId);
  }

  async getConfidenceLogs(id: string, companyId: string) {
    return this.service.getConfidenceLogs(id, companyId);
  }
}

// Re-export MemoryError for consumers
export { MemoryError };
