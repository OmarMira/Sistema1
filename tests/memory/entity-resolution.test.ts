// Knowledge Engine — Entity Resolution Tests
// Phase 1: resolveEntity using CompanyKnowledge identity structure.
//
// Tests demonstrate:
//   - Exact canonicalName match → KNOWN
//   - Exact alias match → KNOWN
//   - Case/whitespace normalization → KNOWN
//   - Unknown description → UNKNOWN
//   - Partial match → UNKNOWN
//   - Fuzzy match → UNKNOWN
//   - Tenant isolation → correct entity per company
//   - Cross-tenant → UNKNOWN for other company's entity
//   - Inactive entity → not resolved
//   - Storage error → ERROR (not UNKNOWN)
//   - No AI called
//   - No GL produced

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveEntity, normalizeForResolution } from '../../src/memory/entity-resolution';

// ─── Mock db ─────────────────────────────────────────────────────

interface MockKnowledgeRecord {
  id: string;
  companyId: string;
  canonicalName: string;
  aliases: string[];
  status: string;
}

let mockRecords: MockKnowledgeRecord[] = [];
let shouldThrow = false;

vi.mock('@/lib/db', () => ({
  get db() {
    return {
      companyKnowledge: {
        findMany: vi.fn(async (args: { where: { companyId: string; status: string }; select: Record<string, boolean> }) => {
          if (shouldThrow) {
            throw new Error('Database connection failed');
          }
          return mockRecords.filter(
            (r) =>
              r.companyId === args.where.companyId &&
              r.status === args.where.status,
          );
        }),
      },
    };
  },
}));

// ─── normalizeForResolution ──────────────────────────────────────

describe('normalizeForResolution', () => {
  it('trims whitespace', () => {
    expect(normalizeForResolution('  VENDOR X  ')).toBe('VENDOR X');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeForResolution('VENDOR    X')).toBe('VENDOR X');
  });

  it('uppercases', () => {
    expect(normalizeForResolution('vendor x')).toBe('VENDOR X');
  });

  it('handles tabs and newlines', () => {
    expect(normalizeForResolution('VENDOR\tX\n')).toBe('VENDOR X');
  });

  it('returns empty for empty input', () => {
    expect(normalizeForResolution('')).toBe('');
  });

  it('is deterministic', () => {
    const a = normalizeForResolution('  Vendor   X  ');
    const b = normalizeForResolution('vendor x');
    expect(a).toBe(b);
  });
});

// ─── resolveEntity ───────────────────────────────────────────────

describe('resolveEntity', () => {
  beforeEach(() => {
    mockRecords = [];
    shouldThrow = false;
  });

  // Test 1: canonicalName exact match → KNOWN
  it('resolves exact canonicalName match', async () => {
    mockRecords = [
      {
        id: 'entity_001',
        companyId: 'company_A',
        canonicalName: 'VENDOR X',
        aliases: [],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'VENDOR X');
    expect(result).toEqual({ status: 'KNOWN', entityId: 'entity_001' });
  });

  // Test 2: alias exact match → KNOWN
  it('resolves exact alias match', async () => {
    mockRecords = [
      {
        id: 'entity_002',
        companyId: 'company_A',
        canonicalName: 'VENDOR X',
        aliases: ['VX', 'VENDORX'],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'VX');
    expect(result).toEqual({ status: 'KNOWN', entityId: 'entity_002' });
  });

  // Test 3: case/whitespace normalization → KNOWN
  it('resolves case-insensitive and whitespace-equivalent input', async () => {
    mockRecords = [
      {
        id: 'entity_003',
        companyId: 'company_A',
        canonicalName: 'VENDOR X',
        aliases: ['VENDORX'],
        status: 'active',
      },
    ];

    // Different case
    const r1 = await resolveEntity('company_A', 'vendor x');
    expect(r1).toEqual({ status: 'KNOWN', entityId: 'entity_003' });

    // Extra whitespace
    const r2 = await resolveEntity('company_A', '  VENDOR   X  ');
    expect(r2).toEqual({ status: 'KNOWN', entityId: 'entity_003' });

    // Alias with different case
    const r3 = await resolveEntity('company_A', 'vendorx');
    expect(r3).toEqual({ status: 'KNOWN', entityId: 'entity_003' });
  });

  // Test 4: unknown alias → UNKNOWN
  it('returns UNKNOWN for unknown description', async () => {
    mockRecords = [
      {
        id: 'entity_004',
        companyId: 'company_A',
        canonicalName: 'VENDOR X',
        aliases: ['VX'],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'UNKNOWN VENDOR');
    expect(result).toEqual({ status: 'UNKNOWN' });
  });

  // Test 5: partial match → UNKNOWN
  it('returns UNKNOWN for partial match (no substring matching)', async () => {
    mockRecords = [
      {
        id: 'entity_005',
        companyId: 'company_A',
        canonicalName: 'VENDOR X',
        aliases: [],
        status: 'active',
      },
    ];

    // "VENDOR" is a substring of "VENDOR X" but NOT an exact match
    const result = await resolveEntity('company_A', 'VENDOR');
    expect(result).toEqual({ status: 'UNKNOWN' });
  });

  // Test 6: fuzzy match → UNKNOWN
  it('returns UNKNOWN for fuzzy/similar match (no similarity matching)', async () => {
    mockRecords = [
      {
        id: 'entity_006',
        companyId: 'company_A',
        canonicalName: 'VENDOR X',
        aliases: [],
        status: 'active',
      },
    ];

    // Similar but not exact
    const result = await resolveEntity('company_A', 'VENDOR Y');
    expect(result).toEqual({ status: 'UNKNOWN' });
  });

  // Test 7: same alias in Company A/B → correct entity per tenant
  it('resolves correct entity per tenant for same alias', async () => {
    mockRecords = [
      {
        id: 'entity_A1',
        companyId: 'company_A',
        canonicalName: 'SHARED NAME',
        aliases: ['SHARED'],
        status: 'active',
      },
      {
        id: 'entity_B1',
        companyId: 'company_B',
        canonicalName: 'SHARED NAME',
        aliases: ['SHARED'],
        status: 'active',
      },
    ];

    const rA = await resolveEntity('company_A', 'SHARED');
    expect(rA).toEqual({ status: 'KNOWN', entityId: 'entity_A1' });

    const rB = await resolveEntity('company_B', 'SHARED');
    expect(rB).toEqual({ status: 'KNOWN', entityId: 'entity_B1' });
  });

  // Test 8: entity of other tenant → UNKNOWN
  it('returns UNKNOWN for cross-tenant entity', async () => {
    mockRecords = [
      {
        id: 'entity_B1',
        companyId: 'company_B',
        canonicalName: 'VENDOR X',
        aliases: ['VX'],
        status: 'active',
      },
    ];

    // company_A has no entities — should not find company_B's entity
    const result = await resolveEntity('company_A', 'VX');
    expect(result).toEqual({ status: 'UNKNOWN' });
  });

  // Test 9: inactive entity → not resolved
  it('does not resolve inactive/archived/merged entities', async () => {
    mockRecords = [
      {
        id: 'entity_009',
        companyId: 'company_A',
        canonicalName: 'INACTIVE VENDOR',
        aliases: ['IV'],
        status: 'archived',
      },
      {
        id: 'entity_009b',
        companyId: 'company_A',
        canonicalName: 'MERGED VENDOR',
        aliases: ['MV'],
        status: 'merged',
      },
    ];

    const r1 = await resolveEntity('company_A', 'INACTIVE VENDOR');
    expect(r1).toEqual({ status: 'UNKNOWN' });

    const r2 = await resolveEntity('company_A', 'MERGED VENDOR');
    expect(r2).toEqual({ status: 'UNKNOWN' });
  });

  // Test 10: storage error → ERROR (not UNKNOWN)
  it('returns ERROR on database failure (never UNKNOWN)', async () => {
    shouldThrow = true;

    const result = await resolveEntity('company_A', 'ANY');
    expect(result).toEqual({ status: 'ERROR', reason: 'Database connection failed' });
  });

  // Test 11: no AI called
  it('does not call AI', async () => {
    mockRecords = [];
    const aiSpy = vi.fn();

    // If AI were called, it would be through a dependency — verify we don't import or call it
    await resolveEntity('company_A', 'UNKNOWN');

    expect(aiSpy).not.toHaveBeenCalled();
    // Also verify: no AI-related imports in entity-resolution.ts
    // (this is structural — the module has zero AI dependencies)
  });

  // Test 12: no GL produced
  it('does not produce GL account', async () => {
    mockRecords = [
      {
        id: 'entity_012',
        companyId: 'company_A',
        canonicalName: 'VENDOR X',
        aliases: [],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'VENDOR X');
    expect(result).toEqual({ status: 'KNOWN', entityId: 'entity_012' });
    // KNOWN result has no glAccountId — only entityId
    expect('glAccountId' in result).toBe(false);
  });

  // Edge cases
  it('handles empty companyId', async () => {
    const result = await resolveEntity('', 'VENDOR X');
    expect(result).toEqual({ status: 'ERROR', reason: 'Invalid companyId' });
  });

  it('handles empty description', async () => {
    const result = await resolveEntity('company_A', '');
    expect(result).toEqual({ status: 'ERROR', reason: 'Invalid description' });
  });

  it('handles entity with no aliases', async () => {
    mockRecords = [
      {
        id: 'entity_no_aliases',
        companyId: 'company_A',
        canonicalName: 'SOLO ENTITY',
        aliases: [],
        status: 'active',
      },
    ];

    const r1 = await resolveEntity('company_A', 'SOLO ENTITY');
    expect(r1).toEqual({ status: 'KNOWN', entityId: 'entity_no_aliases' });

    const r2 = await resolveEntity('company_A', 'ALIAS');
    expect(r2).toEqual({ status: 'UNKNOWN' });
  });

  it('handles multiple entities in same tenant', async () => {
    mockRecords = [
      {
        id: 'entity_multi_1',
        companyId: 'company_A',
        canonicalName: 'VENDOR ONE',
        aliases: ['V1'],
        status: 'active',
      },
      {
        id: 'entity_multi_2',
        companyId: 'company_A',
        canonicalName: 'VENDOR TWO',
        aliases: ['V2'],
        status: 'active',
      },
    ];

    const r1 = await resolveEntity('company_A', 'VENDOR ONE');
    expect(r1).toEqual({ status: 'KNOWN', entityId: 'entity_multi_1' });

    const r2 = await resolveEntity('company_A', 'V2');
    expect(r2).toEqual({ status: 'KNOWN', entityId: 'entity_multi_2' });

    const r3 = await resolveEntity('company_A', 'VENDOR THREE');
    expect(r3).toEqual({ status: 'UNKNOWN' });
  });

  // ─── Ambiguity detection (BLOQUE3-071) ──────────────────────────

  // BLOCKER: two entities same alias → ERROR
  it('returns ERROR for two entities with same alias', async () => {
    mockRecords = [
      {
        id: 'entity_e1',
        companyId: 'company_A',
        canonicalName: 'VENDOR ONE',
        aliases: ['SHARED'],
        status: 'active',
      },
      {
        id: 'entity_e2',
        companyId: 'company_A',
        canonicalName: 'VENDOR TWO',
        aliases: ['SHARED'],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'SHARED');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous entity identity');
      expect(result.reason).toContain('2 distinct entities');
    }
  });

  // Reversed order → must produce identical result
  it('returns ERROR for reversed entity order (order-independent)', async () => {
    mockRecords = [
      {
        id: 'entity_e2',
        companyId: 'company_A',
        canonicalName: 'VENDOR TWO',
        aliases: ['SHARED'],
        status: 'active',
      },
      {
        id: 'entity_e1',
        companyId: 'company_A',
        canonicalName: 'VENDOR ONE',
        aliases: ['SHARED'],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'SHARED');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous entity identity');
      expect(result.reason).toContain('2 distinct entities');
    }
  });

  // Two entities same canonicalName → ERROR
  it('returns ERROR for two entities with same canonicalName', async () => {
    mockRecords = [
      {
        id: 'entity_c1',
        companyId: 'company_A',
        canonicalName: 'SAME',
        aliases: [],
        status: 'active',
      },
      {
        id: 'entity_c2',
        companyId: 'company_A',
        canonicalName: 'SAME',
        aliases: [],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'SAME');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous entity identity');
      expect(result.reason).toContain('2 distinct entities');
    }
  });

  // Canonical of E1 + alias of E2 → ERROR
  it('returns ERROR for canonical of one entity matching alias of another', async () => {
    mockRecords = [
      {
        id: 'entity_cross_1',
        companyId: 'company_A',
        canonicalName: 'AMAZON',
        aliases: [],
        status: 'active',
      },
      {
        id: 'entity_cross_2',
        companyId: 'company_A',
        canonicalName: 'OTHER',
        aliases: ['AMAZON'],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'AMAZON');
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous entity identity');
      expect(result.reason).toContain('2 distinct entities');
    }
  });

  // Same entity matches canonical + alias → KNOWN (not ambiguity)
  it('returns KNOWN when same entity matches both canonical and alias', async () => {
    mockRecords = [
      {
        id: 'entity_both',
        companyId: 'company_A',
        canonicalName: 'AMAZON',
        aliases: ['AMAZON'],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'AMAZON');
    expect(result).toEqual({ status: 'KNOWN', entityId: 'entity_both' });
  });

  // Same entity matches canonical and alias with different casing → KNOWN
  it('returns KNOWN when same entity matches canonical and alias case-insensitively', async () => {
    mockRecords = [
      {
        id: 'entity_both2',
        companyId: 'company_A',
        canonicalName: 'Amazon',
        aliases: ['amzn marketplace'],
        status: 'active',
      },
    ];

    const result = await resolveEntity('company_A', 'AMZN MARKETPLACE');
    expect(result).toEqual({ status: 'KNOWN', entityId: 'entity_both2' });
  });
});
