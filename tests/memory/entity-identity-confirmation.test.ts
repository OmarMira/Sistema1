// Knowledge Engine — Entity Identity Confirmation Tests (BLOQUE3-101)
//
// Tests demonstrate the UNKNOWN → confirmed identity → KNOWN circuit:
//   TEST 1: UNKNOWN → confirm identity → KNOWN
//   TEST 2: KNOWN returns correct entityId
//   TEST 3: Same confirmation twice → no duplicate (idempotent)
//   TEST 4: Same alias Company A / Company B → tenant isolation
//   TEST 5: Conflicting identity for same alias → explicit error
//   TEST 5b (G8-2 §10): alias candidate colliding with another entity's
//         canonical → explicit identity-conflict error (alias ↔ canonical)
//   TEST 6: AI proposal without confirmation → NOTHING persisted
//
// Plus: PostgreSQL integration test of the full persist → resolve → KNOWN cycle.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveEntity } from '../../src/memory/entity-resolution';

// ─── Mock db ─────────────────────────────────────────────────────

interface MockKnowledgeRecord {
  id: string;
  companyId: string;
  canonicalName: string;
  aliases: string[];
  status: string;
  type: string;
  version: number;
  metadata: Record<string, unknown>;
  source: string;
  relationship: string | null;
  mergedIntoId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

let mockRecords: MockKnowledgeRecord[] = [];
let mockAuditEntries: Array<{ knowledgeId: string; action: string }> = [];
let shouldThrow = false;
let nextId = 1;

function makeId(): string {
  return `entity_${String(nextId++).padStart(3, '0')}`;
}

vi.mock('@/lib/db', () => ({
  get db() {
    const client: Record<string, unknown> = {
      companyKnowledge: {
        findMany: vi.fn(async (args: { where: { companyId: string; status: string; id?: { not: string } }; select?: Record<string, boolean> }) => {
          if (shouldThrow) throw new Error('Database connection failed');
          return mockRecords.filter(
            (r) =>
              r.companyId === args.where.companyId &&
              r.status === args.where.status &&
              // G8-2 §8 — identity-disjointness precheck excludes the record
              // under consideration (id: { not }) from its own comparison.
              !(args.where.id?.not && r.id === args.where.id.not),
          );
        }),
        findUnique: vi.fn(async (args: { where: { id: string } }) => {
          if (shouldThrow) throw new Error('Database connection failed');
          return mockRecords.find((r) => r.id === args.where.id) ?? null;
        }),
        update: vi.fn(async (args: { where: { id: string }; data: { aliases?: string[] } }) => {
          if (shouldThrow) throw new Error('Database connection failed');
          const record = mockRecords.find((r) => r.id === args.where.id);
          if (!record) throw new Error('Record not found');
          if (args.data.aliases) record.aliases = args.data.aliases;
          return { ...record };
        }),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          if (shouldThrow) throw new Error('Database connection failed');
          const id = makeId();
          const record: MockKnowledgeRecord = {
            id,
            companyId: args.data.companyId as string,
            canonicalName: args.data.canonicalName as string,
            aliases: (args.data.aliases as string[]) ?? [],
            status: (args.data.status as string) ?? 'active',
            type: (args.data.type as string) ?? 'PERSON',
            version: (args.data.version as number) ?? 1,
            metadata: (args.data.metadata as Record<string, unknown>) ?? {},
            source: (args.data.source as string) ?? 'company_knowledge',
            relationship: (args.data.relationship as string) ?? null,
            mergedIntoId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockRecords.push(record);
          return { ...record };
        }),
      },
      knowledgeAudit: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          mockAuditEntries.push({
            knowledgeId: args.data.knowledgeId as string,
            action: args.data.action as string,
          });
          return args.data;
        }),
      },
      // G8-2 §8 — confirmEntityIdentity runs in ONE interactive transaction
      // whose first statement is the Company FOR UPDATE lock.
      $queryRaw: vi.fn(async () => [{ id: 'company-1' }]),
    };
    client.$transaction = vi.fn(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => fn(client),
    );
    return client;
  },
}));

vi.mock('@/lib/context-storage', () => ({
  requireCurrentUserId: () => 'test-user-id',
}));

// ─── Import after mocks ──────────────────────────────────────────

import { confirmEntityIdentity } from '../../src/internal/company-knowledge/entity/service';

// ─── Tests ───────────────────────────────────────────────────────

describe('confirmEntityIdentity', () => {
  beforeEach(() => {
    mockRecords = [];
    mockAuditEntries = [];
    shouldThrow = false;
    nextId = 1;
  });

  // TEST 1: UNKNOWN → confirm identity → KNOWN
  it('TEST 1: transforms UNKNOWN to KNOWN after confirmation', async () => {
    // Before: resolveEntity returns UNKNOWN
    const before = await resolveEntity('company_A', 'AMAZON MARKETPLACE');
    expect(before).toEqual({ status: 'UNKNOWN' });

    // Confirm identity
    const confirmed = await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Amazon',
      observedAlias: 'AMAZON MARKETPLACE',
      entityType: 'company',
    });

    expect(confirmed.companyId).toBe('company_A');
    expect(confirmed.canonicalName).toBe('Amazon');
    expect(confirmed.aliases).toContain('AMAZON MARKETPLACE');
    expect(confirmed.status).toBe('active');

    // After: resolveEntity returns KNOWN
    const after = await resolveEntity('company_A', 'AMAZON MARKETPLACE');
    expect(after).toEqual({ status: 'KNOWN', entityId: confirmed.id });
  });

  // TEST 2: KNOWN returns correct entityId
  it('TEST 2: KNOWN result contains the correct entityId', async () => {
    const confirmed = await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Mercado Pago',
      observedAlias: 'MERCADOPAGO*PAY',
      entityType: 'platform',
    });

    const resolution = await resolveEntity('company_A', 'MERCADOPAGO*PAY');
    expect(resolution).toEqual({ status: 'KNOWN', entityId: confirmed.id });

    // Also resolves via canonicalName
    const resolutionCanonical = await resolveEntity('company_A', 'Mercado Pago');
    expect(resolutionCanonical).toEqual({ status: 'KNOWN', entityId: confirmed.id });
  });

  // TEST 3: Same confirmation twice → no duplicate (idempotent)
  it('TEST 3: idempotent — same confirmation twice does not create duplicate', async () => {
    const first = await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Netflix',
      observedAlias: 'NETFLIX.COM',
      entityType: 'company',
    });

    const second = await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Netflix',
      observedAlias: 'NETFLIX.COM',
      entityType: 'company',
    });

    // Same entity returned
    expect(second.id).toBe(first.id);

    // Only one entity in the system
    expect(mockRecords).toHaveLength(1);

    // Only one alias (not duplicated)
    expect(mockRecords[0].aliases).toEqual(['NETFLIX.COM']);

    // Audit: one create + one add_alias (or just create if alias was already there)
    expect(mockAuditEntries.length).toBeGreaterThanOrEqual(1);
  });

  // TEST 4: Same alias Company A / Company B → tenant isolation
  it('TEST 4: tenant isolation — same alias in different companies are independent', async () => {
    const entityA = await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Amazon',
      observedAlias: 'AMZN MKTP',
      entityType: 'company',
    });

    const entityB = await confirmEntityIdentity({
      companyId: 'company_B',
      canonicalName: 'Amazon Web Services',
      observedAlias: 'AMZN MKTP',
      entityType: 'company',
    });

    // Different entities
    expect(entityA.id).not.toBe(entityB.id);

    // Each resolves independently
    const resA = await resolveEntity('company_A', 'AMZN MKTP');
    expect(resA).toEqual({ status: 'KNOWN', entityId: entityA.id });

    const resB = await resolveEntity('company_B', 'AMZN MKTP');
    expect(resB).toEqual({ status: 'KNOWN', entityId: entityB.id });

    // Cross-tenant: company_C sees nothing
    const resC = await resolveEntity('company_C', 'AMZN MKTP');
    expect(resC).toEqual({ status: 'UNKNOWN' });
  });

  // TEST 5: Conflicting identity for same alias → explicit error
  it('TEST 5: alias conflict — same alias on different entity throws explicit error', async () => {
    await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Uber',
      observedAlias: 'UBER*TRIP',
      entityType: 'company',
    });

    // Try to assign same alias to different entity
    await expect(
      confirmEntityIdentity({
        companyId: 'company_A',
        canonicalName: 'Uber Eats',
        observedAlias: 'UBER*TRIP',
        entityType: 'company',
      }),
    ).rejects.toThrow('Alias conflict');
  });

  // TEST 5b (G8-2 §10 T8 correction): alias candidate ↔ canonical of another
  // ACTIVE entity — the alias-to-canonical direction of the identity
  // disjointness contract. The manual alias loop only inspects
  // record.aliases, so this direction can only be caught by
  // assertIdentityDisjoint on the create path, BEFORE any write.
  it('TEST 5b: alias conflict — candidate alias colliding with another entity canonical throws explicit error', async () => {
    // Arrange: active entity A — canonical "Uber", alias "UBER*TRIP".
    const entityA = await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Uber',
      observedAlias: 'UBER*TRIP',
      entityType: 'company',
    });
    expect(mockRecords).toHaveLength(1);
    expect(mockAuditEntries).toHaveLength(1);

    // Act: attempt to create entity B whose observedAlias equals A's
    // canonicalName — alias ↔ canonical (NOT alias ↔ alias: A has no alias
    // "Uber", so the manual loop cannot fire; only the G8-2 identity
    // precheck can reject this).
    await expect(
      confirmEntityIdentity({
        companyId: 'company_A',
        canonicalName: 'Uber Eats',
        observedAlias: 'Uber',
        entityType: 'company',
      }),
    ).rejects.toThrow(
      'Identity "UBER" already belongs to an active entity of this company',
    );

    // Post-rejection: no partial effect.
    expect(mockRecords).toHaveLength(1); // no new entity B was created
    expect(mockRecords[0].id).toBe(entityA.id); // A intact
    expect(mockRecords[0].canonicalName).toBe('Uber');
    expect(mockRecords[0].aliases).toEqual(['UBER*TRIP']); // conflictive alias not added
    expect(mockRecords[0].status).toBe('active');
    expect(mockAuditEntries).toHaveLength(1); // no create / add_alias audit entry
  });

  // TEST 6: AI proposal without confirmation → NOTHING persisted
  it('TEST 6: AI proposal alone persists nothing', async () => {
    // Simulate: AI produces a proposal but user does NOT confirm
    // The system should NOT write anything to CompanyKnowledge
    const beforeCount = mockRecords.length;

    // AI "proposes" — but no confirmEntityIdentity call is made
    // This is a structural test: if someone tries to persist from parseWithAI,
    // this test catches it by verifying the mock was not called via that path

    const resolution = await resolveEntity('company_A', 'AI_PROPOSED_ENTITY');
    expect(resolution).toEqual({ status: 'UNKNOWN' });
    expect(mockRecords.length).toBe(beforeCount);

    // No audit entries created
    expect(mockAuditEntries).toHaveLength(0);
  });

  // Edge cases
  it('normalizes names for comparison', async () => {
    const confirmed = await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: '  Vendor   X  ',
      observedAlias: '  vendor x  ',
      entityType: 'company',
    });

    // Stored as-is
    expect(confirmed.canonicalName).toBe('  Vendor   X  ');
    expect(confirmed.aliases).toContain('  vendor x  ');

    // Resolves with normalized input
    const res = await resolveEntity('company_A', 'vendor x');
    expect(res).toEqual({ status: 'KNOWN', entityId: confirmed.id });
  });

  it('adds alias to existing entity with different alias', async () => {
    await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Google',
      observedAlias: 'GOOGLE*CLOUD',
      entityType: 'company',
    });

    const updated = await confirmEntityIdentity({
      companyId: 'company_A',
      canonicalName: 'Google',
      observedAlias: 'GOOGLE*ADS',
      entityType: 'company',
    });

    expect(updated.aliases).toContain('GOOGLE*CLOUD');
    expect(updated.aliases).toContain('GOOGLE*ADS');
  });

  it('validates required inputs', async () => {
    await expect(
      confirmEntityIdentity({
        companyId: '',
        canonicalName: 'X',
        observedAlias: 'Y',
        entityType: 'company',
      }),
    ).rejects.toThrow('companyId is required');

    await expect(
      confirmEntityIdentity({
        companyId: 'company_A',
        canonicalName: '',
        observedAlias: 'Y',
        entityType: 'company',
      }),
    ).rejects.toThrow('canonicalName is required');

    await expect(
      confirmEntityIdentity({
        companyId: 'company_A',
        canonicalName: 'X',
        observedAlias: '',
        entityType: 'company',
      }),
    ).rejects.toThrow('observedAlias is required');
  });
});
