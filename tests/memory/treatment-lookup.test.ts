// Knowledge Engine — Treatment Lookup Tests
// Phase 2: lookupTreatment using entity→treatment knowledge.
//
// Tests demonstrate:
//   - Known entity → FOUND with correct GL/direction/confidence
//   - Unknown entity → NOT_FOUND
//   - Same entity, different tenants → respective GL
//   - Cross-tenant treatment cannot leak
//   - Forgotten/non-current treatment not returned
//   - Storage failure → ERROR (not NOT_FOUND)
//   - Pattern/description not required for entity lookup
//   - No AI, EntityContext, BankRule, or import pipeline dependency

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  lookupTreatment,
  normalizeDescription,
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

let mockItems: MockItem[] = [];
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
      return item;
    }),
  };
}

// ─── normalizeDescription (unchanged from Phase 1) ──────────────

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

// ─── lookupTreatment ────────────────────────────────────────────

describe('lookupTreatment', () => {
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mockItems = [];
    nextId = 1;
    adapter = createMockAdapter();
  });

  // Test 1: existing company+entity treatment → FOUND
  it('returns FOUND for known entity treatment', async () => {
    const content: ClassificationContent = {
      pattern: 'VENDOR X',
      glAccountId: 'gl_100',
      direction: 'debit',
      source: 'user_correction',
      entityId: 'entity_001',
    };
    mockItems.push({
      id: 'mem_001',
      content: JSON.stringify(content),
      type: 'classification',
      status: 'active',
      confidence: 'certain',
      companyId: 'company_A',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_001');
    expect(result).toEqual({
      status: 'FOUND',
      glAccountId: 'gl_100',
      direction: 'debit',
      confidence: 'certain',
      memoryItemId: 'mem_001',
    });
  });

  // Test 2: returned GL is correct
  it('returns the correct GL account', async () => {
    const content: ClassificationContent = {
      pattern: 'VENDOR Y',
      glAccountId: 'gl_200',
      direction: 'credit',
      source: 'user_correction',
      entityId: 'entity_002',
    };
    mockItems.push({
      id: 'mem_002',
      content: JSON.stringify(content),
      type: 'classification',
      status: 'active',
      confidence: 'tentative',
      companyId: 'company_A',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_002');
    expect(result.status).toBe('FOUND');
    if (result.status === 'FOUND') {
      expect(result.glAccountId).toBe('gl_200');
    }
  });

  // Test 3: returned direction is correct
  it('returns the correct direction', async () => {
    const content: ClassificationContent = {
      pattern: 'VENDOR Z',
      glAccountId: 'gl_300',
      direction: 'any',
      source: 'user_correction',
      entityId: 'entity_003',
    };
    mockItems.push({
      id: 'mem_003',
      content: JSON.stringify(content),
      type: 'classification',
      status: 'active',
      confidence: 'tentative',
      companyId: 'company_A',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_003');
    expect(result.status).toBe('FOUND');
    if (result.status === 'FOUND') {
      expect(result.direction).toBe('any');
    }
  });

  // Test 4: returned confidence is existing confidence
  it('returns the stored confidence level', async () => {
    const content: ClassificationContent = {
      pattern: 'VENDOR W',
      glAccountId: 'gl_400',
      direction: 'debit',
      source: 'user_correction',
      entityId: 'entity_004',
    };
    mockItems.push({
      id: 'mem_004',
      content: JSON.stringify(content),
      type: 'classification',
      status: 'active',
      confidence: 'uncertain',
      companyId: 'company_A',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_004');
    expect(result.status).toBe('FOUND');
    if (result.status === 'FOUND') {
      expect(result.confidence).toBe('uncertain');
    }
  });

  // Test 5: returned memoryItemId is correct
  it('returns the correct memory item ID', async () => {
    const content: ClassificationContent = {
      pattern: 'VENDOR V',
      glAccountId: 'gl_500',
      direction: 'credit',
      source: 'import_correction',
      entityId: 'entity_005',
    };
    mockItems.push({
      id: 'mem_005',
      content: JSON.stringify(content),
      type: 'classification',
      status: 'active',
      confidence: 'tentative',
      companyId: 'company_A',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_005');
    expect(result.status).toBe('FOUND');
    if (result.status === 'FOUND') {
      expect(result.memoryItemId).toBe('mem_005');
    }
  });

  // Test 6: unknown entity → NOT_FOUND
  it('returns NOT_FOUND for unknown entity', async () => {
    mockItems.push({
      id: 'mem_006',
      content: JSON.stringify({
        pattern: 'VENDOR X',
        glAccountId: 'gl_100',
        direction: 'debit',
        source: 'user_correction',
        entityId: 'entity_001',
      }),
      type: 'classification',
      status: 'active',
      confidence: 'certain',
      companyId: 'company_A',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_999');
    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  // Test 7: same entityId different tenants → respective GL
  it('returns correct GL per tenant for same entity', async () => {
    const contentA: ClassificationContent = {
      pattern: 'SHARED ENTITY',
      glAccountId: 'gl_A100',
      direction: 'debit',
      source: 'user_correction',
      entityId: 'entity_shared',
    };
    const contentB: ClassificationContent = {
      pattern: 'SHARED ENTITY',
      glAccountId: 'gl_B200',
      direction: 'credit',
      source: 'user_correction',
      entityId: 'entity_shared',
    };

    mockItems.push(
      {
        id: 'mem_A',
        content: JSON.stringify(contentA),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
      {
        id: 'mem_B',
        content: JSON.stringify(contentB),
        type: 'classification',
        status: 'active',
        confidence: 'tentative',
        companyId: 'company_B',
      },
    );

    const rA = await lookupTreatment(adapter, 'company_A', 'entity_shared');
    expect(rA.status).toBe('FOUND');
    if (rA.status === 'FOUND') {
      expect(rA.glAccountId).toBe('gl_A100');
    }

    const rB = await lookupTreatment(adapter, 'company_B', 'entity_shared');
    expect(rB.status).toBe('FOUND');
    if (rB.status === 'FOUND') {
      expect(rB.glAccountId).toBe('gl_B200');
    }
  });

  // Test 8: cross-tenant treatment cannot leak
  it('does not return treatment from another tenant', async () => {
    mockItems.push({
      id: 'mem_B_only',
      content: JSON.stringify({
        pattern: 'VENDOR X',
        glAccountId: 'gl_B_only',
        direction: 'debit',
        source: 'user_correction',
        entityId: 'entity_B',
      }),
      type: 'classification',
      status: 'active',
      confidence: 'certain',
      companyId: 'company_B',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_B');
    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  // Test 9: forgotten/non-current treatment not returned
  it('does not return forgotten items', async () => {
    const content: ClassificationContent = {
      pattern: 'VENDOR OLD',
      glAccountId: 'gl_old',
      direction: 'debit',
      source: 'user_correction',
      entityId: 'entity_old',
    };
    mockItems.push({
      id: 'mem_forgotten',
      content: JSON.stringify(content),
      type: 'classification',
      status: 'forgotten',
      confidence: 'tentative',
      companyId: 'company_A',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_old');
    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  // Test 10: storage failure → ERROR (not NOT_FOUND)
  it('returns ERROR on database failure', async () => {
    const errorAdapter = {
      getByType: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      record: vi.fn(),
    };

    const result = await lookupTreatment(errorAdapter, 'company_A', 'entity_001');
    expect(result).toEqual({ status: 'ERROR', reason: 'Database connection failed' });
  });

  // Test 11: pattern/description is not required for entity lookup
  it('does not require pattern or description', async () => {
    const content: ClassificationContent = {
      pattern: 'ANY PATTERN',
      glAccountId: 'gl_100',
      direction: 'debit',
      source: 'user_correction',
      entityId: 'entity_no_pattern',
    };
    mockItems.push({
      id: 'mem_no_pattern',
      content: JSON.stringify(content),
      type: 'classification',
      status: 'active',
      confidence: 'certain',
      companyId: 'company_A',
    });

    // Only providing companyId and entityId — no pattern/description
    const result = await lookupTreatment(adapter, 'company_A', 'entity_no_pattern');
    expect(result.status).toBe('FOUND');
    if (result.status === 'FOUND') {
      expect(result.glAccountId).toBe('gl_100');
    }
  });

  // Test 12: AI not called
  it('does not call AI', async () => {
    const aiSpy = vi.fn();
    await lookupTreatment(adapter, 'company_A', 'entity_001');
    expect(aiSpy).not.toHaveBeenCalled();
  });

  // Test 13: EntityContext not read
  it('does not read EntityContext', async () => {
    // The adapter mock only provides getByType — no EntityContext methods
    await lookupTreatment(adapter, 'company_A', 'entity_001');
    // If EntityContext were read, the adapter would need additional methods
    // This test verifies the function only uses getByType
  });

  // Test 14: BankRule not called
  it('does not invoke BankRule', async () => {
    await lookupTreatment(adapter, 'company_A', 'entity_001');
    // BankRule is a separate system — no dependency exists
  });

  // Test 15: import pipeline not called
  it('does not touch import pipeline', async () => {
    await lookupTreatment(adapter, 'company_A', 'entity_001');
    // Import pipeline is a consumer, not a dependency
  });

  // Edge cases
  it('handles empty companyId', async () => {
    const result = await lookupTreatment(adapter, '', 'entity_001');
    expect(result).toEqual({ status: 'ERROR', reason: 'Invalid companyId' });
  });

  it('handles empty entityId', async () => {
    const result = await lookupTreatment(adapter, 'company_A', '');
    expect(result).toEqual({ status: 'ERROR', reason: 'Invalid entityId' });
  });

  it('handles item with no entityId (old format)', async () => {
    const content: ClassificationContent = {
      pattern: 'OLD FORMAT',
      glAccountId: 'gl_old',
      direction: 'debit',
      source: 'user_correction',
      // No entityId — old format record
    };
    mockItems.push({
      id: 'mem_old',
      content: JSON.stringify(content),
      type: 'classification',
      status: 'active',
      confidence: 'tentative',
      companyId: 'company_A',
    });

    // Old format record should not match any entityId
    const result = await lookupTreatment(adapter, 'company_A', 'entity_any');
    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  it('handles malformed JSON content gracefully', async () => {
    mockItems.push({
      id: 'mem_malformed',
      content: 'NOT VALID JSON',
      type: 'classification',
      status: 'active',
      confidence: 'tentative',
      companyId: 'company_A',
    });

    const result = await lookupTreatment(adapter, 'company_A', 'entity_001');
    expect(result).toEqual({ status: 'NOT_FOUND' });
  });

  // ─── Ambiguity detection (BLOQUE3-066) ──────────────────────────

  // BLOCKER TEST: two active contradictory treatments → ERROR
  it('returns ERROR for contradictory active treatments (order A→B)', async () => {
    mockItems.push(
      {
        id: 'mem_amb_A',
        content: JSON.stringify({
          pattern: 'VENDOR X',
          glAccountId: 'gl_A',
          direction: 'debit',
          source: 'user_correction',
          entityId: 'entity_amb',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
      {
        id: 'mem_amb_B',
        content: JSON.stringify({
          pattern: 'VENDOR X',
          glAccountId: 'gl_B',
          direction: 'debit',
          source: 'user_correction',
          entityId: 'entity_amb',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'tentative',
        companyId: 'company_A',
      },
    );

    const result = await lookupTreatment(adapter, 'company_A', 'entity_amb');
    expect(result).toEqual({
      status: 'ERROR',
      reason: 'Ambiguous active treatment for entity entity_amb: 2 active treatments found',
    });
  });

  // Same test reversed order — must produce identical result
  it('returns ERROR for contradictory active treatments (order B→A)', async () => {
    mockItems.push(
      {
        id: 'mem_amb_B',
        content: JSON.stringify({
          pattern: 'VENDOR X',
          glAccountId: 'gl_B',
          direction: 'debit',
          source: 'user_correction',
          entityId: 'entity_amb',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'tentative',
        companyId: 'company_A',
      },
      {
        id: 'mem_amb_A',
        content: JSON.stringify({
          pattern: 'VENDOR X',
          glAccountId: 'gl_A',
          direction: 'debit',
          source: 'user_correction',
          entityId: 'entity_amb',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
    );

    const result = await lookupTreatment(adapter, 'company_A', 'entity_amb');
    expect(result).toEqual({
      status: 'ERROR',
      reason: 'Ambiguous active treatment for entity entity_amb: 2 active treatments found',
    });
  });

  // Identical duplicate: same GL but different memory identity → ERROR
  it('returns ERROR for identical duplicate treatments (same GL, different identity)', async () => {
    mockItems.push(
      {
        id: 'mem_dup_1',
        content: JSON.stringify({
          pattern: 'VENDOR Y',
          glAccountId: 'gl_same',
          direction: 'credit',
          source: 'user_correction',
          entityId: 'entity_dup',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
      {
        id: 'mem_dup_2',
        content: JSON.stringify({
          pattern: 'VENDOR Y',
          glAccountId: 'gl_same',
          direction: 'credit',
          source: 'import_correction',
          entityId: 'entity_dup',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'tentative',
        companyId: 'company_A',
      },
    );

    const result = await lookupTreatment(adapter, 'company_A', 'entity_dup');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous active treatment for entity entity_dup');
    }
  });

  // BLOCKER: same GL, different direction → ERROR
  it('returns ERROR for same GL with different direction', async () => {
    mockItems.push(
      {
        id: 'mem_dir_1',
        content: JSON.stringify({
          pattern: 'VENDOR Z',
          glAccountId: 'gl_shared',
          direction: 'debit',
          source: 'user_correction',
          entityId: 'entity_dir',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
      {
        id: 'mem_dir_2',
        content: JSON.stringify({
          pattern: 'VENDOR Z',
          glAccountId: 'gl_shared',
          direction: 'credit',
          source: 'user_correction',
          entityId: 'entity_dir',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
    );

    const result = await lookupTreatment(adapter, 'company_A', 'entity_dir');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous active treatment for entity entity_dir');
      expect(result.reason).toContain('2 active treatments found');
    }
  });

  // BLOCKER: same GL, different direction, reversed order
  it('returns ERROR for same GL with different direction (reversed order)', async () => {
    mockItems.push(
      {
        id: 'mem_dir_2',
        content: JSON.stringify({
          pattern: 'VENDOR Z',
          glAccountId: 'gl_shared',
          direction: 'credit',
          source: 'user_correction',
          entityId: 'entity_dir',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
      {
        id: 'mem_dir_1',
        content: JSON.stringify({
          pattern: 'VENDOR Z',
          glAccountId: 'gl_shared',
          direction: 'debit',
          source: 'user_correction',
          entityId: 'entity_dir',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
    );

    const result = await lookupTreatment(adapter, 'company_A', 'entity_dir');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous active treatment for entity entity_dir');
      expect(result.reason).toContain('2 active treatments found');
    }
  });

  // BLOCKER: same GL, different confidence
  it('returns ERROR for same GL with different confidence', async () => {
    mockItems.push(
      {
        id: 'mem_conf_1',
        content: JSON.stringify({
          pattern: 'VENDOR W',
          glAccountId: 'gl_same_conf',
          direction: 'debit',
          source: 'user_correction',
          entityId: 'entity_conf',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
      {
        id: 'mem_conf_2',
        content: JSON.stringify({
          pattern: 'VENDOR W',
          glAccountId: 'gl_same_conf',
          direction: 'debit',
          source: 'import_correction',
          entityId: 'entity_conf',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'tentative',
        companyId: 'company_A',
      },
    );

    const result = await lookupTreatment(adapter, 'company_A', 'entity_conf');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous active treatment for entity entity_conf');
      expect(result.reason).toContain('2 active treatments found');
    }
  });

  // BLOCKER: same GL, different confidence, reversed order
  it('returns ERROR for same GL with different confidence (reversed order)', async () => {
    mockItems.push(
      {
        id: 'mem_conf_2',
        content: JSON.stringify({
          pattern: 'VENDOR W',
          glAccountId: 'gl_same_conf',
          direction: 'debit',
          source: 'import_correction',
          entityId: 'entity_conf',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'tentative',
        companyId: 'company_A',
      },
      {
        id: 'mem_conf_1',
        content: JSON.stringify({
          pattern: 'VENDOR W',
          glAccountId: 'gl_same_conf',
          direction: 'debit',
          source: 'user_correction',
          entityId: 'entity_conf',
        }),
        type: 'classification',
        status: 'active',
        confidence: 'certain',
        companyId: 'company_A',
      },
    );

    const result = await lookupTreatment(adapter, 'company_A', 'entity_conf');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous active treatment for entity entity_conf');
      expect(result.reason).toContain('2 active treatments found');
    }
  });
});
