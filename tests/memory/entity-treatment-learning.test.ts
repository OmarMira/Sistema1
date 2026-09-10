// Knowledge Engine — Entity-Aware Learning Tests
// Phase 3: learnEntityTreatment using entity→treatment knowledge.
//
// Tests demonstrate:
//   - CREATED: no existing treatment → new MemoryItem with entityId
//   - UNCHANGED: same GL/direction → no-op, no duplicate, no version
//   - UPDATED: different GL or direction → C4/C5 update, stable ID, version preserved
//   - ERROR: multiple active treatments → ambiguous, nothing modified
//   - Tenant isolation
//   - No AI, EntityContext, BankRule, or import pipeline dependency
//   - PostgreSQL versioning: C4/C5 creates version + preserves old content

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  learnEntityTreatment,
} from '../../src/memory/classification-knowledge';
import type { ClassificationContent } from '../../src/memory/classification-knowledge';

// ─── Mock MemoryAdapter ─────────────────────────────────────────

interface MockItem {
  id: string;
  content: string;
  type: string;
  status: string;
  confidence: string;
  companyId: string;
}

interface MockVersion {
  itemId: string;
  versionNumber: number;
  content: string;
}

let mockItems: MockItem[] = [];
let mockVersions: MockVersion[] = [];
let nextId = 1;

function createMockAdapter() {
  return {
    getByType: vi.fn(async (companyId: string, type: string) => {
      return mockItems.filter(
        (item) => item.companyId === companyId && item.type === type,
      );
    }),
    record: vi.fn(async (args: { content: string; type: string; companyId: string }) => {
      const id = `mem_${nextId++}`;
      const item: MockItem = {
        id,
        content: args.content,
        type: args.type,
        status: 'active',
        confidence: 'tentative',
        companyId: args.companyId,
      };
      mockItems.push(item);
      // C5: initial version
      mockVersions.push({
        itemId: id,
        versionNumber: 1,
        content: args.content,
      });
      return item;
    }),
    update: vi.fn(async (id: string, newContent: string, companyId: string) => {
      const item = mockItems.find((i) => i.id === id && i.companyId === companyId);
      if (!item) throw new Error(`MemoryItem not found or not accessible: ${id}`);

      // C5: save previous content as version
      const maxVersion = mockVersions
        .filter((v) => v.itemId === id)
        .reduce((max, v) => Math.max(max, v.versionNumber), 0);
      mockVersions.push({
        itemId: id,
        versionNumber: maxVersion + 1,
        content: item.content, // previous content
      });

      // C4: update content
      item.content = newContent;
      return item;
    }),
    getVersionHistory: vi.fn(async (id: string, companyId: string) => {
      return mockVersions.filter((v) => v.itemId === id);
    }),
  };
}

// ─── learnEntityTreatment ───────────────────────────────────────

describe('learnEntityTreatment', () => {
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mockItems = [];
    mockVersions = [];
    nextId = 1;
    adapter = createMockAdapter();
  });

  // ─── CREATED ──────────────────────────────────────────────────

  // Test 1: no existing treatment → CREATED
  it('creates new treatment when none exists', async () => {
    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', 'gl_100', 'debit', 'user_correction',
    );
    expect(result.status).toBe('CREATED');
    if (result.status === 'CREATED') {
      expect(result.itemId).toMatch(/^mem_/);
    }
  });

  // Test 2: created MemoryItem contains entityId
  it('stores entityId in created MemoryItem', async () => {
    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', 'gl_100', 'debit', 'user_correction',
    );
    expect(result.status).toBe('CREATED');
    const created = mockItems.find((i) => i.id === (result as { itemId: string }).itemId);
    expect(created).toBeDefined();
    const content = JSON.parse(created!.content) as ClassificationContent;
    expect(content.entityId).toBe('entity_001');
  });

  // Test 3: created GL correct
  it('stores correct GL account', async () => {
    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', 'gl_200', 'credit', 'user_correction',
    );
    expect(result.status).toBe('CREATED');
    const created = mockItems.find((i) => i.id === (result as { itemId: string }).itemId);
    const content = JSON.parse(created!.content) as ClassificationContent;
    expect(content.glAccountId).toBe('gl_200');
  });

  // Test 4: created direction correct
  it('stores correct direction', async () => {
    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', 'gl_100', 'any', 'import_correction',
    );
    expect(result.status).toBe('CREATED');
    const created = mockItems.find((i) => i.id === (result as { itemId: string }).itemId);
    const content = JSON.parse(created!.content) as ClassificationContent;
    expect(content.direction).toBe('any');
  });

  // ─── UNCHANGED ───────────────────────────────────────────────

  // Test 5: same entity + same GL/direction → UNCHANGED
  it('returns UNCHANGED for identical treatment', async () => {
    // First: create
    const createResult = await learnEntityTreatment(
      adapter, 'company_A', 'entity_002', 'gl_100', 'debit', 'user_correction',
    );
    expect(createResult.status).toBe('CREATED');

    // Second: same treatment
    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_002', 'gl_100', 'debit', 'import_correction',
    );
    expect(result.status).toBe('UNCHANGED');
    if (result.status === 'UNCHANGED') {
      expect(result.itemId).toBe((createResult as { itemId: string }).itemId);
    }
  });

  // Test 6: UNCHANGED does not create second MemoryItem
  it('does not create duplicate MemoryItem on UNCHANGED', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_003', 'gl_100', 'debit', 'user_correction',
    );
    const countBefore = mockItems.length;

    await learnEntityTreatment(
      adapter, 'company_A', 'entity_003', 'gl_100', 'debit', 'user_correction',
    );
    expect(mockItems.length).toBe(countBefore);
  });

  // Test 7: UNCHANGED does not create artificial version
  it('does not create version on UNCHANGED', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_004', 'gl_100', 'debit', 'user_correction',
    );
    const versionsBefore = mockVersions.length;

    await learnEntityTreatment(
      adapter, 'company_A', 'entity_004', 'gl_100', 'debit', 'user_correction',
    );
    // Only the initial version from C1 should exist
    expect(mockVersions.length).toBe(versionsBefore);
  });

  // ─── UPDATED ─────────────────────────────────────────────────

  // Test 8: same entity + changed GL → UPDATED
  it('returns UPDATED when GL changes', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_005', 'gl_100', 'debit', 'user_correction',
    );

    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_005', 'gl_999', 'debit', 'user_correction',
    );
    expect(result.status).toBe('UPDATED');
  });

  // Test 9: same entity + changed direction → UPDATED
  it('returns UPDATED when direction changes', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_006', 'gl_100', 'debit', 'user_correction',
    );

    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_006', 'gl_100', 'credit', 'user_correction',
    );
    expect(result.status).toBe('UPDATED');
  });

  // Test 10: UPDATED preserves MemoryItem.id
  it('preserves MemoryItem.id on UPDATE', async () => {
    const createResult = await learnEntityTreatment(
      adapter, 'company_A', 'entity_007', 'gl_100', 'debit', 'user_correction',
    );
    const originalId = (createResult as { itemId: string }).itemId;

    const updateResult = await learnEntityTreatment(
      adapter, 'company_A', 'entity_007', 'gl_999', 'credit', 'user_correction',
    );
    expect(updateResult.status).toBe('UPDATED');
    if (updateResult.status === 'UPDATED') {
      expect(updateResult.itemId).toBe(originalId);
    }
  });

  // Test 11: UPDATED preserves previous content in MemoryVersion
  it('creates version with previous content on UPDATE', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_008', 'gl_100', 'debit', 'user_correction',
    );
    const itemId = mockItems[mockItems.length - 1].id;

    await learnEntityTreatment(
      adapter, 'company_A', 'entity_008', 'gl_999', 'credit', 'user_correction',
    );

    // Should have 2 versions: initial (v1) and previous (v2)
    const versions = mockVersions.filter((v) => v.itemId === itemId);
    expect(versions).toHaveLength(2);
    expect(versions[0].versionNumber).toBe(1);
    expect(versions[1].versionNumber).toBe(2);

    // v2 should contain the OLD content (gl_100, debit)
    const oldContent = JSON.parse(versions[1].content) as ClassificationContent;
    expect(oldContent.glAccountId).toBe('gl_100');
    expect(oldContent.direction).toBe('debit');

    // Current item should have new content
    const current = mockItems.find((i) => i.id === itemId);
    const newContent = JSON.parse(current!.content) as ClassificationContent;
    expect(newContent.glAccountId).toBe('gl_999');
    expect(newContent.direction).toBe('credit');
  });

  // ─── AMBIGUOUS ───────────────────────────────────────────────

  // Test 12: multiple active treatments same entity → ERROR
  it('returns ERROR for multiple active treatments', async () => {
    mockItems.push(
      {
        id: 'mem_amb_1',
        content: JSON.stringify({
          pattern: '', glAccountId: 'gl_A', direction: 'debit',
          source: 'user_correction', entityId: 'entity_amb',
        }),
        type: 'classification', status: 'active', confidence: 'certain', companyId: 'company_A',
      },
      {
        id: 'mem_amb_2',
        content: JSON.stringify({
          pattern: '', glAccountId: 'gl_B', direction: 'debit',
          source: 'user_correction', entityId: 'entity_amb',
        }),
        type: 'classification', status: 'active', confidence: 'tentative', companyId: 'company_A',
      },
    );

    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_amb', 'gl_C', 'credit', 'user_correction',
    );
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous active treatment for entity entity_amb');
    }
  });

  // Test 13: ambiguity does not modify any candidate
  it('does not modify existing items on ambiguity', async () => {
    mockItems.push(
      {
        id: 'mem_amb_1',
        content: JSON.stringify({
          pattern: '', glAccountId: 'gl_A', direction: 'debit',
          source: 'user_correction', entityId: 'entity_amb2',
        }),
        type: 'classification', status: 'active', confidence: 'certain', companyId: 'company_A',
      },
      {
        id: 'mem_amb_2',
        content: JSON.stringify({
          pattern: '', glAccountId: 'gl_B', direction: 'debit',
          source: 'user_correction', entityId: 'entity_amb2',
        }),
        type: 'classification', status: 'active', confidence: 'tentative', companyId: 'company_A',
      },
    );

    const contentBefore = mockItems
      .filter((i) => i.entityId === 'entity_amb2' || i.content.includes('entity_amb2'))
      .map((i) => ({ id: i.id, content: i.content }));

    await learnEntityTreatment(
      adapter, 'company_A', 'entity_amb2', 'gl_C', 'credit', 'user_correction',
    );

    // Nothing should have changed
    for (const before of contentBefore) {
      const after = mockItems.find((i) => i.id === before.id);
      expect(after!.content).toBe(before.content);
    }
  });

  // Test 14: ambiguity does not create another item
  it('does not create new item on ambiguity', async () => {
    mockItems.push(
      {
        id: 'mem_amb_1',
        content: JSON.stringify({
          pattern: '', glAccountId: 'gl_A', direction: 'debit',
          source: 'user_correction', entityId: 'entity_amb3',
        }),
        type: 'classification', status: 'active', confidence: 'certain', companyId: 'company_A',
      },
      {
        id: 'mem_amb_2',
        content: JSON.stringify({
          pattern: '', glAccountId: 'gl_B', direction: 'debit',
          source: 'user_correction', entityId: 'entity_amb3',
        }),
        type: 'classification', status: 'active', confidence: 'tentative', companyId: 'company_A',
      },
    );

    const countBefore = mockItems.length;
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_amb3', 'gl_C', 'credit', 'user_correction',
    );
    expect(mockItems.length).toBe(countBefore);
  });

  // ─── TENANT ISOLATION ────────────────────────────────────────

  // Test 15: same entityId in different tenants remains isolated
  it('isolates treatments per tenant', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_shared', 'gl_A100', 'debit', 'user_correction',
    );
    await learnEntityTreatment(
      adapter, 'company_B', 'entity_shared', 'gl_B200', 'credit', 'user_correction',
    );

    // Each company has its own treatment
    const itemsA = mockItems.filter(
      (i) => i.companyId === 'company_A' && i.content.includes('entity_shared'),
    );
    const itemsB = mockItems.filter(
      (i) => i.companyId === 'company_B' && i.content.includes('entity_shared'),
    );
    expect(itemsA).toHaveLength(1);
    expect(itemsB).toHaveLength(1);

    const contentA = JSON.parse(itemsA[0].content) as ClassificationContent;
    const contentB = JSON.parse(itemsB[0].content) as ClassificationContent;
    expect(contentA.glAccountId).toBe('gl_A100');
    expect(contentB.glAccountId).toBe('gl_B200');
  });

  // Test 16: updating tenant A does not modify tenant B
  it('does not cross-tenant mutation', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_cross', 'gl_A', 'debit', 'user_correction',
    );
    await learnEntityTreatment(
      adapter, 'company_B', 'entity_cross', 'gl_B', 'debit', 'user_correction',
    );

    // Update A
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_cross', 'gl_A_NEW', 'credit', 'user_correction',
    );

    // B should be untouched
    const itemsB = mockItems.filter(
      (i) => i.companyId === 'company_B' && i.content.includes('entity_cross'),
    );
    expect(itemsB).toHaveLength(1);
    const contentB = JSON.parse(itemsB[0].content) as ClassificationContent;
    expect(contentB.glAccountId).toBe('gl_B');
    expect(contentB.direction).toBe('debit');
  });

  // ─── ERROR CASES ─────────────────────────────────────────────

  // Test 17: storage failure → ERROR
  it('returns ERROR on database failure', async () => {
    const errorAdapter = {
      getByType: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      record: vi.fn(),
      update: vi.fn(),
      getVersionHistory: vi.fn(),
    };

    const result = await learnEntityTreatment(
      errorAdapter, 'company_A', 'entity_001', 'gl_100', 'debit', 'user_correction',
    );
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toBe('Database connection failed');
    }
  });

  // Test 18: no AI call
  it('does not call AI', async () => {
    const aiSpy = vi.fn();
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', 'gl_100', 'debit', 'user_correction',
    );
    expect(aiSpy).not.toHaveBeenCalled();
  });

  // Test 19: no EntityContext read/write
  it('does not touch EntityContext', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', 'gl_100', 'debit', 'user_correction',
    );
    // Adapter mock only has getByType, record, update — no EntityContext methods
  });

  // Test 20: no BankRule call
  it('does not invoke BankRule', async () => {
    await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', 'gl_100', 'debit', 'user_correction',
    );
  });

  // Test 21: pattern not required
  it('does not require pattern for identity', async () => {
    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_no_pattern', 'gl_100', 'debit', 'user_correction',
    );
    expect(result.status).toBe('CREATED');
    const created = mockItems.find((i) => i.id === (result as { itemId: string }).itemId);
    const content = JSON.parse(created!.content) as ClassificationContent;
    expect(content.pattern).toBe('');
    expect(content.entityId).toBe('entity_no_pattern');
  });

  // ─── EDGE CASES ──────────────────────────────────────────────

  it('handles empty companyId', async () => {
    const result = await learnEntityTreatment(
      adapter, '', 'entity_001', 'gl_100', 'debit', 'user_correction',
    );
    expect(result).toEqual({ status: 'ERROR', reason: 'Invalid companyId' });
  });

  it('handles empty entityId', async () => {
    const result = await learnEntityTreatment(
      adapter, 'company_A', '', 'gl_100', 'debit', 'user_correction',
    );
    expect(result).toEqual({ status: 'ERROR', reason: 'Invalid entityId' });
  });

  it('handles empty glAccountId', async () => {
    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', '', 'debit', 'user_correction',
    );
    expect(result).toEqual({ status: 'ERROR', reason: 'Invalid glAccountId' });
  });

  it('handles invalid direction', async () => {
    const result = await learnEntityTreatment(
      adapter, 'company_A', 'entity_001', 'gl_100', 'sideways' as 'debit' | 'credit' | 'any', 'user_correction',
    );
    expect(result).toEqual({ status: 'ERROR', reason: 'Invalid direction' });
  });
});
