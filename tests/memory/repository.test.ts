// Memory Core — Repository Tests (7.1 + fixes)
// Tests for Prisma-based memory repository

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRepository } from '../../src/memory/repository';
import type { RecordInput } from '../../src/memory/types';

// ─── Prisma Mock (transactional) ─────────────────────────────────

function createMockPrisma() {
  const tx = {
    memoryItem: {
      create: vi.fn(),
      findUnique: vi.fn(),
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

  // $transaction: runs the callback with the mock tx
  (tx as any).$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(tx));

  return tx;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('MemoryRepository', () => {
  let repo: MemoryRepository;
  let mock: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockPrisma();
    repo = new MemoryRepository(mock);
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
      (mock as any).memoryItem.create.mockResolvedValue(item);
      (mock as any).memoryVersion.create.mockResolvedValue({});

      const result = await repo.create(input);

      // Verify item created
      expect(result).toEqual(item);
      expect((mock as any).memoryItem.create).toHaveBeenCalledTimes(1);

      // C5: initial version must be created
      expect((mock as any).memoryVersion.create).toHaveBeenCalledTimes(1);
      expect((mock as any).memoryVersion.create).toHaveBeenCalledWith({
        data: {
          itemId: 'item-1',
          versionNumber: 1,
          content: 'Test content',
          snapshot: item,
        },
      });

      // Verify transaction was used
      expect((mock as any).$transaction).toHaveBeenCalledTimes(1);
    });

    it('should throw if transaction fails — no partial state', async () => {
      const input: RecordInput = {
        content: 'Test content',
        type: 'fact',
        companyId: 'company-1',
        sourceAuthor: 'user-1',
        sourceName: 'test',
      };

      // Simulate version creation failing
      (mock as any).memoryItem.create.mockResolvedValue({ id: 'item-1', content: 'Test content' });
      (mock as any).memoryVersion.create.mockRejectedValue(new Error('DB error'));

      await expect(repo.create(input)).rejects.toThrow('DB error');

      // Item create was called but transaction rolled back — no partial state
      expect((mock as any).memoryItem.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── C2 — findById ──────────────────────────────────────────

  describe('C2 — findById', () => {
    it('should find an item by id', async () => {
      const expected = { id: 'item-1', content: 'Test' };
      (mock as any).memoryItem.findUnique.mockResolvedValue(expected);

      const result = await repo.findById('item-1');

      expect(result).toEqual(expected);
      expect((mock as any).memoryItem.findUnique).toHaveBeenCalledWith({
        where: { id: 'item-1' },
      });
    });
  });

  // ─── C2 — findByType ────────────────────────────────────────

  describe('C2 — findByType', () => {
    it('should find items by type', async () => {
      const expected = [{ id: 'item-1', type: 'fact' }];
      (mock as any).memoryItem.findMany.mockResolvedValue(expected);

      const result = await repo.findByType('company-1', 'fact');

      expect(result).toEqual(expected);
      expect((mock as any).memoryItem.findMany).toHaveBeenCalledWith({
        where: { companyId: 'company-1', type: 'fact', status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  // ─── C2 — search ────────────────────────────────────────────

  describe('C2 — search', () => {
    it('should search items by content', async () => {
      const expected = [{ id: 'item-1', content: 'Test content' }];
      (mock as any).memoryItem.findMany.mockResolvedValue(expected);

      const result = await repo.search('company-1', 'Test');

      expect(result).toEqual(expected);
    });
  });

  // ─── C3 — createRelationship ────────────────────────────────

  describe('C3 — createRelationship', () => {
    it('should create a relationship', async () => {
      const expected = { id: 'rel-1', sourceId: 'a', targetId: 'b', label: 'supports' };
      (mock as any).relationship.create.mockResolvedValue(expected);

      const result = await repo.createRelationship({
        sourceId: 'a',
        targetId: 'b',
        label: 'supports',
      });

      expect(result).toEqual(expected);
    });
  });

  // ─── C4/C5 — update with atomic versioning ──────────────────

  describe('C4/C5 — update (atomic versioning)', () => {
    it('should create version + update content atomically', async () => {
      const current = { id: 'item-1', content: 'old content', versionNumber: undefined };
      const updated = { id: 'item-1', content: 'new content' };

      (mock as any).memoryItem.findUnique.mockResolvedValue(current);
      (mock as any).memoryVersion.findFirst.mockResolvedValue({ versionNumber: 2 });
      (mock as any).memoryVersion.create.mockResolvedValue({});
      (mock as any).memoryItem.update.mockResolvedValue(updated);

      const result = await repo.update({ id: 'item-1', content: 'new content' });

      expect(result).toEqual(updated);

      // C5: version number = max(2) + 1 = 3
      expect((mock as any).memoryVersion.create).toHaveBeenCalledWith({
        data: {
          itemId: 'item-1',
          versionNumber: 3,
          content: 'old content',
          snapshot: current,
        },
      });

      // Transaction used
      expect((mock as any).$transaction).toHaveBeenCalledTimes(1);
    });

    it('should start at version 2 on first update (after initial v1)', async () => {
      const current = { id: 'item-1', content: 'original' };
      const updated = { id: 'item-1', content: 'first update' };

      (mock as any).memoryItem.findUnique.mockResolvedValue(current);
      // After create(), version 1 exists — findFirst returns it
      (mock as any).memoryVersion.findFirst.mockResolvedValue({ versionNumber: 1 });
      (mock as any).memoryVersion.create.mockResolvedValue({});
      (mock as any).memoryItem.update.mockResolvedValue(updated);

      await repo.update({ id: 'item-1', content: 'first update' });

      // max(1) + 1 = 2
      expect((mock as any).memoryVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ versionNumber: 2 }),
        })
      );
    });

    it('should throw if item not found — transaction rolled back', async () => {
      (mock as any).memoryItem.findUnique.mockResolvedValue(null);

      await expect(
        repo.update({ id: 'nonexistent', content: 'new' })
      ).rejects.toThrow('MemoryItem not found: nonexistent');

      // No version created
      expect((mock as any).memoryVersion.create).not.toHaveBeenCalled();
    });

    it('should not create partial version if item update fails', async () => {
      const current = { id: 'item-1', content: 'old content' };

      (mock as any).memoryItem.findUnique.mockResolvedValue(current);
      (mock as any).memoryVersion.findFirst.mockResolvedValue({ versionNumber: 1 });
      (mock as any).memoryVersion.create.mockResolvedValue({});
      (mock as any).memoryItem.update.mockRejectedValue(new Error('Update failed'));

      await expect(
        repo.update({ id: 'item-1', content: 'new content' })
      ).rejects.toThrow('Update failed');

      // Transaction rolled back — no persistent partial state
      expect((mock as any).$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ─── C5 — getVersions ───────────────────────────────────────

  describe('C5 — getVersions', () => {
    it('should return versions in ascending order', async () => {
      const expected = [
        { versionNumber: 1, content: 'v1' },
        { versionNumber: 2, content: 'v2' },
        { versionNumber: 3, content: 'v3' },
      ];
      (mock as any).memoryVersion.findMany.mockResolvedValue(expected);

      const result = await repo.getVersions('item-1');

      expect(result).toEqual(expected);
      expect((mock as any).memoryVersion.findMany).toHaveBeenCalledWith({
        where: { itemId: 'item-1' },
        orderBy: { versionNumber: 'asc' },
      });
    });
  });

  // ─── C8 — addTraceabilityLog ────────────────────────────────

  describe('C8 — addTraceabilityLog', () => {
    it('should create a traceability log', async () => {
      const expected = { id: 'log-1', action: 'recorded' };
      (mock as any).traceabilityLog.create.mockResolvedValue(expected);

      const result = await repo.addTraceabilityLog({
        itemId: 'item-1',
        action: 'recorded',
        actor: 'user-1',
        details: { source: 'test' },
      });

      expect(result).toEqual(expected);
    });
  });

  // ─── C10 — setStatus ───────────────────────────────────────

  describe('C10 — setStatus', () => {
    it('should update status with reason', async () => {
      const expected = { id: 'item-1', status: 'forgotten', forgetReason: 'outdated' };
      (mock as any).memoryItem.update.mockResolvedValue(expected);

      const result = await repo.setStatus('item-1', 'forgotten', 'outdated');

      expect(result).toEqual(expected);
      expect((mock as any).memoryItem.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { status: 'forgotten', forgetReason: 'outdated' },
      });
    });
  });

  // ─── C11 — updateConfidence ─────────────────────────────────

  describe('C11 — updateConfidence', () => {
    it('should update confidence level', async () => {
      const expected = { id: 'item-1', confidence: 'certain' };
      (mock as any).memoryItem.update.mockResolvedValue(expected);

      const result = await repo.updateConfidence('item-1', 'certain');

      expect(result).toEqual(expected);
    });
  });
});
