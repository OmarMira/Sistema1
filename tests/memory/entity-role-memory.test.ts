// §GAP8-2C — Entity Role <-> Treatment Memory Bridge (unit, mock adapter)
//
// Contract under test (PASO 6/8/10):
//   - T1  human role confirmation persists a tenant-scoped claim, uppercased
//   - T3 provenance (actor/source/detectedAt) + C11 ConfidenceLog/Traceability
//   - T4 human confirmation is the only path to 'certain'; promotion happens once
//   - T5 repeated system observations never promote (stays tentative)
//   - T6 contradictory human change: prior preserved (degraded + forgotten with
//         reason), conflict evidence recorded, human authority resolves it,
//         no pending conflict remains
//   - T6b direction-compatible / mixed / custom role changes never conflict
//   - T6c system-suggested conflicts stay PENDING and never degrade a human claim
//   - T6d promotion is blocked while a pending conflict implicates the claim
//   - T7 cross-tenant isolation of claims and conflicts
//   - T9 no treatment / observation / structural side effects
//
// C11 unchanged: confidence moves only via human_confirmation |
// deterministic_conflict | human_rehabilitation; repetition never promotes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordEntityRoleKnowledge,
  getEntityRoleKnowledge,
  getPendingRoleConflicts,
  ROLE_KNOWLEDGE_TYPE,
  ROLE_CONFLICT_TYPE,
  CONFLICT_RESOLUTION_TYPE,
  OBSERVATION_TYPE,
  CONFLICTING_PATTERN_TYPE,
  STRUCTURAL_CANDIDATE_TYPE,
} from '../../src/memory/classification-knowledge';
import type {
  EntityRoleKnowledgeSource,
  RecordRoleKnowledgeInput,
} from '../../src/memory/classification-knowledge';
import { MemoryAdapter } from '../../src/memory/adapter';

// ─── Mock adapter (in-memory item store + C11 log side channels) ───

interface MockItem {
  id: string;
  content: string;
  type: string;
  companyId: string;
  status: string;
  confidence: string;
  forgetReason?: string | null;
  sourceAuthor: string;
  sourceName: string;
  sourceObservedAt: Date;
}

interface MockConfidenceLog {
  itemId: string;
  previousLevel: string;
  newLevel: string;
  reason: string;
}

interface MockTraceLog {
  itemId: string;
  action: string;
  details: Record<string, unknown>;
}

let items: MockItem[] = [];
let confidenceLogs: MockConfidenceLog[] = [];
let traceLogs: MockTraceLog[] = [];
let nextId = 1;

function createMockAdapter() {
  return {
    getByType: vi.fn(async (companyId: string, type: string) =>
      items.filter((item) => item.companyId === companyId && item.type === type),
    ),
    getById: vi.fn(async (id: string, companyId: string) =>
      items.find((item) => item.id === id && item.companyId === companyId) ?? null,
    ),
    record: vi.fn(
      async (input: {
        content: string;
        type: string;
        companyId: string;
        sourceAuthor: string;
        sourceName: string;
        sourceObservedAt?: Date;
        confidence?: string;
      }) => {
        const item: MockItem = {
          id: `mem_${nextId++}`,
          content: input.content,
          type: input.type,
          companyId: input.companyId,
          status: 'active',
          confidence: input.confidence ?? 'tentative',
          sourceAuthor: input.sourceAuthor,
          sourceName: input.sourceName,
          sourceObservedAt: input.sourceObservedAt ?? new Date(),
        };
        items.push(item);
        return { id: item.id };
      },
    ),
    updateConfidence: vi.fn(
      async (id: string, newLevel: string, reason: string, companyId: string) => {
        const item = items.find((i) => i.id === id && i.companyId === companyId);
        if (!item) throw new Error(`MemoryItem not found: ${id}`);
        const previous = item.confidence;
        item.confidence = newLevel;
        confidenceLogs.push({ itemId: id, previousLevel: previous, newLevel, reason });
        traceLogs.push({
          itemId: id,
          action: 'confidence_changed',
          details: { previousLevel: previous, newLevel, reason },
        });
        return item;
      },
    ),
    forget: vi.fn(async (id: string, reason: string, companyId: string) => {
      const item = items.find((i) => i.id === id && i.companyId === companyId);
      if (!item) throw new Error(`MemoryItem not found: ${id}`);
      item.status = 'forgotten';
      item.forgetReason = reason;
      traceLogs.push({ itemId: id, action: 'forgotten', details: { reason } });
      return item;
    }),
  };
}

type MockAdapter = ReturnType<typeof createMockAdapter>;

let mockAdapter: MockAdapter;
let adapter: MemoryAdapter;

function claimInput(
  overrides: Partial<RecordRoleKnowledgeInput> = {},
): RecordRoleKnowledgeInput {
  return {
    entityContextId: 'ctx_1',
    pattern: 'acme',
    role: 'PROVEEDOR',
    source: 'user_confirmed',
    actor: 'admin_1',
    ...overrides,
  };
}

beforeEach(() => {
  items = [];
  confidenceLogs = [];
  traceLogs = [];
  nextId = 1;
  mockAdapter = createMockAdapter();
  adapter = mockAdapter as unknown as MemoryAdapter;
});

// ─── T1: persistence + scoping ─────────────────────────────────────

describe('recordEntityRoleKnowledge — T1 persistence & scoping', () => {
  it('persists a human claim uppercased, company-scoped and queryable', async () => {
    const res = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'proveedor', roles: ['proveedor'] }),
    );
    expect(res.status).toBe('CREATED');
    expect(res.status !== 'ERROR' && res.confidence).toBe('certain');

    const claims = await getEntityRoleKnowledge(adapter, 'comp_a');
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(claim.content.companyId).toBe('comp_a');
    expect(claim.content.entityContextId).toBe('ctx_1');
    expect(claim.content.pattern).toBe('acme');
    expect(claim.content.role).toBe('PROVEEDOR');
    expect(claim.content.roles).toEqual(['PROVEEDOR']);
    expect(claim.content.source).toBe('user_confirmed');
    expect(claim.status).toBe('active');
    expect(claim.confidence).toBe('certain');

    // filters
    expect(await getEntityRoleKnowledge(adapter, 'comp_a', { pattern: 'acme' })).toHaveLength(1);
    expect(await getEntityRoleKnowledge(adapter, 'comp_a', { pattern: 'zzz' })).toHaveLength(0);
    expect(
      await getEntityRoleKnowledge(adapter, 'comp_a', { entityContextId: 'ctx_other' }),
    ).toHaveLength(0);
  });

  it('T7 — claims are invisible from another tenant', async () => {
    await recordEntityRoleKnowledge(adapter, 'comp_a', claimInput());
    expect(await getEntityRoleKnowledge(adapter, 'comp_b')).toHaveLength(0);
    expect(await getPendingRoleConflicts(adapter, 'comp_b')).toHaveLength(0);
  });

  it('rejects invalid input with ERROR (never throws)', async () => {
    const badCompany = await recordEntityRoleKnowledge(adapter, '', claimInput());
    expect(badCompany.status).toBe('ERROR');
    const badRole = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: '' }),
    );
    expect(badRole.status).toBe('ERROR');
    const badSource = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ source: 'robot' as EntityRoleKnowledgeSource }),
    );
    expect(badSource.status).toBe('ERROR');
    const badContext = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ entityContextId: '' }),
    );
    expect(badContext.status).toBe('ERROR');
  });
});

// ─── T3: provenance + C11 logs ─────────────────────────────────────

describe('recordEntityRoleKnowledge — T3 provenance & C11 logs', () => {
  it('records actor provenance, ConfidenceLog(human_confirmation) and Traceability', async () => {
    const res = await recordEntityRoleKnowledge(adapter, 'comp_a', claimInput());
    expect(res.status).toBe('CREATED');
    const claimId = res.status !== 'ERROR' ? res.claimId : '';

    const item = items.find((i) => i.id === claimId);
    expect(item?.sourceAuthor).toBe('admin_1');
    expect(item?.sourceName).toBe('user_confirmed');

    const claim = (await getEntityRoleKnowledge(adapter, 'comp_a'))[0];
    expect(claim.content.actor).toBe('admin_1');
    expect(claim.content.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // C11: exact evolution reason, tentative → certain
    expect(
      confidenceLogs.some(
        (l) =>
          l.itemId === claimId &&
          l.previousLevel === 'tentative' &&
          l.newLevel === 'certain' &&
          l.reason === 'human_confirmation',
      ),
    ).toBe(true);
    expect(
      traceLogs.some((t) => t.itemId === claimId && t.action === 'confidence_changed'),
    ).toBe(true);
  });
});

// ─── T4/T5: promotion rules ────────────────────────────────────────

describe('recordEntityRoleKnowledge — T4/T5 promotion policy', () => {
  it('T5 — system suggestions stay tentative; repetition never promotes', async () => {
    const first = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ source: 'system_suggested', actor: 'scan_bot' }),
    );
    expect(first.status).toBe('CREATED');
    expect(first.status !== 'ERROR' && first.confidence).toBe('tentative');

    const second = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ source: 'system_suggested', actor: 'scan_bot' }),
    );
    expect(second.status).toBe('UNCHANGED');

    const claims = await getEntityRoleKnowledge(adapter, 'comp_a');
    expect(claims).toHaveLength(1);
    expect(claims[0].confidence).toBe('tentative');
    expect(confidenceLogs).toHaveLength(0);
  });

  it('T4 — human confirmation promotes once (PROMOTED), then UNCHANGED', async () => {
    await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ source: 'system_suggested', actor: 'scan_bot' }),
    );
    const claimId = (await getEntityRoleKnowledge(adapter, 'comp_a'))[0].itemId;

    const promo = await recordEntityRoleKnowledge(adapter, 'comp_a', claimInput());
    expect(promo.status).toBe('PROMOTED');
    expect(promo.status !== 'ERROR' && promo.confidence).toBe('certain');

    const again = await recordEntityRoleKnowledge(adapter, 'comp_a', claimInput());
    expect(again.status).toBe('UNCHANGED');

    expect(
      confidenceLogs.filter((l) => l.itemId === claimId && l.reason === 'human_confirmation'),
    ).toHaveLength(1);
    expect((await getEntityRoleKnowledge(adapter, 'comp_a'))).toHaveLength(1);
  });
});

// ─── T6: contradictory human change (mandatory case) ───────────────

describe('recordEntityRoleKnowledge — T6 role contradiction semantics', () => {
  it('preserves prior state, records conflict evidence, resolves via human authority', async () => {
    const prior = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'PROVEEDOR' }),
    );
    expect(prior.status).toBe('CREATED');
    const priorId = prior.status !== 'ERROR' ? prior.claimId : '';

    const res = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({
        role: 'CLIENTE',
        reason: 'vendor became a customer',
      }),
    );
    expect(res.status).toBe('CREATED');
    expect(res.status !== 'ERROR' && res.conflictId).toBeTruthy();
    expect(res.status !== 'ERROR' && res.conflictResolved).toBe(true);
    expect(res.status !== 'ERROR' && res.confidence).toBe('certain');

    // PRIOR STATE PRESERVED: row intact, content untouched, superseded marker
    const priorItem = items.find((i) => i.id === priorId);
    expect(priorItem).toBeTruthy();
    expect(priorItem?.status).toBe('forgotten');
    expect(priorItem?.forgetReason).toBe('superseded_by_role_change:CLIENTE');
    const parsedPrior = JSON.parse(priorItem?.content ?? '{}');
    expect(parsedPrior.role).toBe('PROVEEDOR');
    expect(parsedPrior.actor).toBe('admin_1');

    // DEGRADATION via C11 (deterministic domain conflict)
    expect(
      confidenceLogs.some(
        (l) =>
          l.itemId === priorId &&
          l.newLevel === 'uncertain' &&
          l.reason === 'deterministic_conflict',
      ),
    ).toBe(true);

    // Conflict evidence with full prior/new pair
    const conflictItems = items.filter((i) => i.type === ROLE_CONFLICT_TYPE);
    expect(conflictItems).toHaveLength(1);
    const conflict = JSON.parse(conflictItems[0].content);
    expect(conflict.kind).toBe('ROLE_DIRECTION_CONFLICT');
    expect(conflict.companyId).toBe('comp_a');
    expect(conflict.priorClaimId).toBe(priorId);
    expect(conflict.priorRole).toBe('PROVEEDOR');
    expect(conflict.priorDirection).toBe('debit');
    expect(conflict.newRole).toBe('CLIENTE');
    expect(conflict.newDirection).toBe('credit');
    expect(conflict.actor).toBe('admin_1');
    expect(conflict.reason).toBe('vendor became a customer');

    // Resolution recorded in the SAME human confirmation
    const resolutions = items.filter((i) => i.type === CONFLICT_RESOLUTION_TYPE);
    expect(resolutions).toHaveLength(1);
    const resolution = JSON.parse(resolutions[0].content);
    expect(resolution.conflictItemId).toBe(conflictItems[0].id);
    expect(resolution.resolvedBy).toBe('admin_1');
    expect(resolution.resolutionReason).toBe('vendor became a customer');

    // Nothing pending, single active claim = new role
    expect(await getPendingRoleConflicts(adapter, 'comp_a')).toHaveLength(0);
    const active = await getEntityRoleKnowledge(adapter, 'comp_a');
    expect(active).toHaveLength(1);
    expect(active[0].content.role).toBe('CLIENTE');
    expect(active[0].confidence).toBe('certain');
  });

  it('T6b — direction-compatible, mixed and custom roles never conflict', async () => {
    // Both debit: PROVEEDOR -> EMPLEADO
    await recordEntityRoleKnowledge(adapter, 'comp_a', claimInput({ role: 'PROVEEDOR' }));
    const sameDir = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'EMPLEADO' }),
    );
    expect(sameDir.status).toBe('CREATED');
    expect(sameDir.status !== 'ERROR' && sameDir.conflictId).toBeUndefined();
    expect(items.filter((i) => i.type === ROLE_CONFLICT_TYPE)).toHaveLength(0);

    // SOCIO (mixed) from EMPLEADO (debit): mixed never conflicts
    const mixed = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'SOCIO' }),
    );
    expect(mixed.status).toBe('CREATED');
    expect(mixed.status !== 'ERROR' && mixed.conflictId).toBeUndefined();

    // Custom role (not in EXPECTED_DIRECTION) never conflicts
    const custom = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'CUALQUIER_ROL' }),
    );
    expect(custom.status).toBe('CREATED');
    expect(custom.status !== 'ERROR' && custom.conflictId).toBeUndefined();

    expect(items.filter((i) => i.type === ROLE_CONFLICT_TYPE)).toHaveLength(0);
    expect(await getPendingRoleConflicts(adapter, 'comp_a')).toHaveLength(0);
    const active = await getEntityRoleKnowledge(adapter, 'comp_a');
    expect(active).toHaveLength(1);
    expect(active[0].content.role).toBe('CUALQUIER_ROL');
  });

  it('T6c — system conflict stays pending and never degrades the human claim', async () => {
    const human = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'PROVEEDOR' }),
    );
    const humanId = human.status !== 'ERROR' ? human.claimId : '';

    const system = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'CLIENTE', source: 'system_suggested', actor: 'scan_bot' }),
    );
    expect(system.status).toBe('CREATED');
    expect(system.status !== 'ERROR' && system.conflictId).toBeTruthy();
    expect(system.status !== 'ERROR' && system.conflictResolved).toBe(false);
    expect(system.status !== 'ERROR' && system.confidence).toBe('tentative');

    // Human claim untouched: active + certain, no extra confidence logs
    const humanItem = items.find((i) => i.id === humanId);
    expect(humanItem?.status).toBe('active');
    expect(humanItem?.confidence).toBe('certain');
    expect(confidenceLogs.filter((l) => l.itemId === humanId)).toHaveLength(1);

    // Pending conflict visible (system cannot resolve)
    const pending = await getPendingRoleConflicts(adapter, 'comp_a');
    expect(pending).toHaveLength(1);
    expect(pending[0].content.newClaimId).toBe(system.status !== 'ERROR' ? system.claimId : '');

    // Human re-confirms prior role → no state damage (human-first selection)
    const re = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'PROVEEDOR' }),
    );
    expect(re.status).toBe('UNCHANGED');
    expect((await getEntityRoleKnowledge(adapter, 'comp_a'))[0].confidence).toBe('certain');
    expect(await getPendingRoleConflicts(adapter, 'comp_a')).toHaveLength(1);
  });

  it('T6d — promotion is blocked while a pending conflict implicates the claim', async () => {
    // System-created tentative claim
    const sys = await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ source: 'system_suggested', actor: 'scan_bot' }),
    );
    const claimId = sys.status !== 'ERROR' ? sys.claimId : '';

    // Manually persist a pending conflict implicating that claim
    items.push({
      id: 'conf_manual',
      content: JSON.stringify({
        companyId: 'comp_a',
        kind: 'ROLE_DIRECTION_CONFLICT',
        entityContextId: 'ctx_1',
        pattern: 'acme',
        priorClaimId: 'other_claim',
        priorRole: 'CLIENTE',
        priorDirection: 'credit',
        newClaimId: claimId,
        newRole: 'PROVEEDOR',
        newDirection: 'debit',
        source: 'system_suggested',
        detectedAt: new Date().toISOString(),
      }),
      type: ROLE_CONFLICT_TYPE,
      companyId: 'comp_a',
      status: 'active',
      sourceAuthor: 'system',
      sourceName: 'role_conflict_detection',
      sourceObservedAt: new Date(),
    });

    const promo = await recordEntityRoleKnowledge(adapter, 'comp_a', claimInput());
    expect(promo.status).toBe('UNCHANGED');
    expect(promo.status !== 'ERROR' && promo.confidence).toBe('tentative');
    expect(
      confidenceLogs.filter((l) => l.itemId === claimId && l.reason === 'human_confirmation'),
    ).toHaveLength(0);
  });
});

// ─── T9: no side effects on treatments / observations ──────────────

describe('recordEntityRoleKnowledge — T9 lifecycle isolation', () => {
  it('creates only role-knowledge items (no treatment/observation/structural writes)', async () => {
    await recordEntityRoleKnowledge(adapter, 'comp_a', claimInput({ role: 'PROVEEDOR' }));
    await recordEntityRoleKnowledge(
      adapter,
      'comp_a',
      claimInput({ role: 'CLIENTE', reason: 'transition' }),
    );

    const types = new Set(items.map((i) => i.type));
    expect(types.has('classification')).toBe(false); // treatment TYPE
    expect(types.has(OBSERVATION_TYPE)).toBe(false);
    expect(types.has(CONFLICTING_PATTERN_TYPE)).toBe(false);
    expect(types.has(STRUCTURAL_CANDIDATE_TYPE)).toBe(false);
    expect(types.has(ROLE_KNOWLEDGE_TYPE)).toBe(true);
    expect(types.has(ROLE_CONFLICT_TYPE)).toBe(true);
    expect(types.has(CONFLICT_RESOLUTION_TYPE)).toBe(true);
  });
});
