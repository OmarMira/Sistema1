/**
 * KE-07B — P8 Deterministic Retrieval: Tie-Breaker Certification
 *
 * Proves that every retrieval route produces a stable, reproducible order
 * when primary sort criteria produce ties. The tie-breaker is `id ASC`.
 *
 * Direct PostgreSQL tests — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { MemoryAdapter } from '../../src/memory/adapter';
import { MemoryRepository } from '../../src/memory/repository';

let COMPANY_A: string;
let COMPANY_B: string;
const createdItemIds: string[] = [];
const createdCompanyIds: string[] = [];

function createAdapter() {
  const runTx = <R>(fn: (tx: any) => Promise<R>) => db.$transaction(fn);
  return new MemoryAdapter(db, runTx);
}

beforeAll(async () => {
  const compA = await db.company.create({
    data: { legalName: 'KE07B Company A', entityType: 'BUSINESS', taxId: '30-70000701-7' },
  });
  COMPANY_A = compA.id;
  createdCompanyIds.push(compA.id);

  const compB = await db.company.create({
    data: { legalName: 'KE07B Company B', entityType: 'BUSINESS', taxId: '30-70000702-5' },
  });
  COMPANY_B = compB.id;
  createdCompanyIds.push(compB.id);
});

afterAll(async () => {
  for (const id of createdItemIds) {
    await db.traceabilityLog.deleteMany({ where: { itemId: id } });
    await db.confidenceLog.deleteMany({ where: { itemId: id } });
    await db.memoryVersion.deleteMany({ where: { itemId: id } });
    await db.memoryItem.deleteMany({ where: { id } });
  }
  if (COMPANY_A) {
    await db.company.deleteMany({ where: { id: COMPANY_A } });
  }
  if (COMPANY_B) {
    await db.company.deleteMany({ where: { id: COMPANY_B } });
  }
  await db.$disconnect();
});

describe('KE-07B — P8 Deterministic Retrieval', () => {
  // ─── T1 — findByType tie ───────────────────────────────────────
  it('T1: findByType returns deterministic order on createdAt tie', async () => {
    const adapter = createAdapter();
    const fixedTime = new Date('2026-09-18T10:00:00.000Z');

    // Create two items of same type, same company, forced same createdAt
    const itemA = await adapter.record({
      content: 'T1 item A — alpha',
      type: 'ke07b_tie_test',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemA.id);

    const itemB = await adapter.record({
      content: 'T1 item B — beta',
      type: 'ke07b_tie_test',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemB.id);

    // Force identical createdAt on both items
    await db.memoryItem.updateMany({
      where: { id: { in: [itemA.id, itemB.id] } },
      data: { createdAt: fixedTime },
    });

    // Query multiple times — order must be stable
    const ids1 = (await adapter.getByType(COMPANY_A, 'ke07b_tie_test')).map((i) => i.id);
    const ids2 = (await adapter.getByType(COMPANY_A, 'ke07b_tie_test')).map((i) => i.id);
    const ids3 = (await adapter.getByType(COMPANY_A, 'ke07b_tie_test')).map((i) => i.id);

    expect(ids1).toEqual(ids2);
    expect(ids2).toEqual(ids3);

    // Verify tie-breaker: id ASC for the tied items
    const sorted = [itemA.id, itemB.id].sort((a, b) => a.localeCompare(b));
    const tiedIds = ids1.filter((id) => id === itemA.id || id === itemB.id);
    expect(tiedIds).toEqual(sorted);
  });

  // ─── T2 — search tie ───────────────────────────────────────────
  it('T2: search returns deterministic order on createdAt tie', async () => {
    const adapter = createAdapter();
    const fixedTime = new Date('2026-09-18T11:00:00.000Z');

    const itemA = await adapter.record({
      content: 'KE07B unique search alpha',
      type: 'fact',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemA.id);

    const itemB = await adapter.record({
      content: 'KE07B unique search beta',
      type: 'fact',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemB.id);

    // Force identical createdAt
    await db.memoryItem.updateMany({
      where: { id: { in: [itemA.id, itemB.id] } },
      data: { createdAt: fixedTime },
    });

    // Use repository.search() directly — adapter doesn't expose it
    const runTx = <R>(fn: (tx: any) => Promise<R>) => db.$transaction(fn);
    const repository = new MemoryRepository(db, runTx);

    const results1 = await repository.search(COMPANY_A, 'KE07B unique search');
    const results2 = await repository.search(COMPANY_A, 'KE07B unique search');

    const ids1 = results1.map((r) => r.id);
    const ids2 = results2.map((r) => r.id);

    const sorted = [itemA.id, itemB.id].sort((a, b) => a.localeCompare(b));
    const tiedIds1 = ids1.filter((id) => id === itemA.id || id === itemB.id);
    expect(tiedIds1).toEqual(sorted);

    // Stability: repeat the same query — exact same ID sequence
    expect(ids2).toEqual(ids1);
  });

  // ─── T3 — searchRanked tie ─────────────────────────────────────
  it('T3: searchRanked returns deterministic order on rank tie', async () => {
    const adapter = createAdapter();

    // Create two items with identical content → identical similarity rank
    const identicalContent = 'KE07B identical rank content for tie test';

    const itemA = await adapter.record({
      content: identicalContent,
      type: 'fact',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemA.id);

    const itemB = await adapter.record({
      content: identicalContent,
      type: 'fact',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemB.id);

    // Query searchRanked
    const results1 = await adapter.searchRanked(COMPANY_A, 'identical rank content');
    const results2 = await adapter.searchRanked(COMPANY_A, 'identical rank content');

    // Both items must appear
    const ids1 = results1.map((r) => r.item.id);
    const ids2 = results2.map((r) => r.item.id);

    const tiedIds1 = ids1.filter((id) => id === itemA.id || id === itemB.id);
    const tiedIds2 = ids2.filter((id) => id === itemA.id || id === itemB.id);

    // Verify tie exists: both items have the same rank
    const rankA = results1.find((r) => r.item.id === itemA.id)?.rank;
    const rankB = results1.find((r) => r.item.id === itemB.id)?.rank;
    expect(rankA).toBeDefined();
    expect(rankB).toBeDefined();
    expect(rankA).toBe(rankB);

    // Verify deterministic order: id ASC tie-breaker
    const sorted = [itemA.id, itemB.id].sort((a, b) => a.localeCompare(b));
    expect(tiedIds1).toEqual(sorted);
    expect(tiedIds2).toEqual(sorted);
    expect(ids1).toEqual(ids2);
  });

  // ─── T4 — repeated query stability ─────────────────────────────
  it('T4: same retrieval query produces identical ID sequence across repeats', async () => {
    const adapter = createAdapter();

    // Create a mix of items
    const contents = [
      'KE07B stability one',
      'KE07B stability two',
      'KE07B stability three',
    ];
    for (const content of contents) {
      const item = await adapter.record({
        content,
        type: 'ke07b_stability',
        companyId: COMPANY_A,
        sourceAuthor: 'ke07b',
        sourceName: 'ke07b',
      });
      createdItemIds.push(item.id);
    }

    // Run the same query 5 times
    const sequences: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const items = await adapter.getByType(COMPANY_A, 'ke07b_stability');
      sequences.push(items.map((item) => item.id));
    }

    // All 5 must be identical
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toEqual(sequences[0]);
    }
  });

  // ─── T5 — findByExactContent duplicates ────────────────────────
  it('T5: findByExactContent returns the lexicographically smallest ID on duplicates', async () => {
    const adapter = createAdapter();
    const exactContent = 'KE07B exact duplicate content';

    const itemA = await adapter.record({
      content: exactContent,
      type: 'fact',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemA.id);

    const itemB = await adapter.record({
      content: exactContent,
      type: 'fact',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemB.id);

    // findByExactContent must return the same item every time
    const result1 = await adapter.getExactContent(COMPANY_A, exactContent);
    const result2 = await adapter.getExactContent(COMPANY_A, exactContent);
    const result3 = await adapter.getExactContent(COMPANY_A, exactContent);

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result3).not.toBeNull();

    // Must return the same ID every time
    expect(result1!.id).toBe(result2!.id);
    expect(result2!.id).toBe(result3!.id);

    // Must be the lexicographically smaller ID
    const expectedId = [itemA.id, itemB.id].sort((a, b) => a.localeCompare(b))[0];
    expect(result1!.id).toBe(expectedId);
  });

  // ─── T6 — Company isolation ────────────────────────────────────
  it('T6: retrieval never mixes IDs across companies', async () => {
    const adapter = createAdapter();
    const fixedTime = new Date('2026-09-18T12:00:00.000Z');

    // Create items in both companies
    const itemA = await adapter.record({
      content: 'KE07B isolation alpha',
      type: 'ke07b_isolation',
      companyId: COMPANY_A,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemA.id);

    const itemB = await adapter.record({
      content: 'KE07B isolation beta',
      type: 'ke07b_isolation',
      companyId: COMPANY_B,
      sourceAuthor: 'ke07b',
      sourceName: 'ke07b',
    });
    createdItemIds.push(itemB.id);

    // Force same createdAt to test tie-breaker isolation
    await db.memoryItem.updateMany({
      where: { id: { in: [itemA.id, itemB.id] } },
      data: { createdAt: fixedTime },
    });

    const resultsA = await adapter.getByType(COMPANY_A, 'ke07b_isolation');
    const resultsB = await adapter.getByType(COMPANY_B, 'ke07b_isolation');

    // Each company sees only its own items
    const idsA = resultsA.map((i) => i.id);
    const idsB = resultsB.map((i) => i.id);

    expect(idsA).toContain(itemA.id);
    expect(idsA).not.toContain(itemB.id);

    expect(idsB).toContain(itemB.id);
    expect(idsB).not.toContain(itemA.id);
  });
});
