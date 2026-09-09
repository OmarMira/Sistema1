// Memory Core — Integration Tests (Task 7.3)
// Full flow tests: C1–C11, companyId isolation, cross-company rejection
// Uses real PostgreSQL test database via Prisma

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { PrismaClient, MemoryStatus, ConfidenceLevel } from '@prisma/client';
import { MemoryService, MemoryError } from '../../src/memory/service';
import { MemoryAdapter } from '../../src/memory/adapter';
import { MemoryRepository } from '../../src/memory/repository';
import type { TransactionRunner } from '../../src/memory/prisma-types';

// ─── Test Setup ──────────────────────────────────────────────────

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const runTx: TransactionRunner = (fn) => prisma.$transaction(fn);
const SERVICE = new MemoryService(prisma, runTx);
const ADAPTER = new MemoryAdapter(prisma, runTx);
const REPOSITORY = new MemoryRepository(prisma, runTx);

const COMPANY_A = 'test-company-a';
const COMPANY_B = 'test-company-b';

// Track created IDs for cleanup
let createdItemIds: string[] = [];

async function cleanMemoryTables() {
  // Delete in dependency order (foreign keys)
  await prisma.confidenceLog.deleteMany();
  await prisma.traceabilityLog.deleteMany();
  await prisma.evolutionLink.deleteMany();
  await prisma.contradiction.deleteMany();
  await prisma.relationship.deleteMany();
  await prisma.memoryVersion.deleteMany();
  await prisma.memoryItem.deleteMany();
}

async function seedTestCompanies() {
  await prisma.company.upsert({
    where: { id: COMPANY_A },
    create: { id: COMPANY_A, legalName: 'Test Company A' },
    update: {},
  });
  await prisma.company.upsert({
    where: { id: COMPANY_B },
    create: { id: COMPANY_B, legalName: 'Test Company B' },
    update: {},
  });
}

async function cleanTestCompanies() {
  // Delete companies after all memory data is cleaned
  await prisma.company.deleteMany({
    where: { id: { in: [COMPANY_A, COMPANY_B] } },
  });
}

beforeAll(async () => {
  await prisma.$connect();
  await seedTestCompanies();
});

afterAll(async () => {
  await cleanMemoryTables();
  await cleanTestCompanies();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanMemoryTables();
  createdItemIds = [];
});

afterEach(async () => {
  await cleanMemoryTables();
});

// ─── Helper ──────────────────────────────────────────────────────

function record(overrides: Record<string, unknown> = {}) {
  return SERVICE.record({
    content: 'Test content',
    type: 'fact',
    companyId: COMPANY_A,
    sourceAuthor: 'test-user',
    sourceName: 'test-source',
    ...overrides,
  });
}

// ══════════════════════════════════════════════════════════════════
// C1 — Record
// ══════════════════════════════════════════════════════════════════

describe('C1 — Record', () => {
  it('should create memory item with initial version', async () => {
    const item = await record({ content: 'AccountExpress handles invoices', companyId: COMPANY_A });
    createdItemIds.push(item.id);

    expect(item.id).toBeDefined();
    expect(item.content).toBe('AccountExpress handles invoices');
    expect(item.type).toBe('fact');
    expect(item.companyId).toBe(COMPANY_A);
    expect(item.status).toBe('active');

    // C5: verify initial version exists
    const versions = await SERVICE.getVersionHistory(item.id, COMPANY_A);
    expect(versions).toHaveLength(1);
    expect(versions[0].versionNumber).toBe(1);
  });

  it('should create traceability log on record', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    const logs = await SERVICE.getTraceability(item.id, COMPANY_A);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('recorded');
  });

  it('should reject empty companyId', async () => {
    await expect(
      SERVICE.record({
        content: 'test',
        type: 'fact',
        companyId: '',
        sourceAuthor: 'test',
        sourceName: 'test',
      }),
    ).rejects.toThrow(MemoryError);
  });
});

// ══════════════════════════════════════════════════════════════════
// C2 — Retrieve (ID, exact, ranked, type)
// ══════════════════════════════════════════════════════════════════

describe('C2 — Retrieve', () => {
  it('should retrieve by ID', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    const found = await SERVICE.getById(item.id, COMPANY_A);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(item.id);
  });

  it('should return null for non-existent ID', async () => {
    const found = await SERVICE.getById('non-existent-id', COMPANY_A);
    expect(found).toBeNull();
  });

  it('should return null for cross-company (no leak)', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    // Repository enforces companyId — returns null, no error
    const found = await SERVICE.getById(item.id, COMPANY_B);
    expect(found).toBeNull();
  });

  it('should retrieve by exact content', async () => {
    const item = await record({
      content: 'Exact match content',
      companyId: COMPANY_A,
    });
    createdItemIds.push(item.id);

    const found = await SERVICE.getExactContent(COMPANY_A, 'Exact match content');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(item.id);
  });

  it('should not match partial content in exact search', async () => {
    const item = await record({
      content: 'Exact match content',
      companyId: COMPANY_A,
    });
    createdItemIds.push(item.id);

    const found = await SERVICE.getExactContent(COMPANY_A, 'Exact');
    expect(found).toBeNull();
  });

  it('should ranked search with pg_trgm', async () => {
    await record({ content: 'Invoice processing rules', companyId: COMPANY_A });
    await record({ content: 'Invoice payment workflow', companyId: COMPANY_A });
    await record({ content: 'Tax calculation formula', companyId: COMPANY_A });

    const results = await SERVICE.searchRanked(COMPANY_A, 'invoice');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Results should be ordered by similarity
    expect(results[0].rank).toBeGreaterThanOrEqual(results[1].rank);
  });

  it('should retrieve by type', async () => {
    await record({ type: 'fact', companyId: COMPANY_A });
    await record({ type: 'rule', companyId: COMPANY_A });
    await record({ type: 'fact', companyId: COMPANY_A });

    const facts = await SERVICE.getByType(COMPANY_A, 'fact');
    expect(facts).toHaveLength(2);
    facts.forEach((f) => expect(f.type).toBe('fact'));

    const rules = await SERVICE.getByType(COMPANY_A, 'rule');
    expect(rules).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// C3 — Relate
// ══════════════════════════════════════════════════════════════════

describe('C3 — Relate', () => {
  it('should create relationship between two items', async () => {
    const itemA = await record({ content: 'Item A', companyId: COMPANY_A });
    const itemB = await record({ content: 'Item B', companyId: COMPANY_A });
    createdItemIds.push(itemA.id, itemB.id);

    const rel = await SERVICE.relate(
      { sourceId: itemA.id, targetId: itemB.id, label: 'related_to' },
      COMPANY_A,
    );

    expect(rel.sourceId).toBe(itemA.id);
    expect(rel.targetId).toBe(itemB.id);
    expect(rel.label).toBe('related_to');
  });

  it('should trace relationship creation', async () => {
    const itemA = await record({ content: 'Item A', companyId: COMPANY_A });
    const itemB = await record({ content: 'Item B', companyId: COMPANY_A });
    createdItemIds.push(itemA.id, itemB.id);

    await SERVICE.relate(
      { sourceId: itemA.id, targetId: itemB.id, label: 'related_to' },
      COMPANY_A,
    );

    const logs = await SERVICE.getTraceability(itemA.id, COMPANY_A);
    const relatedLog = logs.find((l) => l.action === 'related');
    expect(relatedLog).toBeDefined();
  });

  it('should reject cross-company relationship', async () => {
    const itemA = await record({ content: 'Item A', companyId: COMPANY_A });
    const itemB = await record({ content: 'Item B', companyId: COMPANY_B });
    createdItemIds.push(itemA.id, itemB.id);

    await expect(
      SERVICE.relate(
        { sourceId: itemA.id, targetId: itemB.id, label: 'related_to' },
        COMPANY_A,
      ),
    ).rejects.toThrow(/not found or not accessible/);
  });

  it('should reject relationship with non-existent item', async () => {
    const itemA = await record({ content: 'Item A', companyId: COMPANY_A });
    createdItemIds.push(itemA.id);

    await expect(
      SERVICE.relate(
        { sourceId: itemA.id, targetId: 'non-existent', label: 'related_to' },
        COMPANY_A,
      ),
    ).rejects.toThrow(/not found or not accessible/);
  });

  it('should retrieve relationships', async () => {
    const itemA = await record({ content: 'Item A', companyId: COMPANY_A });
    const itemB = await record({ content: 'Item B', companyId: COMPANY_A });
    createdItemIds.push(itemA.id, itemB.id);

    await SERVICE.relate(
      { sourceId: itemA.id, targetId: itemB.id, label: 'related_to' },
      COMPANY_A,
    );

    const rels = await SERVICE.getRelationships(itemA.id, COMPANY_A);
    expect(rels.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// C4/C5 — Update + Version History
// ══════════════════════════════════════════════════════════════════

describe('C4/C5 — Update + Version History', () => {
  it('should update content and create new version', async () => {
    const item = await record({ content: 'Original content', companyId: COMPANY_A });
    createdItemIds.push(item.id);

    const updated = await SERVICE.update(item.id, 'Updated content', COMPANY_A);
    expect(updated.content).toBe('Updated content');

    const versions = await SERVICE.getVersionHistory(item.id, COMPANY_A);
    expect(versions).toHaveLength(2);
    expect(versions[0].versionNumber).toBe(1);
    expect(versions[1].versionNumber).toBe(2);
  });

  it('should trace updates', async () => {
    const item = await record({ content: 'Original', companyId: COMPANY_A });
    createdItemIds.push(item.id);

    await SERVICE.update(item.id, 'Updated', COMPANY_A);

    const logs = await SERVICE.getTraceability(item.id, COMPANY_A);
    const updateLog = logs.find((l) => l.action === 'updated');
    expect(updateLog).toBeDefined();
  });

  it('should reject update from wrong company', async () => {
    const item = await record({ content: 'Original', companyId: COMPANY_A });
    createdItemIds.push(item.id);

    await expect(SERVICE.update(item.id, 'Hacked', COMPANY_B)).rejects.toThrow(
      /not found or not accessible/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// C6 — Type
// ══════════════════════════════════════════════════════════════════

describe('C6 — Type', () => {
  it('should filter by type', async () => {
    await record({ type: 'fact', companyId: COMPANY_A });
    await record({ type: 'rule', companyId: COMPANY_A });
    await record({ type: 'observation', companyId: COMPANY_A });

    const facts = await SERVICE.getByType(COMPANY_A, 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('fact');
  });

  it('should not return items from other companies', async () => {
    await record({ type: 'fact', companyId: COMPANY_A });
    await record({ type: 'fact', companyId: COMPANY_B });

    const facts = await SERVICE.getByType(COMPANY_A, 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].companyId).toBe(COMPANY_A);
  });
});

// ══════════════════════════════════════════════════════════════════
// C7 — Consistency (deterministic only)
// ══════════════════════════════════════════════════════════════════

describe('C7 — Consistency (deterministic)', () => {
  it('should detect negation contradiction', async () => {
    const itemA = await record({
      content: 'The transaction is true',
      companyId: COMPANY_A,
    });
    const itemB = await record({
      content: 'The transaction is false',
      companyId: COMPANY_A,
    });
    createdItemIds.push(itemA.id, itemB.id);

    const result = await SERVICE.verifyConsistency(itemA.id, itemB.id, COMPANY_A);
    expect(result.isContradiction).toBe(true);
    expect(result.type).toBe('negation');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should detect claim/value contradiction', async () => {
    const itemA = await record({
      content: JSON.stringify({ claim: 'invoice_paid', value: true }),
      companyId: COMPANY_A,
    });
    const itemB = await record({
      content: JSON.stringify({ claim: 'invoice_paid', value: false }),
      companyId: COMPANY_A,
    });
    createdItemIds.push(itemA.id, itemB.id);

    const result = await SERVICE.verifyConsistency(itemA.id, itemB.id, COMPANY_A);
    expect(result.isContradiction).toBe(true);
    expect(result.type).toBe('claim_value');
  });

  it('should not detect contradiction for different topics', async () => {
    const itemA = await record({
      content: 'The system can process refunds',
      companyId: COMPANY_A,
    });
    const itemB = await record({
      content: 'The system cannot process invoices',
      companyId: COMPANY_A,
    });
    createdItemIds.push(itemA.id, itemB.id);

    const result = await SERVICE.verifyConsistency(itemA.id, itemB.id, COMPANY_A);
    expect(result.isContradiction).toBe(false);
  });

  it('should persist contradiction when detected (PR1-certified case)', async () => {
    const itemA = await record({
      content: 'The invoice is true',
      companyId: COMPANY_A,
    });
    const itemB = await record({
      content: 'The invoice is false',
      companyId: COMPANY_A,
    });
    createdItemIds.push(itemA.id, itemB.id);

    const result = await SERVICE.verifyConsistency(itemA.id, itemB.id, COMPANY_A);
    expect(result.isContradiction).toBe(true);
    expect(result.type).toBe('negation');

    // Check contradiction was persisted
    const contradictions = await prisma.contradiction.findMany({
      where: {
        OR: [
          { itemAId: itemA.id, itemBId: itemB.id },
          { itemAId: itemB.id, itemBId: itemA.id },
        ],
      },
    });
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0].evidence).toContain('affirms');
  });

  it('should not detect contradiction for copula+predicate (out of PR1 scope)', async () => {
    const itemA = await record({
      content: 'Invoice is paid',
      companyId: COMPANY_A,
    });
    const itemB = await record({
      content: 'Invoice is not paid',
      companyId: COMPANY_A,
    });
    createdItemIds.push(itemA.id, itemB.id);

    const result = await SERVICE.verifyConsistency(itemA.id, itemB.id, COMPANY_A);
    // PR1 deterministic detector does NOT detect copula+predicate negation
    // This requires semantic reasoning (BLOCKED_REQUIREMENT)
    expect(result.isContradiction).toBe(false);
  });

  it('should reject cross-company consistency check', async () => {
    const itemA = await record({ content: 'A true', companyId: COMPANY_A });
    const itemB = await record({ content: 'A false', companyId: COMPANY_B });
    createdItemIds.push(itemA.id, itemB.id);

    // One item is not in COMPANY_A — should throw NOT_FOUND
    await expect(
      SERVICE.verifyConsistency(itemA.id, itemB.id, COMPANY_A),
    ).rejects.toThrow(/not found/);
  });
});

// ══════════════════════════════════════════════════════════════════
// C8 — Traceability
// ══════════════════════════════════════════════════════════════════

describe('C8 — Traceability', () => {
  it('should record full audit trail', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    // Record → traceability
    const logsAfterRecord = await SERVICE.getTraceability(item.id, COMPANY_A);
    expect(logsAfterRecord[0].action).toBe('recorded');

    // Update → traceability
    await SERVICE.update(item.id, 'Updated', COMPANY_A);
    const logsAfterUpdate = await SERVICE.getTraceability(item.id, COMPANY_A);
    expect(logsAfterUpdate).toHaveLength(2);
    expect(logsAfterUpdate[1].action).toBe('updated');
  });

  it('should return empty for cross-company traceability access', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    // Repository returns empty array for inaccessible items
    const logs = await SERVICE.getTraceability(item.id, COMPANY_B);
    expect(logs).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// C9 — Evolve
// ══════════════════════════════════════════════════════════════════

describe('C9 — Evolve', () => {
  it('should evolve item and create evolution link', async () => {
    const old = await record({ content: 'Old knowledge', companyId: COMPANY_A });
    const newer = await record({ content: 'New knowledge', companyId: COMPANY_A });
    createdItemIds.push(old.id, newer.id);

    const result = await SERVICE.evolve(old.id, 'Updated knowledge', newer.id, COMPANY_A);

    expect(result.item.content).toBe('Updated knowledge');
    expect(result.link.supersededId).toBe(old.id);
    expect(result.link.supersededById).toBe(newer.id);
    expect(result.link.linkType).toBe('supersedes');
  });

  it('should trace evolution', async () => {
    const old = await record({ content: 'Old', companyId: COMPANY_A });
    const newer = await record({ content: 'New', companyId: COMPANY_A });
    createdItemIds.push(old.id, newer.id);

    await SERVICE.evolve(old.id, 'Updated', newer.id, COMPANY_A);

    const logs = await SERVICE.getTraceability(old.id, COMPANY_A);
    const superLog = logs.find((l) => l.action === 'superseded');
    expect(superLog).toBeDefined();
  });

  it('should reject cross-company evolution', async () => {
    const old = await record({ content: 'Old', companyId: COMPANY_A });
    const other = await record({ content: 'Other', companyId: COMPANY_B });
    createdItemIds.push(old.id, other.id);

    await expect(
      SERVICE.evolve(old.id, 'Updated', other.id, COMPANY_A),
    ).rejects.toThrow(/not found/);
  });
});

// ══════════════════════════════════════════════════════════════════
// C10 — Forget
// ══════════════════════════════════════════════════════════════════

describe('C10 — Forget', () => {
  it('should mark item as forgotten', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    const forgotten = await SERVICE.forget(item.id, 'Outdated information', COMPANY_A);
    expect(forgotten.status).toBe('forgotten');
    expect(forgotten.forgetReason).toBe('Outdated information');
  });

  it('should not appear in normal search after forget', async () => {
    const item = await record({ content: 'To forget', companyId: COMPANY_A });
    createdItemIds.push(item.id);

    await SERVICE.forget(item.id, 'Reason', COMPANY_A);

    // Item still exists by ID (for audit), but not in active searches
    const found = await SERVICE.getById(item.id, COMPANY_A);
    expect(found).not.toBeNull();
    expect(found!.status).toBe('forgotten');

    // Not in type search (which filters active only)
    const byType = await SERVICE.getByType(COMPANY_A, 'fact');
    expect(byType).toHaveLength(0);

    // Not in ranked search (which filters active only)
    const ranked = await SERVICE.searchRanked(COMPANY_A, 'To forget');
    expect(ranked).toHaveLength(0);
  });

  it('should trace forget action', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    await SERVICE.forget(item.id, 'Outdated', COMPANY_A);

    const logs = await SERVICE.getTraceability(item.id, COMPANY_A);
    const forgetLog = logs.find((l) => l.action === 'forgotten');
    expect(forgetLog).toBeDefined();
  });

  it('should reject cross-company forget', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    await expect(SERVICE.forget(item.id, 'Hacked', COMPANY_B)).rejects.toThrow(
      /not found/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// C11 — Confidence
// ══════════════════════════════════════════════════════════════════

describe('C11 — Confidence', () => {
  it('should update confidence level', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    const updated = await SERVICE.updateConfidence(
      item.id,
      'certain',
      'Verified by accountant',
      COMPANY_A,
    );
    expect(updated.confidence).toBe('certain');
  });

  it('should create confidence log', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    await SERVICE.updateConfidence(item.id, 'certain', 'Verified', COMPANY_A);

    const logs = await SERVICE.getConfidenceLogs(item.id, COMPANY_A);
    expect(logs).toHaveLength(1);
    expect(logs[0].previousLevel).toBe('tentative');
    expect(logs[0].newLevel).toBe('certain');
  });

  it('should trace confidence change', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    await SERVICE.updateConfidence(item.id, 'uncertain', 'Doubt', COMPANY_A);

    const logs = await SERVICE.getTraceability(item.id, COMPANY_A);
    const confLog = logs.find((l) => l.action === 'confidence_changed');
    expect(confLog).toBeDefined();
  });

  it('should reject cross-company confidence update', async () => {
    const item = await record({ companyId: COMPANY_A });
    createdItemIds.push(item.id);

    await expect(
      SERVICE.updateConfidence(item.id, 'certain', 'Hacked', COMPANY_B),
    ).rejects.toThrow(/not found/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Atomicity — C1 and C4/C5 rollback on real PostgreSQL constraint
// violations (BLOQUE3-033)
// ══════════════════════════════════════════════════════════════════

describe('Atomicity — Transaction rollback on failure', () => {
  /**
   * C1 atomicity: item creation rolls back when version creation fails.
   *
   * Strategy: Use prisma.$transaction directly (same mechanism as
   * TransactionRunner). Pre-create a MemoryItem and MemoryVersion
   * outside the transaction. Inside a new transaction, create a NEW
   * MemoryItem, then attempt to create a MemoryVersion with the same
   * (itemId, versionNumber) as the pre-existing version — triggering
   * a real PostgreSQL unique constraint violation on @@unique([itemId, versionNumber]).
   * The entire transaction must roll back, leaving no orphaned MemoryItem.
   */
  it('C1 atomicity: item creation rolls back when version creation fails', async () => {
    // Step 1: Pre-create a MemoryItem and MemoryVersion (version 1)
    const existingItem = await prisma.memoryItem.create({
      data: {
        content: 'Existing item for constraint',
        type: 'fact',
        companyId: COMPANY_A,
        sourceAuthor: 'test',
        sourceName: 'test',
      },
    });

    await prisma.memoryVersion.create({
      data: {
        itemId: existingItem.id,
        versionNumber: 1,
        content: existingItem.content,
        snapshot: {},
      },
    });

    // Step 2: Inside a transaction, create a new MemoryItem then attempt
    // to create a MemoryVersion with the same (itemId, versionNumber)
    // as the pre-existing version — this triggers a real constraint violation.
    await expect(
      prisma.$transaction(async (tx) => {
        // Create a new MemoryItem — succeeds
        const newItem = await tx.memoryItem.create({
          data: {
            content: 'Will be rolled back',
            type: 'fact',
            companyId: COMPANY_A,
            sourceAuthor: 'test',
            sourceName: 'test',
          },
        });

        // Attempt to create a MemoryVersion with (itemId=existingItem.id, versionNumber=1)
        // This triggers a UNIQUE constraint violation on @@unique([itemId, versionNumber])
        await tx.memoryVersion.create({
          data: {
            itemId: existingItem.id, // existing item — version 1 already exists
            versionNumber: 1,
            content: 'duplicate version',
            snapshot: {},
          },
        });

        return newItem;
      }),
    ).rejects.toThrow();

    // Step 3: Verify — no orphaned MemoryItem should exist
    const orphanedItems = await prisma.memoryItem.findMany({
      where: { content: 'Will be rolled back' },
    });
    expect(orphanedItems).toHaveLength(0);

    // Step 4: Verify — pre-existing data unchanged
    const verifyItem = await prisma.memoryItem.findUnique({
      where: { id: existingItem.id },
    });
    expect(verifyItem).not.toBeNull();
    expect(verifyItem!.content).toBe('Existing item for constraint');
  });

  /**
   * C4/C5 atomicity: update rolls back when version creation fails.
   *
   * Strategy: Create an item with version 1. Pre-create a conflicting
   * MemoryVersion with versionNumber=2 for the same item. When
   * repo.update() tries to create version 2, the unique constraint
   * triggers a real PostgreSQL error and the transaction rolls back.
   * The item content and version count remain unchanged.
   */
  it('C4/C5 atomicity: update rolls back when version creation fails', async () => {
    // Step 1: Create an item (version 1 auto-created via service.record)
    const item = await record({
      content: 'Original content for atomicity',
      companyId: COMPANY_A,
    });

    // Step 2: Verify initial state — version 1 exists
    const versionsBefore = await prisma.memoryVersion.findMany({
      where: { itemId: item.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versionsBefore).toHaveLength(1);
    expect(versionsBefore[0].versionNumber).toBe(1);

    // Step 3: Pre-create a conflicting MemoryVersion with versionNumber=2
    // This will cause repo.update() to fail when it tries to create version 2.
    await prisma.memoryVersion.create({
      data: {
        itemId: item.id,
        versionNumber: 2,
        content: 'Conflicting version that already exists',
        snapshot: {},
      },
    });

    // Step 4: Attempt update — should roll back due to unique constraint
    await expect(
      REPOSITORY.update(
        { id: item.id, content: 'Updated content that should not persist' },
        COMPANY_A,
      ),
    ).rejects.toThrow();

    // Step 5: Verify rollback — item content unchanged
    const itemAfter = await prisma.memoryItem.findUnique({
      where: { id: item.id },
    });
    expect(itemAfter).not.toBeNull();
    expect(itemAfter!.content).toBe('Original content for atomicity');

    // Step 6: Verify version count unchanged (still 1 original + 1 pre-created = 2)
    const versionsAfter = await prisma.memoryVersion.findMany({
      where: { itemId: item.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versionsAfter).toHaveLength(2);
    expect(versionsAfter[0].versionNumber).toBe(1);
    expect(versionsAfter[0].content).toBe('Original content for atomicity');
    expect(versionsAfter[1].versionNumber).toBe(2);
    expect(versionsAfter[1].content).toBe('Conflicting version that already exists');
  });

  /**
   * C4/C5 atomicity: version history remains consistent after failed update.
   *
   * Strategy: Create an item, perform one successful update (versions 1→2),
   * then pre-create a conflicting version 3. A second update attempt will
   * fail on the unique constraint, leaving versions at exactly 2 with
   * the item content from the first update.
   */
  it('C4/C5 atomicity: version history remains consistent after failed update', async () => {
    // Step 1: Create an item and perform a successful update first
    const item = await record({
      content: 'Version consistency test',
      companyId: COMPANY_A,
    });

    const updated = await SERVICE.update(item.id, 'Second version content', COMPANY_A);
    expect(updated.content).toBe('Second version content');

    // Verify we have 2 versions
    const versionsAfterFirstUpdate = await SERVICE.getVersionHistory(item.id, COMPANY_A);
    expect(versionsAfterFirstUpdate).toHaveLength(2);

    // Step 2: Pre-create a conflicting MemoryVersion with versionNumber=3
    await prisma.memoryVersion.create({
      data: {
        itemId: item.id,
        versionNumber: 3,
        content: 'Conflicting version 3',
        snapshot: {},
      },
    });

    // Step 3: Attempt a second update — should fail on unique constraint
    await expect(
      REPOSITORY.update(
        { id: item.id, content: 'Third version that should not exist' },
        COMPANY_A,
      ),
    ).rejects.toThrow();

    // Step 4: Verify — item content unchanged from second version
    const itemAfter = await prisma.memoryItem.findUnique({
      where: { id: item.id },
    });
    expect(itemAfter!.content).toBe('Second version content');

    // Step 5: Verify — still exactly 3 versions (1 original + 1 update + 1 pre-created)
    const versionsAfterFailedUpdate = await prisma.memoryVersion.findMany({
      where: { itemId: item.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versionsAfterFailedUpdate).toHaveLength(3);
    expect(versionsAfterFailedUpdate[0].versionNumber).toBe(1);
    expect(versionsAfterFailedUpdate[1].versionNumber).toBe(2);
    expect(versionsAfterFailedUpdate[2].versionNumber).toBe(3);
    expect(versionsAfterFailedUpdate[2].content).toBe('Conflicting version 3');
  });
});

// ══════════════════════════════════════════════════════════════════
// Adapter Integration
// ══════════════════════════════════════════════════════════════════

describe('Adapter — Full Flow', () => {
  it('should record and retrieve through adapter', async () => {
    const item = await ADAPTER.record({
      content: 'Adapter test content',
      type: 'fact',
      companyId: COMPANY_A,
      sourceAuthor: 'adapter-test',
      sourceName: 'test',
    });
    createdItemIds.push(item.id);

    const found = await ADAPTER.getById(item.id, COMPANY_A);
    expect(found).not.toBeNull();
    expect(found!.content).toBe('Adapter test content');
  });

  it('should return null for cross-company through adapter', async () => {
    const item = await ADAPTER.record({
      content: 'Adapter cross-company test',
      type: 'fact',
      companyId: COMPANY_A,
      sourceAuthor: 'adapter-test',
      sourceName: 'test',
    });
    createdItemIds.push(item.id);

    // Repository enforces companyId — returns null, no error
    const found = await ADAPTER.getById(item.id, COMPANY_B);
    expect(found).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Repository — companyId isolation at boundary (direct MemoryRepository calls)
// ══════════════════════════════════════════════════════════════════

describe('Repository — companyId isolation at boundary', () => {
  // Helper: create item directly via Repository
  async function repoCreate(content: string, companyId: string) {
    return REPOSITORY.create({
      content,
      type: 'fact',
      companyId,
      sourceAuthor: 'repo-test',
      sourceName: 'test',
    });
  }

  // 1. findById
  it('findById: COMPANY_A finds, COMPANY_B returns null', async () => {
    const item = await repoCreate('findById test', COMPANY_A);
    createdItemIds.push(item.id);

    const foundA = await REPOSITORY.findById(item.id, COMPANY_A);
    expect(foundA).not.toBeNull();
    expect(foundA!.id).toBe(item.id);

    const foundB = await REPOSITORY.findById(item.id, COMPANY_B);
    expect(foundB).toBeNull();
  });

  // 2. update
  it('update: COMPANY_B on COMPANY_A item rejected, original unchanged', async () => {
    const item = await repoCreate('Original content', COMPANY_A);
    createdItemIds.push(item.id);

    // COMPANY_B should fail — findById returns null inside update
    await expect(
      REPOSITORY.update({ id: item.id, content: 'Hacked' }, COMPANY_B),
    ).rejects.toThrow(/not found or not accessible/);

    // Verify original content unchanged
    const verify = await REPOSITORY.findById(item.id, COMPANY_A);
    expect(verify!.content).toBe('Original content');
  });

  // 3. getVersions
  it('getVersions: COMPANY_B returns empty', async () => {
    const item = await repoCreate('Versions test', COMPANY_A);
    createdItemIds.push(item.id);

    const versionsB = await REPOSITORY.getVersions(item.id, COMPANY_B);
    expect(versionsB).toHaveLength(0);

    // COMPANY_A can see versions
    const versionsA = await REPOSITORY.getVersions(item.id, COMPANY_A);
    expect(versionsA.length).toBeGreaterThanOrEqual(1);
  });

  // 4. getRelationships
  it('getRelationships: COMPANY_B returns empty', async () => {
    const itemA = await repoCreate('Rel A', COMPANY_A);
    const itemB = await repoCreate('Rel B', COMPANY_A);
    createdItemIds.push(itemA.id, itemB.id);

    // Create relationship via COMPANY_A
    await REPOSITORY.createRelationship(
      { sourceId: itemA.id, targetId: itemB.id, label: 'related_to' },
      COMPANY_A,
    );

    // COMPANY_B sees nothing
    const relsB = await REPOSITORY.getRelationships(itemA.id, COMPANY_B);
    expect(relsB).toHaveLength(0);

    // COMPANY_A sees the relationship
    const relsA = await REPOSITORY.getRelationships(itemA.id, COMPANY_A);
    expect(relsA.length).toBeGreaterThanOrEqual(1);
  });

  // 5. setStatus
  it('setStatus: COMPANY_B returns null, status unchanged', async () => {
    const item = await repoCreate('Status test', COMPANY_A);
    createdItemIds.push(item.id);

    const resultB = await REPOSITORY.setStatus(item.id, 'forgotten', COMPANY_B, 'hacked');
    expect(resultB).toBeNull();

    // Verify status unchanged
    const verify = await REPOSITORY.findById(item.id, COMPANY_A);
    expect(verify!.status).toBe('active');
  });

  // 6. updateConfidence
  it('updateConfidence: COMPANY_B returns null, confidence unchanged', async () => {
    const item = await repoCreate('Confidence test', COMPANY_A);
    createdItemIds.push(item.id);

    const resultB = await REPOSITORY.updateConfidence(item.id, 'certain', COMPANY_B);
    expect(resultB).toBeNull();

    // Verify confidence unchanged
    const verify = await REPOSITORY.findById(item.id, COMPANY_A);
    expect(verify!.confidence).toBe('tentative');
  });

  // 7. getConfidenceLogs
  it('getConfidenceLogs: COMPANY_B returns empty', async () => {
    const item = await repoCreate('ConfLogs test', COMPANY_A);
    createdItemIds.push(item.id);

    const logsB = await REPOSITORY.getConfidenceLogs(item.id, COMPANY_B);
    expect(logsB).toHaveLength(0);
  });

  // 8. getTraceabilityLogs
  it('getTraceabilityLogs: COMPANY_B returns empty', async () => {
    const item = await repoCreate('TraceLogs test', COMPANY_A);
    createdItemIds.push(item.id);

    // Add a traceability log directly via Repository (Service would do this)
    await REPOSITORY.addTraceabilityLog({
      itemId: item.id,
      action: 'test_action',
      actor: 'repo-test',
      details: { test: true },
    });

    const logsB = await REPOSITORY.getTraceabilityLogs(item.id, COMPANY_B);
    expect(logsB).toHaveLength(0);

    // COMPANY_A can see logs
    const logsA = await REPOSITORY.getTraceabilityLogs(item.id, COMPANY_A);
    expect(logsA.length).toBeGreaterThanOrEqual(1);
  });

  // 9. createRelationship: cross-company rejected
  it('createRelationship: cross-company source+target rejected, no Relationship created', async () => {
    const itemA = await repoCreate('CrossRel A', COMPANY_A);
    const itemB = await repoCreate('CrossRel B', COMPANY_B);
    createdItemIds.push(itemA.id, itemB.id);

    await expect(
      REPOSITORY.createRelationship(
        { sourceId: itemA.id, targetId: itemB.id, label: 'cross' },
        COMPANY_A,
      ),
    ).rejects.toThrow(/not found or not accessible/);

    // Verify no relationship created
    const relsA = await REPOSITORY.getRelationships(itemA.id, COMPANY_A);
    const crossRels = relsA.filter(
      (r) => r.sourceId === itemA.id && r.targetId === itemB.id,
    );
    expect(crossRels).toHaveLength(0);
  });

  // 10. createEvolutionLink: cross-company rejected
  it('createEvolutionLink: cross-company rejected, no EvolutionLink created', async () => {
    const old = await repoCreate('Old knowledge', COMPANY_A);
    const other = await repoCreate('Other company knowledge', COMPANY_B);
    createdItemIds.push(old.id, other.id);

    await expect(
      REPOSITORY.createEvolutionLink(
        { supersededId: old.id, supersededById: other.id },
        COMPANY_A,
      ),
    ).rejects.toThrow(/not found or not accessible/);

    // Verify no evolution link created
    const links = await REPOSITORY.getEvolutionLinks(old.id, COMPANY_A);
    const crossLinks = links.filter(
      (l) => l.supersededId === old.id && l.supersededById === other.id,
    );
    expect(crossLinks).toHaveLength(0);
  });

  // 11. contradiction: cross-company creation rejected, cross-company read empty
  it('createContradiction: cross-company rejected, no Contradiction created', async () => {
    const itemA = await repoCreate('Contra A', COMPANY_A);
    const itemB = await repoCreate('Contra B', COMPANY_B);
    createdItemIds.push(itemA.id, itemB.id);

    await expect(
      REPOSITORY.createContradiction(
        { itemAId: itemA.id, itemBId: itemB.id, evidence: 'cross', confidence: 0.5 },
        COMPANY_A,
      ),
    ).rejects.toThrow(/not found or not accessible/);

    // Verify no contradiction created
    const contras = await REPOSITORY.findContradictions(itemA.id, COMPANY_A);
    expect(contras).toHaveLength(0);
  });

  it('findContradictions: wrong company returns empty', async () => {
    const itemA = await repoCreate('ContraRead A', COMPANY_A);
    const itemB = await repoCreate('ContraRead B', COMPANY_A);
    createdItemIds.push(itemA.id, itemB.id);

    // Create valid contradiction within COMPANY_A
    await REPOSITORY.createContradiction(
      { itemAId: itemA.id, itemBId: itemB.id, evidence: 'same company', confidence: 0.9 },
      COMPANY_A,
    );

    // COMPANY_B sees nothing
    const contrasB = await REPOSITORY.findContradictions(itemA.id, COMPANY_B);
    expect(contrasB).toHaveLength(0);

    // COMPANY_A sees it
    const contrasA = await REPOSITORY.findContradictions(itemA.id, COMPANY_A);
    expect(contrasA).toHaveLength(1);
  });
});
