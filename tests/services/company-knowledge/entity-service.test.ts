import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// ───────────────────────────────────────────────
// Mock Prisma — no database needed
// ───────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  db: {
    pendingApproval: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    companyKnowledge: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    knowledgeAudit: {
      create: vi.fn(),
    },
  },
}));

// ───────────────────────────────────────────────
// Helpers — factory functions for mock data
// ───────────────────────────────────────────────

function makePendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pa-1',
    knowledgeId: null,
    action: 'create',
    payload: {},
    requestedBy: 'user-1',
    requestedAt: new Date('2025-01-01T00:00:00Z'),
    status: 'pending',
    ...overrides,
  };
}

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
    version: 1,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeAudit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-1',
    knowledgeId: 'ck-1',
    action: 'create',
    version: 1,
    beforeValue: null,
    afterValue: { companyId: 'company-1', type: 'person', canonicalName: 'John Doe' },
    changedByUserId: 'user-1',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    source: 'company_knowledge',
    reason: 'Entity created',
    ...overrides,
  };
}

// ───────────────────────────────────────────────
// Imports under test
// ───────────────────────────────────────────────

const entityService = await import(
  '@/internal/company-knowledge/entity/service'
);

beforeEach(() => {
  vi.clearAllMocks();
});

// ───────────────────────────────────────────────
// proposeCreate
// ───────────────────────────────────────────────

describe('proposeCreate', () => {
  const validInput = {
    companyId: 'company-1',
    type: 'person' as const,
    canonicalName: 'John Doe',
    metadata: { relationship: 'friend', notes: 'Test person' },
    requestedBy: 'user-1',
  };

  it('creates a PendingApproval with action "create" and returns it', async () => {
    const expectedPending = makePendingApproval({
      action: 'create',
      payload: {
        companyId: 'company-1',
        type: 'person',
        canonicalName: 'John Doe',
        aliases: [],
        relationship: null,
        metadata: { relationship: 'friend', notes: 'Test person' },
        source: 'company_knowledge',
      },
      requestedBy: 'user-1',
    });

    vi.mocked(db.companyKnowledge.count).mockResolvedValue(0);
    vi.mocked(db.pendingApproval.create).mockResolvedValue(expectedPending);

    const result = await entityService.proposeCreate(validInput);

    expect(db.companyKnowledge.count).toHaveBeenCalledWith({
      where: { companyId: 'company-1', status: 'active' },
    });

    expect(db.pendingApproval.create).toHaveBeenCalledWith({
      data: {
        action: 'create',
        payload: {
          companyId: 'company-1',
          type: 'person',
          canonicalName: 'John Doe',
          aliases: [],
          relationship: null,
          metadata: { relationship: 'friend', notes: 'Test person' },
          source: 'company_knowledge',
        },
        requestedBy: 'user-1',
        status: 'pending',
      },
    });

    expect(result.id).toBe('pa-1');
    expect(result.action).toBe('create');
    expect(result.status).toBe('pending');
  });

  it('includes aliases and relationship and source when provided', async () => {
    const input = {
      companyId: 'company-1',
      type: 'person' as const,
      canonicalName: 'Jane Doe',
      aliases: ['Janey', 'JD'],
      relationship: 'employee',
      metadata: {},
      source: 'llm',
      requestedBy: 'user-1',
    };

    vi.mocked(db.companyKnowledge.count).mockResolvedValue(5);
    vi.mocked(db.pendingApproval.create).mockResolvedValue(
      makePendingApproval(),
    );

    await entityService.proposeCreate(input);

    expect(db.pendingApproval.create).toHaveBeenCalledWith({
      data: {
        action: 'create',
        payload: {
          companyId: 'company-1',
          type: 'person',
          canonicalName: 'Jane Doe',
          aliases: ['Janey', 'JD'],
          relationship: 'employee',
          metadata: {},
          source: 'llm',
        },
        requestedBy: 'user-1',
        status: 'pending',
      },
    });
  });

  it('rejects metadata that does not match the entity type schema', async () => {
    // 'platform' metadata MUST NOT accept 'assetType'
    const input = {
      companyId: 'company-1',
      type: 'platform' as const,
      canonicalName: 'Some Platform',
      metadata: { assetType: 'building' }, // INVALID for platform
      requestedBy: 'user-1',
    };

    vi.mocked(db.companyKnowledge.count).mockResolvedValue(0);

    await expect(entityService.proposeCreate(input)).rejects.toThrow();
    // ZodError is thrown — no PendingApproval was created
    expect(db.pendingApproval.create).not.toHaveBeenCalled();
  });

  it('rejects when active entity count is at or above 1,000', async () => {
    vi.mocked(db.companyKnowledge.count).mockResolvedValue(1000);

    await expect(entityService.proposeCreate(validInput)).rejects.toThrow(
      'Active entity limit reached',
    );

    expect(db.pendingApproval.create).not.toHaveBeenCalled();
  });

  it('respects company isolation in the cap count query', async () => {
    vi.mocked(db.companyKnowledge.count).mockResolvedValue(999);

    await entityService.proposeCreate({
      ...validInput,
      companyId: 'company-42',
    });

    expect(db.companyKnowledge.count).toHaveBeenCalledWith({
      where: { companyId: 'company-42', status: 'active' },
    });
  });
});

// ───────────────────────────────────────────────
// confirmCreate
// ───────────────────────────────────────────────

describe('confirmCreate', () => {
  const pendingPayload = {
    companyId: 'company-1',
    type: 'company',
    canonicalName: 'Acme Corp',
    aliases: [],
    relationship: null,
    metadata: { industry: 'tech', notes: 'A tech company' },
    source: 'company_knowledge',
  };

  const pending = makePendingApproval({
    action: 'create',
    payload: pendingPayload,
  });

  it('creates CompanyKnowledge with version=1 and audit entry', async () => {
    const createdRecord = makeCompanyKnowledge({
      companyId: 'company-1',
      type: 'company',
      canonicalName: 'Acme Corp',
      metadata: { industry: 'tech', notes: 'A tech company' },
      version: 1,
    });

    vi.mocked(db.pendingApproval.findUnique).mockResolvedValue(pending);
    vi.mocked(db.companyKnowledge.create).mockResolvedValue(createdRecord);
    vi.mocked(db.knowledgeAudit.create).mockResolvedValue(makeAudit());
    vi.mocked(db.pendingApproval.delete).mockResolvedValue(pending);

    const result = await entityService.confirmCreate({
      pendingApprovalId: 'pa-1',
      confirmedByUserId: 'approver-1',
    });

    // Creates the entity with version=1
    expect(db.companyKnowledge.create).toHaveBeenCalledWith({
      data: {
        companyId: 'company-1',
        type: 'COMPANY',
        canonicalName: 'Acme Corp',
        aliases: [],
        relationship: null,
        metadata: { industry: 'tech', notes: 'A tech company' },
        source: 'company_knowledge',
        status: 'active',
        version: 1,
      },
    });

    // Appends audit entry
    expect(db.knowledgeAudit.create).toHaveBeenCalledWith({
      data: {
        knowledgeId: 'ck-1',
        action: 'create',
        version: 1,
        beforeValue: Prisma.DbNull,
        afterValue: {
          companyId: 'company-1',
          type: 'company',
          canonicalName: 'Acme Corp',
        },
        changedByUserId: 'approver-1',
        source: 'company_knowledge',
        reason: 'Entity created',
      },
    });

    // Deletes the PendingApproval
    expect(db.pendingApproval.delete).toHaveBeenCalledWith({
      where: { id: 'pa-1' },
    });

    expect(result.version).toBe(1);
    expect(result.canonicalName).toBe('Acme Corp');
  });

  it('throws if PendingApproval is not found', async () => {
    vi.mocked(db.pendingApproval.findUnique).mockResolvedValue(null);

    await expect(
      entityService.confirmCreate({
        pendingApprovalId: 'pa-missing',
        confirmedByUserId: 'approver-1',
      }),
    ).rejects.toThrow('PendingApproval pa-missing not found');
  });

  it('throws if PendingApproval is not pending', async () => {
    vi.mocked(db.pendingApproval.findUnique).mockResolvedValue(
      makePendingApproval({ status: 'approved' }),
    );

    await expect(
      entityService.confirmCreate({
        pendingApprovalId: 'pa-1',
        confirmedByUserId: 'approver-1',
      }),
    ).rejects.toThrow('PendingApproval is not in pending state');
  });

  it('throws if PendingApproval action is not "create"', async () => {
    vi.mocked(db.pendingApproval.findUnique).mockResolvedValue(
      makePendingApproval({ action: 'update' }),
    );

    await expect(
      entityService.confirmCreate({
        pendingApprovalId: 'pa-1',
        confirmedByUserId: 'approver-1',
      }),
    ).rejects.toThrow('PendingApproval action must be "create"');
  });
});

// ───────────────────────────────────────────────
// proposeUpdate
// ───────────────────────────────────────────────

describe('proposeUpdate', () => {
  const existingRecord = makeCompanyKnowledge({
    id: 'ck-1',
    canonicalName: 'Old Name',
    aliases: ['old'],
    relationship: 'owner',
    metadata: { industry: 'finance' },
    version: 3,
  });

  it('creates PendingApproval with before/after snapshots', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      existingRecord,
    );
    vi.mocked(db.pendingApproval.create).mockResolvedValue(
      makePendingApproval({ action: 'update', knowledgeId: 'ck-1' }),
    );

    const result = await entityService.proposeUpdate({
      knowledgeId: 'ck-1',
      companyId: 'company-1',
      updates: {
        canonicalName: 'New Name',
        metadata: { industry: 'tech' },
      },
      requestedBy: 'user-1',
    });

    expect(db.pendingApproval.create).toHaveBeenCalledWith({
      data: {
        action: 'update',
        knowledgeId: 'ck-1',
        payload: {
          knowledgeId: 'ck-1',
          before: {
            canonicalName: 'Old Name',
            aliases: ['old'],
            relationship: 'owner',
            metadata: { industry: 'finance' },
          },
          after: {
            canonicalName: 'New Name',
            aliases: ['old'],
            relationship: 'owner',
            metadata: { industry: 'tech' },
            version: 4,
          },
          updates: {
            canonicalName: 'New Name',
            metadata: { industry: 'tech' },
          },
        },
        requestedBy: 'user-1',
        status: 'pending',
      },
    });

    expect(result.action).toBe('update');
  });

  it('validates new metadata when provided', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      existingRecord,
    );

    // 'platform' cannot have 'assetType' in metadata
    const platformRecord = makeCompanyKnowledge({ type: 'platform' });
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      platformRecord,
    );

    await expect(
      entityService.proposeUpdate({
        knowledgeId: 'ck-1',
        companyId: 'company-1',
        updates: { metadata: { assetType: 'building' } }, // INVALID for platform
        requestedBy: 'user-1',
      }),
    ).rejects.toThrow();

    expect(db.pendingApproval.create).not.toHaveBeenCalled();
  });

  it('throws if entity belongs to different company', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      existingRecord,
    );

    await expect(
      entityService.proposeUpdate({
        knowledgeId: 'ck-1',
        companyId: 'company-other',
        updates: { canonicalName: 'New Name' },
        requestedBy: 'user-1',
      }),
    ).rejects.toThrow('Company isolation violation');
  });
});

// ───────────────────────────────────────────────
// confirmUpdate
// ───────────────────────────────────────────────

describe('confirmUpdate', () => {
  const pendingPayload = {
    knowledgeId: 'ck-1',
    before: { canonicalName: 'Old Name', aliases: [], relationship: null, metadata: {} },
    after: { canonicalName: 'New Name', aliases: [], relationship: null, metadata: {}, version: 2 },
    updates: { canonicalName: 'New Name' },
  };

  const pending = makePendingApproval({
    action: 'update',
    knowledgeId: 'ck-1',
    payload: pendingPayload,
  });

  it('updates entity, increments version, creates audit entry', async () => {
    const existingRecord = makeCompanyKnowledge({
      id: 'ck-1',
      canonicalName: 'Old Name',
      version: 1,
    });

    const updatedRecord = makeCompanyKnowledge({
      id: 'ck-1',
      canonicalName: 'New Name',
      version: 2,
    });

    vi.mocked(db.pendingApproval.findUnique).mockResolvedValue(pending);
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      existingRecord,
    );
    vi.mocked(db.companyKnowledge.update).mockResolvedValue(updatedRecord);
    vi.mocked(db.knowledgeAudit.create).mockResolvedValue(makeAudit());
    vi.mocked(db.pendingApproval.delete).mockResolvedValue(pending);

    const result = await entityService.confirmUpdate({
      pendingApprovalId: 'pa-1',
      confirmedByUserId: 'approver-1',
    });

    expect(db.companyKnowledge.update).toHaveBeenCalledWith({
      where: { id: 'ck-1' },
      data: { canonicalName: 'New Name', version: 2 },
    });

    expect(db.knowledgeAudit.create).toHaveBeenCalledWith({
      data: {
        knowledgeId: 'ck-1',
        action: 'update',
        version: 2,
        beforeValue: pendingPayload.before,
        afterValue: pendingPayload.after,
        changedByUserId: 'approver-1',
        source: 'company_knowledge',
        reason: 'Entity updated',
      },
    });

    expect(result.version).toBe(2);
    expect(result.canonicalName).toBe('New Name');
  });
});

// ───────────────────────────────────────────────
// archive
// ───────────────────────────────────────────────

describe('archive', () => {
  const activeRecord = makeCompanyKnowledge({
    id: 'ck-1',
    status: 'active',
    version: 5,
  });

  it('sets status to "archived", increments version, creates audit entry', async () => {
    const archivedRecord = makeCompanyKnowledge({
      id: 'ck-1',
      status: 'archived',
      version: 6,
    });

    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      activeRecord,
    );
    vi.mocked(db.companyKnowledge.update).mockResolvedValue(
      archivedRecord,
    );
    vi.mocked(db.knowledgeAudit.create).mockResolvedValue(makeAudit());

    const result = await entityService.archive({
      knowledgeId: 'ck-1',
      companyId: 'company-1',
      changedByUserId: 'user-1',
    });

    expect(db.companyKnowledge.update).toHaveBeenCalledWith({
      where: { id: 'ck-1' },
      data: { status: 'archived', version: 6 },
    });

    expect(db.knowledgeAudit.create).toHaveBeenCalledWith({
      data: {
        knowledgeId: 'ck-1',
        action: 'archive',
        version: 6,
        beforeValue: { status: 'active' },
        afterValue: { status: 'archived' },
        changedByUserId: 'user-1',
        source: 'company_knowledge',
        reason: 'Entity archived',
      },
    });

    expect(result.status).toBe('archived');
    expect(result.version).toBe(6);
  });

  it('throws if entity is not active', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      makeCompanyKnowledge({ status: 'archived' }),
    );

    await expect(
      entityService.archive({
        knowledgeId: 'ck-1',
        companyId: 'company-1',
        changedByUserId: 'user-1',
      }),
    ).rejects.toThrow('Cannot archive');
  });
});

// ───────────────────────────────────────────────
// restore
// ───────────────────────────────────────────────

describe('restore', () => {
  const archivedRecord = makeCompanyKnowledge({
    id: 'ck-1',
    status: 'archived',
    version: 5,
  });

  it('sets status to "active", increments version, creates audit entry', async () => {
    const restoredRecord = makeCompanyKnowledge({
      id: 'ck-1',
      status: 'active',
      version: 6,
    });

    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      archivedRecord,
    );
    vi.mocked(db.companyKnowledge.update).mockResolvedValue(
      restoredRecord,
    );
    vi.mocked(db.knowledgeAudit.create).mockResolvedValue(makeAudit());

    const result = await entityService.restore({
      knowledgeId: 'ck-1',
      companyId: 'company-1',
      changedByUserId: 'user-1',
    });

    expect(db.companyKnowledge.update).toHaveBeenCalledWith({
      where: { id: 'ck-1' },
      data: { status: 'active', version: 6 },
    });

    expect(db.knowledgeAudit.create).toHaveBeenCalledWith({
      data: {
        knowledgeId: 'ck-1',
        action: 'restore',
        version: 6,
        beforeValue: { status: 'archived' },
        afterValue: { status: 'active' },
        changedByUserId: 'user-1',
        source: 'company_knowledge',
        reason: 'Entity restored',
      },
    });

    expect(result.status).toBe('active');
    expect(result.version).toBe(6);
  });

  it('throws if entity is not archived', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockResolvedValue(
      makeCompanyKnowledge({ status: 'active' }),
    );

    await expect(
      entityService.restore({
        knowledgeId: 'ck-1',
        companyId: 'company-1',
        changedByUserId: 'user-1',
      }),
    ).rejects.toThrow('Cannot restore');
  });
});

// ───────────────────────────────────────────────
// merge
// ───────────────────────────────────────────────

describe('merge', () => {
  const sourceRecord = makeCompanyKnowledge({
    id: 'ck-source',
    canonicalName: 'Source Entity',
    status: 'active',
    version: 3,
  });

  const targetRecord = makeCompanyKnowledge({
    id: 'ck-target',
    canonicalName: 'Target Entity',
    status: 'active',
    version: 5,
  });

  it('merges source into target with field resolutions', async () => {
    const updatedTarget = makeCompanyKnowledge({
      id: 'ck-target',
      canonicalName: 'Resolved Name',
      status: 'active',
      version: 6,
    });

    vi.mocked(db.companyKnowledge.findUnique).mockImplementation(
      async (args: { where: { id: string } }) => {
        if (args.where.id === 'ck-source') return sourceRecord;
        if (args.where.id === 'ck-target') return targetRecord;
        return null;
      },
    );

    vi.mocked(db.companyKnowledge.update).mockImplementation(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        if (args.where.id === 'ck-target') return updatedTarget;
        if (args.where.id === 'ck-source')
          return { ...sourceRecord, status: 'merged', mergedIntoId: 'ck-target', version: 4 };
        return null;
      },
    );

    vi.mocked(db.knowledgeAudit.create).mockResolvedValue(makeAudit());

    const result = await entityService.merge({
      sourceKnowledgeId: 'ck-source',
      targetKnowledgeId: 'ck-target',
      companyId: 'company-1',
      fieldResolutions: { canonicalName: 'Resolved Name' },
      changedByUserId: 'user-1',
      reason: 'Duplicate found',
    });

    // Source gets merged
    expect(db.companyKnowledge.update).toHaveBeenCalledWith({
      where: { id: 'ck-source' },
      data: {
        status: 'merged',
        mergedIntoId: 'ck-target',
        version: 4,
      },
    });

    // Target gets resolved fields + version bump
    expect(db.companyKnowledge.update).toHaveBeenCalledWith({
      where: { id: 'ck-target' },
      data: {
        canonicalName: 'Resolved Name',
        version: 6,
      },
    });

    // Audit entries for both
    expect(db.knowledgeAudit.create).toHaveBeenCalledTimes(2);

    // Returns the updated target
    expect(result.id).toBe('ck-target');
  });

  it('throws if source or target is not active', async () => {
    vi.mocked(db.companyKnowledge.findUnique).mockImplementation(
      async (args: { where: { id: string } }) => {
        if (args.where.id === 'ck-source')
          return { ...sourceRecord, status: 'merged' };
        if (args.where.id === 'ck-target') return targetRecord;
        return null;
      },
    );

    await expect(
      entityService.merge({
        sourceKnowledgeId: 'ck-source',
        targetKnowledgeId: 'ck-target',
        companyId: 'company-1',
        fieldResolutions: {},
        changedByUserId: 'user-1',
      }),
    ).rejects.toThrow('Cannot merge');
  });
});
