import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveDecisionReason } from '@/internal/company-knowledge/entity/types';
import { db } from '@/lib/db';

vi.mock('@/lib/db', () => ({
  db: {
    knowledgeAudit: { findMany: vi.fn() },
    companyKnowledge: { findUnique: vi.fn() },
  },
}));

function makeAudit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-1', knowledgeId: 'ck-1', action: 'create', version: 1,
    beforeValue: null, afterValue: {}, changedByUserId: 'user-1',
    timestamp: new Date('2025-01-01T00:00:00Z'), source: 'company_knowledge', reason: 'Entity created', ...overrides,
  };
}

function makeCK(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ck-1', companyId: 'company-1', type: 'person', canonicalName: 'John Doe',
    aliases: [], relationship: 'owner', metadata: {}, source: 'company_knowledge',
    status: 'active', mergedIntoId: null, version: 3, ...overrides,
  };
}

describe('getAuditTrail', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns entries ordered by timestamp', async () => {
    const entries = [makeAudit({ timestamp: new Date('2025-01-02') }), makeAudit({ timestamp: new Date('2025-01-01') })];
    vi.mocked(db.knowledgeAudit.findMany).mockResolvedValue(entries);
    const result = await import('@/internal/company-knowledge/audit/service').then(m => m.getAuditTrail('ck-1'));
    expect(db.knowledgeAudit.findMany).toHaveBeenCalledWith({ where: { knowledgeId: 'ck-1' }, orderBy: { timestamp: 'asc' } });
  });

  it('returns empty array when no entries exist', async () => {
    vi.mocked(db.knowledgeAudit.findMany).mockResolvedValue([]);
    const result = await import('@/internal/company-knowledge/audit/service').then(m => m.getAuditTrail('ck-1'));
    expect(result).toEqual([]);
  });
});

describe('getExplainabilityPayload', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns payload with correct fields', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(makeCK());
    const result = await import('@/internal/company-knowledge/audit/service').then(m => m.getExplainabilityPayload('ck-1'));
    expect(result).toMatchObject({ source: 'company_knowledge', knowledgeId: 'ck-1', canonicalName: 'John Doe', version: 3 });
  });

  it('returns null for unknown knowledgeId', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(null);
    const result = await import('@/internal/company-knowledge/audit/service').then(m => m.getExplainabilityPayload('ck-unknown'));
    expect(result).toBeNull();
  });

  it('derives decisionReason from source dynamically', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(makeCK({ source: 'llm' }));
    const result = await import('@/internal/company-knowledge/audit/service').then(m => m.getExplainabilityPayload('ck-1'));
    expect(result?.decisionReason).toBe('llm_suggestion');
    expect(resolveDecisionReason('llm')).toBe('llm_suggestion');
  });

  it('derives decisionReason from company_knowledge source', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(makeCK({ source: 'company_knowledge' }));
    const result = await import('@/internal/company-knowledge/audit/service').then(m => m.getExplainabilityPayload('ck-1'));
    expect(result?.decisionReason).toBe('company_knowledge_confirmed');
  });

  it('falls back to fallback_default for unknown source', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(makeCK({ source: 'unknown_source' }));
    const result = await import('@/internal/company-knowledge/audit/service').then(m => m.getExplainabilityPayload('ck-1'));
    expect(result?.decisionReason).toBe('fallback_default');
  });
});
