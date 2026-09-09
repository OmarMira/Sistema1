// Knowledge Engine — Classification Knowledge Tests
// Tests for the classification read/write layer using existing C1-C11.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizeDescription,
  learnFromCorrection,
  lookupClassification,
} from '../../src/memory/classification-knowledge';
import type { ClassificationContent } from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { MemoryPrismaClient, TransactionRunner } from '../../src/memory/prisma-types';

// ─── Mock Prisma Client (satisfies MemoryPrismaClient) ──────────

function createMockPrisma() {
  const store = new Map<string, { id: string; content: string; type: string; status: string; confidence: string; companyId: string }>();
  let nextId = 1;

  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    memoryItem: {
      create: vi.fn(async (args: { data: { content: string; type: string; companyId: string; [key: string]: unknown } }) => {
        const id = `mem_${nextId++}`;
        const item = {
          id,
          content: args.data.content,
          type: args.data.type,
          status: 'active',
          confidence: 'tentative',
          companyId: args.data.companyId,
        };
        store.set(id, item);
        return item;
      }),
      findFirst: vi.fn(async (args?: { where?: { id?: string; companyId?: string; content?: string; status?: string } }) => {
        for (const item of store.values()) {
          let match = true;
          if (args?.where?.id && item.id !== args.where.id) match = false;
          if (args?.where?.companyId && item.companyId !== args.where.companyId) match = false;
          if (args?.where?.content && item.content !== args.where.content) match = false;
          if (args?.where?.status && item.status !== args.where.status) match = false;
          if (match) return item;
        }
        return null;
      }),
      findMany: vi.fn(async (args?: { where?: { companyId?: string; type?: string; [key: string]: unknown } }) => {
        let results = Array.from(store.values());
        if (args?.where?.companyId) {
          results = results.filter((item) => item.companyId === args.where!.companyId);
        }
        if (args?.where?.type) {
          results = results.filter((item) => item.type === args.where!.type);
        }
        return results;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { content: string } }) => {
        const item = store.get(args.where.id);
        if (item) {
          item.content = args.data.content;
          return item;
        }
        throw new Error('Not found');
      }),
    },
    memoryVersion: {
      create: vi.fn(async () => ({})),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    relationship: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    contradiction: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    traceabilityLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    evolutionLink: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    confidenceLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    _store: store,
  };
}

function createMockAdapter() {
  const mockPrisma = createMockPrisma();
  const mockRunTx: TransactionRunner = async (fn) => fn(mockPrisma as Parameters<TransactionRunner>[0] extends (tx: infer T) => Promise<unknown> ? T : never);
  const adapter = new MemoryAdapter(mockPrisma as MemoryPrismaClient, mockRunTx);
  return { adapter, prisma: mockPrisma, store: mockPrisma._store };
}

// ─── normalizeDescription ───────────────────────────────────────

describe('normalizeDescription', () => {
  it('normalizes uppercase and whitespace', () => {
    expect(normalizeDescription('  AMZN MKTPLACE  ')).toBe('AMZN MKTPLACE');
  });

  it('removes special characters', () => {
    expect(normalizeDescription('AMZN*MKTPLACE#123')).toBe('AMZNMKTPLACE123');
  });

  it('truncates to 200 chars', () => {
    const long = 'A'.repeat(300);
    expect(normalizeDescription(long)).toHaveLength(200);
  });

  it('returns empty for empty input', () => {
    expect(normalizeDescription('')).toBe('');
  });
});

// ─── Case A: learning ───────────────────────────────────────────

describe('Case A — learnFromCorrection creates knowledge', () => {
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mock = createMockAdapter();
  });

  it('records new pattern after user correction', async () => {
    const result = await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_123',
      'any',
      'txn_001',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe('recorded');
    }
    expect(mock.prisma.memoryItem.create).toHaveBeenCalledOnce();
    const call = mock.prisma.memoryItem.create.mock.calls[0][0];
    const content = JSON.parse(call.data.content) as ClassificationContent;
    expect(content.pattern).toBe('AMZN MKTPLACE');
    expect(content.glAccountId).toBe('gl_account_123');
    expect(content.source).toBe('user_correction');
    expect(content.transactionId).toBe('txn_001');
    expect(call.data.companyId).toBe('company_1');
    expect(call.data.type).toBe('classification');
  });
});

// ─── Case B: reuse (KE_HIT) ─────────────────────────────────────

describe('Case B — lookupClassification returns KE_HIT', () => {
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mock = createMockAdapter();
  });

  it('returns hit with correct glAccountId', async () => {
    // Seed knowledge
    const content: ClassificationContent = {
      pattern: 'AMZN MKTPLACE',
      glAccountId: 'gl_account_123',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'txn_001',
    };
    await mock.adapter.record({
      content: JSON.stringify(content),
      type: 'classification',
      companyId: 'company_1',
    });

    const result = await lookupClassification(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
    );

    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.glAccountId).toBe('gl_account_123');
      expect(result.direction).toBe('any');
    }
  });
});

// ─── Case C: company isolation ──────────────────────────────────

describe('Case C — company isolation', () => {
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mock = createMockAdapter();
  });

  it('does not return knowledge from another company', async () => {
    // Seed knowledge for company_1
    const content: ClassificationContent = {
      pattern: 'AMZN MKTPLACE',
      glAccountId: 'gl_account_123',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'txn_001',
    };
    await mock.adapter.record({
      content: JSON.stringify(content),
      type: 'classification',
      companyId: 'company_1',
    });

    // Lookup from company_2 — should miss
    const result = await lookupClassification(
      mock.adapter,
      'company_2',
      'AMZN MKTPLACE',
    );

    expect(result.kind).toBe('miss');
  });
});

// ─── Case D: miss ───────────────────────────────────────────────

describe('Case D — KE_MISS for unknown pattern', () => {
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mock = createMockAdapter();
  });

  it('returns miss for unknown description', async () => {
    const result = await lookupClassification(
      mock.adapter,
      'company_1',
      'UNKNOWN VENDOR XYZ',
    );

    expect(result.kind).toBe('miss');
  });
});

// ─── Case E: failed correction ──────────────────────────────────

describe('Case E — failed accounting does not write to KE', () => {
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mock = createMockAdapter();
  });

  it('learnFromCorrection returns error result when adapter fails', async () => {
    mock.prisma.memoryItem.create.mockRejectedValueOnce(new Error('DB error'));

    const result = await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_123',
      'any',
      'txn_001',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('DB error');
    }
  });

  it('returns no_op when exact content already exists', async () => {
    const content: ClassificationContent = {
      pattern: 'AMZN MKTPLACE',
      glAccountId: 'gl_account_123',
      direction: 'any',
      source: 'user_correction',
      transactionId: 'txn_001',
    };
    await mock.adapter.record({
      content: JSON.stringify(content),
      type: 'classification',
      companyId: 'company_1',
    });

    const result = await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_123',
      'any',
      'txn_002',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe('no_op');
    }
  });
});

// ─── Case F: second correction updates (C4/C5) ─────────────────

describe('Case F — second correction updates same item (C4/C5)', () => {
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mock = createMockAdapter();
  });

  it('updates existing item with new classification', async () => {
    // First correction
    const result1 = await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_123',
      'any',
      'txn_001',
    );
    expect(result1.ok).toBe(true);
    const firstItemId = result1.ok ? result1.itemId : null;

    // Second correction — same pattern, different GL account
    const result2 = await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_456',
      'any',
      'txn_002',
    );

    expect(result2.ok).toBe(true);
    if (result2.ok) {
      // Same item ID — not a new item
      expect(result2.itemId).toBe(firstItemId);
      expect(result2.action).toBe('updated');
    }

    // Should have called update, NOT evolve
    expect(mock.prisma.memoryItem.update).toHaveBeenCalledOnce();

    // Only one record (first correction)
    expect(mock.prisma.memoryItem.create).toHaveBeenCalledOnce();
  });

  it('does not update if same classification is corrected again', async () => {
    // First correction
    await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_123',
      'any',
      'txn_001',
    );

    // Second correction — same pattern, SAME GL account
    const result = await learnFromCorrection(
      mock.adapter,
      'company_1',
      'AMZN MKTPLACE',
      'gl_account_123',
      'any',
      'txn_002',
    );

    // Should NOT call update — already known
    expect(mock.prisma.memoryItem.update).not.toHaveBeenCalled();

    // Only one record (first correction)
    expect(mock.prisma.memoryItem.create).toHaveBeenCalledOnce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe('no_op');
    }
  });
});
