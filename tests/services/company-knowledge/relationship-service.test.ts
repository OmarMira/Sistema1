import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/db';
import { RelationshipValues } from '@/internal/company-knowledge/relationship/types';

// ───────────────────────────────────────────────
// Mock Prisma — no database needed
// ───────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  db: {
    companyKnowledge: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    knowledgeAudit: {
      create: vi.fn(),
    },
  },
}));

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

function makeCompanyKnowledge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ck-1',
    companyId: 'company-1',
    type: 'person',
    canonicalName: 'John Doe',
    aliases: [],
    relationship: null,
    metadata: {},
    source: 'company_knowledge',
    status: 'active',
    mergedIntoId: null,
    version: 3,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeAudit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-1',
    knowledgeId: 'ck-1',
    action: 'update',
    version: 4,
    beforeValue: null,
    afterValue: null,
    changedByUserId: 'user-1',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    source: 'company_knowledge',
    reason: 'Relationship updated via user_confirmed',
    ...overrides,
  };
}

// ───────────────────────────────────────────────
// Imports under test
// ───────────────────────────────────────────────

const relationshipService = await import(
  '@/internal/company-knowledge/relationship/service'
);

beforeEach(() => {
  vi.clearAllMocks();
});

// ───────────────────────────────────────────────
// Relationship values validation
// ───────────────────────────────────────────────

describe('RelationshipValues', () => {
  it('has exactly 9 approved values', () => {
    expect(RelationshipValues).toHaveLength(9);
  });

  it('includes all expected relationship types', () => {
    const expected = [
      'owner',
      'employee',
      'vendor',
      'customer',
      'tenant',
      'lender',
      'credit_card_provider',
      'related_company',
      'income_platform',
    ];

    for (const value of expected) {
      expect(RelationshipValues).toContain(value);
    }
  });
});

// ───────────────────────────────────────────────
// updateRelationship
// ───────────────────────────────────────────────

describe('updateRelationship', () => {
  const existingRecord = makeCompanyKnowledge({
    id: 'ck-1',
    companyId: 'company-1',
    relationship: null,
    source: 'company_knowledge',
    version: 3,
  });

  const baseInput = {
    knowledgeId: 'ck-1',
    companyId: 'company-1',
    relationship: 'employee',
    resolvedBy: 'user_confirmed' as const,
    changedByUserId: 'user-1',
    reason: 'User confirmed employment relationship',
  };

  it('accepts all 9 valid relationship values', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      existingRecord,
    );

    for (const value of RelationshipValues) {
      const updatedRecord = makeCompanyKnowledge({
        relationship: value,
        version: 4,
      });

      vi.mocked(db.companyKnowledge.update).mockResolvedValue(
        updatedRecord,
      );
      vi.mocked(db.knowledgeAudit.create).mockResolvedValue(makeAudit());

      const result = await relationshipService.updateRelationship({
        ...baseInput,
        relationship: value,
      });

      expect(result.relationship).toBe(value);
    }

    // Called 9 times
    expect(db.companyKnowledge.update).toHaveBeenCalledTimes(9);
  });

  it('rejects an invalid relationship value', async () => {
    await expect(
      relationshipService.updateRelationship({
        ...baseInput,
        relationship: 'invalid_value',
      }),
    ).rejects.toThrow();

    // No DB calls were made (validation happens first)
    expect(db.companyKnowledge.findUnique).not.toHaveBeenCalled();
    expect(db.companyKnowledge.update).not.toHaveBeenCalled();
  });

  it('updates the relationship, source, and increments version', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      existingRecord,
    );

    const updatedRecord = makeCompanyKnowledge({
      relationship: 'employee',
      source: 'company_knowledge',
      version: 4,
    });

    vi.mocked(db.companyKnowledge.update).mockResolvedValue(
      updatedRecord,
    );
    vi.mocked(db.knowledgeAudit.create).mockResolvedValue(makeAudit());

    const result = await relationshipService.updateRelationship(baseInput);

    // Verifies company isolation
    expect(db.companyKnowledge.findUnique).toHaveBeenCalledWith({
      where: { id: 'ck-1' },
    });

    // Updates the record
    expect(db.companyKnowledge.update).toHaveBeenCalledWith({
      where: { id: 'ck-1' },
      data: {
        relationship: 'employee',
        source: 'company_knowledge',
        version: 4,
      },
    });

    // Creates audit entry
    expect(db.knowledgeAudit.create).toHaveBeenCalledWith({
      data: {
        knowledgeId: 'ck-1',
        action: 'update',
        version: 4,
        beforeValue: {
          relationship: null,
          source: 'company_knowledge',
        },
        afterValue: {
          relationship: 'employee',
          source: 'company_knowledge',
        },
        changedByUserId: 'user-1',
        source: 'company_knowledge',
        reason: 'User confirmed employment relationship',
      },
    });

    expect(result.version).toBe(4);
    expect(result.relationship).toBe('employee');
  });

  it('throws if the entity does not exist', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(null);

    await expect(
      relationshipService.updateRelationship(baseInput),
    ).rejects.toThrow('CompanyKnowledge ck-1 not found');

    expect(db.companyKnowledge.update).not.toHaveBeenCalled();
  });

  it('throws on company isolation violation', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      makeCompanyKnowledge({ companyId: 'company-other' }),
    );

    await expect(
      relationshipService.updateRelationship(baseInput),
    ).rejects.toThrow('Company isolation violation');

    expect(db.companyKnowledge.update).not.toHaveBeenCalled();
  });

  // ─── Source tracking per resolvedBy ───

  describe('source tracking', () => {
    const testCases: Array<{
      resolvedBy: 'user_confirmed' | 'correction' | 'system_suggested';
      expectedSource: string;
    }> = [
      { resolvedBy: 'user_confirmed', expectedSource: 'company_knowledge' },
      { resolvedBy: 'correction', expectedSource: 'company_knowledge' },
      { resolvedBy: 'system_suggested', expectedSource: 'llm' },
    ];

    for (const { resolvedBy, expectedSource } of testCases) {
      it(`maps resolvedBy="${resolvedBy}" to source="${expectedSource}"`, async () => {
        vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
          existingRecord,
        );

        const updatedRecord = makeCompanyKnowledge({
          relationship: 'vendor',
          source: expectedSource,
          version: 4,
        });

        vi.mocked(db.companyKnowledge.update).mockResolvedValue(
          updatedRecord,
        );
        vi.mocked(db.knowledgeAudit.create).mockResolvedValue(makeAudit());

        await relationshipService.updateRelationship({
          ...baseInput,
          relationship: 'vendor',
          resolvedBy,
        });

        expect(db.companyKnowledge.update).toHaveBeenCalledWith({
          where: { id: 'ck-1' },
          data: {
            relationship: 'vendor',
            source: expectedSource,
            version: 4,
          },
        });
      });
    }
  });
});
