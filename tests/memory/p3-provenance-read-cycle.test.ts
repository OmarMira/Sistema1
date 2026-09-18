import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { MemoryAdapter } from '../../src/memory/adapter';

// P3 — Provenance Read Cycle: record → getById → provenance intact → company isolation
// Uses REAL PostgreSQL/Prisma — no mocks, no in-memory stores

const TEST_COMPANY_A = 'p3-test-company-a';
const TEST_COMPANY_B = 'p3-test-company-b';

function createAdapter() {
  const runTx = <R>(fn: (tx: any) => Promise<R>) => db.$transaction(fn);
  return new MemoryAdapter(db, runTx);
}

// Clean up test data after all tests
const createdIds: string[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await db.traceabilityLog.deleteMany({ where: { itemId: id } });
    await db.memoryVersion.deleteMany({ where: { itemId: id } });
    await db.memoryItem.delete({ where: { id } }).catch(() => {});
  }
  // Clean up test companies if they exist
  await db.company.deleteMany({
    where: { id: { in: [TEST_COMPANY_A, TEST_COMPANY_B] } },
  });
});

beforeAll(async () => {
  // Ensure test companies exist (required for FK constraint)
  for (const companyId of [TEST_COMPANY_A, TEST_COMPANY_B]) {
    await db.company.upsert({
      where: { id: companyId },
      create: { id: companyId, legalName: `Test Company ${companyId}` },
      update: { legalName: `Test Company ${companyId}` },
    });
  }
});

describe('P3 — Provenance Read Cycle', () => {
  it('record → getById → provenance fields preserved intact', async () => {
    const adapter = createAdapter();

    // Explicit, distinguishable provenance values
    const companyId = TEST_COMPANY_A;
    const sourceAuthor = 'P3_TEST_AUTHOR';
    const sourceName = 'P3_TEST_SOURCE';
    const sourceObservedAt = new Date('2026-09-17T12:00:00.000Z');

    // C1 — Record
    const created = await adapter.record({
      content: 'P3 provenance test content',
      type: 'p3_test',
      companyId,
      sourceAuthor,
      sourceName,
      sourceObservedAt,
    });

    createdIds.push(created.id);

    // Verify record was created
    expect(created).toBeDefined();
    expect(created.id).toBeTruthy();

    // C2 — Retrieve by ID
    const found = await adapter.getById(created.id, companyId);

    // Assert: found != null
    expect(found).not.toBeNull();

    // Assert: id matches
    expect(found!.id).toBe(created.id);

    // Assert: companyId matches
    expect(found!.companyId).toBe(companyId);

    // Assert: sourceAuthor preserved
    expect(found!.sourceAuthor).toBe(sourceAuthor);

    // Assert: sourceName preserved
    expect(found!.sourceName).toBe(sourceName);

    // Assert: sourceObservedAt preserved (semantic comparison)
    expect(found!.sourceObservedAt).toBeDefined();
    expect(found!.sourceObservedAt!.getTime()).toBe(sourceObservedAt.getTime());
  });

  it('getById with wrong companyId returns null (company isolation)', async () => {
    const adapter = createAdapter();

    // Create item in Company A
    const companyId = TEST_COMPANY_A;
    const created = await adapter.record({
      content: 'P3 isolation test content',
      type: 'p3_isolation_test',
      companyId,
      sourceAuthor: 'ISOLATION_AUTHOR',
      sourceName: 'ISOLATION_SOURCE',
      sourceObservedAt: new Date('2026-09-17T13:00:00.000Z'),
    });

    createdIds.push(created.id);

    // Try to retrieve with Company B — should return null
    const foundWrongCompany = await adapter.getById(created.id, TEST_COMPANY_B);
    expect(foundWrongCompany).toBeNull();

    // Verify it's still retrievable with correct company
    const foundCorrectCompany = await adapter.getById(created.id, companyId);
    expect(foundCorrectCompany).not.toBeNull();
    expect(foundCorrectCompany!.id).toBe(created.id);
  });
});
