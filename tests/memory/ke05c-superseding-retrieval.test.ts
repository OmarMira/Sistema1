import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { MemoryAdapter } from '../../src/memory/adapter';

// KE-05C — Superseding Retrieval Resolution
// Proves that superseded items (supersededId in EvolutionLink) are excluded
// from normal retrieval, while successor items remain eligible.

const TEST_COMPANY_A = 'ke05c-test-company-a';
const TEST_COMPANY_B = 'ke05c-test-company-b';

function createAdapter() {
  const runTx = <R>(fn: (tx: any) => Promise<R>) => db.$transaction(fn);
  return new MemoryAdapter(db, runTx);
}

const createdIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.traceabilityLog.deleteMany({ where: { itemId: id } });
    await db.memoryVersion.deleteMany({ where: { itemId: id } });
    await db.evolutionLink.deleteMany({
      where: { OR: [{ supersededId: id }, { supersededById: id }] },
    });
    await db.memoryItem.delete({ where: { id } }).catch(() => {});
  }
  await db.company.deleteMany({
    where: { id: { in: [TEST_COMPANY_A, TEST_COMPANY_B] } },
  });
});

beforeAll(async () => {
  for (const companyId of [TEST_COMPANY_A, TEST_COMPANY_B]) {
    await db.company.upsert({
      where: { id: companyId },
      create: { id: companyId, legalName: `Test Company ${companyId}` },
      update: { legalName: `Test Company ${companyId}` },
    });
  }
});

describe('KE-05C — Superseding Retrieval Resolution', () => {
  it('T1-T4: evolve creates link, OLD preserved by getById', async () => {
    const adapter = createAdapter();

    // T1: Create OLD and NEW
    const old = await adapter.record({
      content: 'OLD knowledge for superseding test',
      type: 'ke05c_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    const newer = await adapter.record({
      content: 'NEW knowledge for superseding test',
      type: 'ke05c_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    createdIds.push(old.id, newer.id);

    // T2: OLD is retrievable before superseding
    const foundBefore = await adapter.getById(old.id, TEST_COMPANY_A);
    expect(foundBefore).not.toBeNull();
    expect(foundBefore!.id).toBe(old.id);

    // T3: Evolve OLD → NEW
    const result = await adapter.evolve(old.id, 'Updated knowledge', newer.id, TEST_COMPANY_A);
    expect(result.item.content).toBe('Updated knowledge');
    expect(result.link.supersededId).toBe(old.id);
    expect(result.link.supersededById).toBe(newer.id);

    // T4: OLD still retrievable by getById (audit/history)
    const foundAfter = await adapter.getById(old.id, TEST_COMPANY_A);
    expect(foundAfter).not.toBeNull();
    expect(foundAfter!.id).toBe(old.id);
  });

  it('T5: OLD excluded from search after superseding', async () => {
    const adapter = createAdapter();

    const old = await adapter.record({
      content: 'SEARCH_EXCLUDE_ME superseding',
      type: 'ke05c_search_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    const newer = await adapter.record({
      content: 'SEARCH_SUCCESSOR superseding',
      type: 'ke05c_search_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    createdIds.push(old.id, newer.id);

    // Before evolve: both appear in search
    const searchBefore = await adapter.searchRanked(TEST_COMPANY_A, 'superseding');
    const idsBefore = searchBefore.map((r) => r.item.id);
    expect(idsBefore).toContain(old.id);
    expect(idsBefore).toContain(newer.id);

    // Evolve OLD → NEW
    await adapter.evolve(old.id, 'Updated search test', newer.id, TEST_COMPANY_A);

    // T5: OLD excluded from search
    const searchAfter = await adapter.searchRanked(TEST_COMPANY_A, 'superseding');
    const idsAfter = searchAfter.map((r) => r.item.id);
    expect(idsAfter).not.toContain(old.id);

    // T8: NEW remains eligible
    expect(idsAfter).toContain(newer.id);
  });

  it('T6: OLD excluded from findByType after superseding', async () => {
    const adapter = createAdapter();

    const old = await adapter.record({
      content: 'TYPE_EXCLUDE_ME',
      type: 'ke05c_type_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    const newer = await adapter.record({
      content: 'TYPE_SUCCESSOR',
      type: 'ke05c_type_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    createdIds.push(old.id, newer.id);

    // Before evolve: both appear in findByType
    const typeBefore = await adapter.getByType(TEST_COMPANY_A, 'ke05c_type_test');
    const idsBefore = typeBefore.map((i) => i.id);
    expect(idsBefore).toContain(old.id);
    expect(idsBefore).toContain(newer.id);

    // Evolve OLD → NEW
    await adapter.evolve(old.id, 'Updated type test', newer.id, TEST_COMPANY_A);

    // T6: OLD excluded from findByType
    const typeAfter = await adapter.getByType(TEST_COMPANY_A, 'ke05c_type_test');
    const idsAfter = typeAfter.map((i) => i.id);
    expect(idsAfter).not.toContain(old.id);

    // T8: NEW remains eligible
    expect(idsAfter).toContain(newer.id);
  });

  it('T7: OLD excluded from searchRanked after superseding', async () => {
    const adapter = createAdapter();

    const old = await adapter.record({
      content: 'RANKED_EXCLUDE_ME unique_term_ke05c',
      type: 'ke05c_ranked_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    const newer = await adapter.record({
      content: 'RANKED_SUCCESSOR unique_term_ke05c',
      type: 'ke05c_ranked_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    createdIds.push(old.id, newer.id);

    // Before evolve: both appear in searchRanked
    const rankedBefore = await adapter.searchRanked(TEST_COMPANY_A, 'unique_term_ke05c');
    const idsBefore = rankedBefore.map((r) => r.item.id);
    expect(idsBefore).toContain(old.id);
    expect(idsBefore).toContain(newer.id);

    // Evolve OLD → NEW
    await adapter.evolve(old.id, 'Updated ranked test', newer.id, TEST_COMPANY_A);

    // T7: OLD excluded from searchRanked
    const rankedAfter = await adapter.searchRanked(TEST_COMPANY_A, 'unique_term_ke05c');
    const idsAfter = rankedAfter.map((r) => r.item.id);
    expect(idsAfter).not.toContain(old.id);

    // T8: NEW remains eligible
    expect(idsAfter).toContain(newer.id);
  });

  it('T9: company isolation — superseding in A does not affect B', async () => {
    const adapter = createAdapter();

    // Create item in Company B
    const itemB = await adapter.record({
      content: 'COMPANY_B_ITEM isolation_test',
      type: 'ke05c_isolation_test',
      companyId: TEST_COMPANY_B,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    createdIds.push(itemB.id);

    // Create items in Company A and evolve them
    const oldA = await adapter.record({
      content: 'COMPANY_A_OLD isolation_test',
      type: 'ke05c_isolation_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    const newA = await adapter.record({
      content: 'COMPANY_A_NEW isolation_test',
      type: 'ke05c_isolation_test',
      companyId: TEST_COMPANY_A,
      sourceAuthor: 'TEST_AUTHOR',
      sourceName: 'TEST_SOURCE',
    });
    createdIds.push(oldA.id, newA.id);

    // Evolve in Company A
    await adapter.evolve(oldA.id, 'Updated isolation', newA.id, TEST_COMPANY_A);

    // T9: ItemB still appears in Company B search (not affected by A's superseding)
    const searchB = await adapter.searchRanked(TEST_COMPANY_B, 'isolation_test');
    const idsB = searchB.map((r) => r.item.id);
    expect(idsB).toContain(itemB.id);
  });
});
