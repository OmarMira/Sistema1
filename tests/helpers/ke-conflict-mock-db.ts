// Shared mock Prisma for classification-conflict API route tests.
// Mirrors the proven in-memory MemoryItem harness from
// tests/memory/rehabilitation.test.ts / tests/api/transaction-patch-ke-conflict.test.ts
// so the REAL Knowledge Engine operations run against a controlled store.

import { vi } from 'vitest';

type StoredItem = {
  id: string;
  content: string;
  type: string;
  status: string;
  confidence: string;
  companyId: string;
  sourceAuthor: string;
  sourceName: string;
};

export type KeMockDb = ReturnType<typeof createKeMockDb>;

export function createKeMockDb() {
  const store = new Map<string, StoredItem>();
  let nextId = 1;

  const db = {
    memoryItem: {
      create: vi.fn(async (args: { data: { content: string; type: string; companyId: string; sourceAuthor: string; sourceName: string; confidence?: string } }) => {
        const id = `mem_${nextId++}`;
        const item: StoredItem = {
          id,
          content: args.data.content,
          type: args.data.type,
          status: 'active',
          confidence: typeof args.data.confidence === 'string' ? args.data.confidence : 'tentative',
          companyId: args.data.companyId,
          sourceAuthor: args.data.sourceAuthor,
          sourceName: args.data.sourceName,
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
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const item = store.get(args.where.id);
        if (item) {
          Object.assign(item, args.data);
          return item;
        }
        throw new Error('Not found');
      }),
    },
    memoryVersion: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    relationship: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    contradiction: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    traceabilityLog: {
      create: vi.fn(async (args: { data: { itemId: string; action: string; actor: string; details: unknown } }) => {
        return { id: `tl_${nextId++}`, ...args.data };
      }),
      findMany: vi.fn(async () => []),
    },
    evolutionLink: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    confidenceLog: {
      create: vi.fn(async (args: { data: { itemId: string; previousLevel: string; newLevel: string; reason: string } }) => {
        return { id: `cl_${nextId++}`, ...args.data };
      }),
      findMany: vi.fn(async () => []),
    },
    $transaction: async <T,>(fn: (tx: KeMockDb) => Promise<T>): Promise<T> => fn(db),
    reset: () => {
      store.clear();
      nextId = 1;
    },
    _store: store,
    /** Seed a raw MemoryItem directly (for malformed-content ERROR tests). */
    _seedRaw: (item: StoredItem) => {
      store.set(item.id, item);
      nextId = Math.max(nextId + 1, 2);
    },
  };
  return db;
}
