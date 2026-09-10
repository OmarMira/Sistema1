// Memory Core — Repository Tests (7.1 + fixes)
// Tests for Prisma-based memory repository with companyId isolation

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRepository } from '../../src/memory/repository';
import type { RecordInput } from '../../src/memory/types';
import type { TransactionRunner } from '../../src/memory/prisma-types';

// ─── Prisma Mock ──────────────────────────────────────────────────

function createMockPrisma() {
  const tx = {
    memoryItem: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    memoryVersion: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    relationship: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    contradiction: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    traceabilityLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    evolutionLink: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    confidenceLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  } as unknown as Parameters<typeof MemoryRepository>[0];

  return tx;
}

function createMockRunTx(mock: ReturnType<typeof createMockPrisma>): TransactionRunner {
  return async (fn) => fn(mock as never);
}

// ─── Tests ──────────────────────────────────────────────────────

describe('MemoryRepository', () => {
  let repo: MemoryRepository;
  let mock: ReturnType<typeof createMockPrisma>;
  let runTx: TransactionRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockPrisma();
    runTx = createMockRunTx(mock);
    repo = new MemoryRepository(mock, runTx);
  });

  // ─── C1 — create (with initial version) ─────────────────────

  describe('C1 — create (with C5 initial version)', () => {
    it('should create item + version 1 atomically', async () => {
      const input: RecordInput = {
        content: 'Test content',
        type: 'fact',
        companyId: 'company-1',
        sourceAuthor: 'user-1',
        sourceName: 'test',
      };

      const item = { id: 'item-1', ...input, confidence: 'tentative', status: 'active' };
      mock.memoryItem.create.mockResolvedValue(item);
      mock.memoryVersion.create.mockResolvedValue({});

      const result = await repo.create(input);

      // Verify item created
      expect(result).toEqual(item);
      expect(mock.memoryItem.create).toHaveBeenCalledTimes(1);

      // C5: initial version must be created
      expect(mock.memoryVersion.create).toHaveBeenCalledTimes(1);
      expect(mock.memoryVersion.create).toHaveBeenCalledWith({
        data: {
          itemId: 'item-1',
          versionNumber: 1,
          content: 'Test content',
          snapshot: item,
        },
      });
    });

    it('should throw if version creation fails — no partial state', async () => {
      const input: RecordInput = {
        content: 'Test content',
        type: 'fact',
        companyId: 'company-1',
        sourceAuthor: 'user-1',
        sourceName: 'test',
      };

      // Simulate version creation failing
      mock.memoryItem.create.mockResolvedValue({ id: 'item-1', content: 'Test content' });
      mock.memoryVersion.create.mockRejectedValue(new Error('DB error'));

      await expect(repo.create(input)).rejects.toThrow('DB error');

      // Item create was called but transaction rolled back — no partial state
      expect(mock.memoryItem.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── C2 — findById (companyId scoped) ───────────────────────

  describe('C2 — findById', () => {
    it('should find an item by id + companyId', async () => {
      const expected = { id: 'item-1', content: 'Test', companyId: 'company-1' };
      mock.memoryItem.findFirst.mockResolvedValue(expected);

      const result = await repo.findById('item-1', 'company-1');

      expect(result).toEqual(expected);
      expect(mock.memoryItem.findFirst).toHaveBeenCalledWith({
        where: { id: 'item-1', companyId: 'company-1' },
      });
    });

    it('should return null for wrong companyId', async () => {
      mock.memoryItem.findFirst.mockResolvedValue(null);

      const result = await repo.findById('item-1', 'wrong-company');

      expect(result).toBeNull();
      expect(mock.memoryItem.findFirst).toHaveBeenCalledWith({
        where: { id: 'item-1', companyId: 'wrong-company' },
      });
    });
  });

  // ─── C2 — findByType ────────────────────────────────────────

  describe('C2 — findByType', () => {
    it('should find items by type', async () => {
      const expected = [{ id: 'item-1', type: 'fact' }];
      mock.memoryItem.findMany.mockResolvedValue(expected);

      const result = await repo.findByType('company-1', 'fact');

      expect(result).toEqual(expected);
      expect(mock.memoryItem.findMany).toHaveBeenCalledWith({
        where: { companyId: 'company-1', type: 'fact', status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  // ─── C2 — search ────────────────────────────────────────────

  describe('C2 — search', () => {
    it('should search items by content', async () => {
      const expected = [{ id: 'item-1', content: 'Test content' }];
      mock.memoryItem.findMany.mockResolvedValue(expected);

      const result = await repo.search('company-1', 'Test');

      expect(result).toEqual(expected);
    });
  });

  // ─── C3 — createRelationship (companyId scoped) ────────────

  describe('C3 — createRelationship', () => {
    it('should create a relationship after validating both items', async () => {
      const source = { id: 'a', companyId: 'company-1' };
      const target = { id: 'b', companyId: 'company-1' };
      mock.memoryItem.findFirst
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(target);

      const expected = { id: 'rel-1', sourceId: 'a', targetId: 'b', label: 'supports' };
      mock.relationship.create.mockResolvedValue(expected);

      const result = await repo.createRelationship(
        { sourceId: 'a', targetId: 'b', label: 'supports' },
        'company-1',
      );

      expect(result).toEqual(expected);
      expect(mock.relationship.create).toHaveBeenCalledTimes(1);
    });

    it('should throw if source not in company', async () => {
      mock.memoryItem.findFirst.mockResolvedValueOnce(null);

      await expect(
        repo.createRelationship(
          { sourceId: 'a', targetId: 'b', label: 'supports' },
          'company-1',
        ),
      ).rejects.toThrow(/Source item not found or not accessible/);
    });

    it('should throw if target not in company', async () => {
      const source = { id: 'a', companyId: 'company-1' };
      mock.memoryItem.findFirst
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(null);

      await expect(
        repo.createRelationship(
          { sourceId: 'a', targetId: 'b', label: 'supports' },
          'company-1',
        ),
      ).rejects.toThrow(/Target item not found or not accessible/);
    });
  });

  // ─── C4/C5 — update with atomic versioning (companyId) ─────

  describe('C4/C5 — update (atomic versioning)', () => {
    it('should create version + update content atomically', async () => {
      const current = { id: 'item-1', content: 'old content', companyId: 'company-1' };
      const updated = { id: 'item-1', content: 'new content' };

      mock.memoryItem.findFirst.mockResolvedValue(current);
      mock.memoryVersion.findFirst.mockResolvedValue({ versionNumber: 2 });
      mock.memoryVersion.create.mockResolvedValue({});
      mock.memoryItem.update.mockResolvedValue(updated);

      const result = await repo.update({ id: 'item-1', content: 'new content' }, 'company-1');

      expect(result).toEqual(updated);

      // C5: version number = max(2) + 1 = 3
      expect(mock.memoryVersion.create).toHaveBeenCalledWith({
        data: {
          itemId: 'item-1',
          versionNumber: 3,
          content: 'old content',
          snapshot: current,
        },
      });
    });

    it('should start at version 2 on first update (after initial v1)', async () => {
      const current = { id: 'item-1', content: 'original', companyId: 'company-1' };
      const updated = { id: 'item-1', content: 'first update' };

      mock.memoryItem.findFirst.mockResolvedValue(current);
      // After create(), version 1 exists — findFirst returns it
      mock.memoryVersion.findFirst.mockResolvedValue({ versionNumber: 1 });
      mock.memoryVersion.create.mockResolvedValue({});
      mock.memoryItem.update.mockResolvedValue(updated);

      await repo.update({ id: 'item-1', content: 'first update' }, 'company-1');

      // max(1) + 1 = 2
      expect(mock.memoryVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ versionNumber: 2 }),
        })
      );
    });

    it('should throw if item not in company', async () => {
      mock.memoryItem.findFirst.mockResolvedValue(null);

      await expect(
        repo.update({ id: 'nonexistent', content: 'new' }, 'company-1')
      ).rejects.toThrow('MemoryItem not found or not accessible: nonexistent');

      // No version created
      expect(mock.memoryVersion.create).not.toHaveBeenCalled();
    });

    it('should not create partial version if item update fails', async () => {
      const current = { id: 'item-1', content: 'old content', companyId: 'company-1' };

      mock.memoryItem.findFirst.mockResolvedValue(current);
      mock.memoryVersion.findFirst.mockResolvedValue({ versionNumber: 1 });
      mock.memoryVersion.create.mockResolvedValue({});
      mock.memoryItem.update.mockRejectedValue(new Error('Update failed'));

      await expect(
        repo.update({ id: 'item-1', content: 'new content' }, 'company-1')
      ).rejects.toThrow('Update failed');

      // Transaction rolled back — no persistent partial state
      expect(mock.memoryVersion.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── C5 — getVersions (companyId scoped) ───────────────────

  describe('C5 — getVersions', () => {
    it('should return versions in ascending order', async () => {
      const item = { id: 'item-1', companyId: 'company-1' };
      mock.memoryItem.findFirst.mockResolvedValue(item);

      const expected = [
        { versionNumber: 1, content: 'v1' },
        { versionNumber: 2, content: 'v2' },
        { versionNumber: 3, content: 'v3' },
      ];
      mock.memoryVersion.findMany.mockResolvedValue(expected);

      const result = await repo.getVersions('item-1', 'company-1');

      expect(result).toEqual(expected);
      expect(mock.memoryVersion.findMany).toHaveBeenCalledWith({
        where: { itemId: 'item-1' },
        orderBy: { versionNumber: 'asc' },
      });
    });

    it('should return empty for wrong company', async () => {
      mock.memoryItem.findFirst.mockResolvedValue(null);

      const result = await repo.getVersions('item-1', 'wrong-company');

      expect(result).toEqual([]);
      expect(mock.memoryVersion.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── C8 — addTraceabilityLog ────────────────────────────────

  describe('C8 — addTraceabilityLog', () => {
    it('should create a traceability log', async () => {
      const expected = { id: 'log-1', action: 'recorded' };
      mock.traceabilityLog.create.mockResolvedValue(expected);

      const result = await repo.addTraceabilityLog({
        itemId: 'item-1',
        action: 'recorded',
        actor: 'user-1',
        details: { source: 'test' },
      });

      expect(result).toEqual(expected);
    });
  });

  // ─── C10 — setStatus (companyId scoped) ────────────────────

  describe('C10 — setStatus', () => {
    it('should update status with reason', async () => {
      const item = { id: 'item-1', companyId: 'company-1' };
      mock.memoryItem.findFirst.mockResolvedValue(item);

      const expected = { id: 'item-1', status: 'forgotten', forgetReason: 'outdated' };
      mock.memoryItem.update.mockResolvedValue(expected);

      const result = await repo.setStatus('item-1', 'forgotten', 'company-1', 'outdated');

      expect(result).toEqual(expected);
      expect(mock.memoryItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { status: 'forgotten', forgetReason: 'outdated' },
      });
    });

    it('should return null for wrong company', async () => {
      mock.memoryItem.findFirst.mockResolvedValue(null);

      const result = await repo.setStatus('item-1', 'forgotten', 'wrong-company', 'reason');

      expect(result).toBeNull();
      expect(mock.memoryItem.update).not.toHaveBeenCalled();
    });
  });

  // ─── C11 — updateConfidence (companyId scoped) ─────────────

  describe('C11 — updateConfidence', () => {
    it('should update confidence level', async () => {
      const item = { id: 'item-1', companyId: 'company-1' };
      mock.memoryItem.findFirst.mockResolvedValue(item);

      const expected = { id: 'item-1', confidence: 'certain' };
      mock.memoryItem.update.mockResolvedValue(expected);

      const result = await repo.updateConfidence('item-1', 'certain', 'company-1');

      expect(result).toEqual(expected);
    });

    it('should return null for wrong company', async () => {
      mock.memoryItem.findFirst.mockResolvedValue(null);

      const result = await repo.updateConfidence('item-1', 'certain', 'wrong-company');

      expect(result).toBeNull();
      expect(mock.memoryItem.update).not.toHaveBeenCalled();
    });
  });

  // ─── C9 — createEvolutionLink (companyId scoped) ───────────

  describe('C9 — createEvolutionLink', () => {
    it('should create link after validating both items', async () => {
      const current = { id: 'old', companyId: 'company-1' };
      const supersededBy = { id: 'new', companyId: 'company-1' };
      mock.memoryItem.findFirst
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(supersededBy);

      const expected = { id: 'link-1', supersededId: 'old', supersededById: 'new', linkType: 'supersedes' };
      mock.evolutionLink.create.mockResolvedValue(expected);

      const result = await repo.createEvolutionLink(
        { supersededId: 'old', supersededById: 'new' },
        'company-1',
      );

      expect(result).toEqual(expected);
    });

    it('should throw if current item not in company', async () => {
      mock.memoryItem.findFirst.mockResolvedValueOnce(null);

      await expect(
        repo.createEvolutionLink(
          { supersededId: 'old', supersededById: 'new' },
          'company-1',
        ),
      ).rejects.toThrow(/Current item not found or not accessible/);
    });
  });
});
