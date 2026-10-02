// §GAP8-2C — MINIMAL_ROLE_MEMORY_BRIDGE integration (real test DB).
//
// Proves the PASO 8 authority split end-to-end:
//   - B1  updateEntityContext writes BOTH projection (EntityContext) and
//         memory claim (source correction, actor provenance, C11 certain)
//   - B1b same-role re-confirmation is idempotent (single claim, no dupes)
//   - B2  a contradictory role change through the bridge records conflict
//         evidence + human resolution, prior claim preserved (forgotten row)
//   - B3  classifyEntity (human flow) writes a user_confirmed claim
//   - B4  classifyEntity with source 'ai' stays tentative (no C11 promotion)
//   - B5  role memory feeds FUTURE enrichment after the projection is
//         deleted (T2 reuse): hasContext=false, contextRole from memory,
//         direction validation active
//   - B6  memory record alone never creates an EntityContext row (no
//         reverse pollution of the projection)
//   - B7  cross-tenant isolation on real tables

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearDatabase,
  createTestCompany,
  createTestUser,
} from '../helpers/factories';
import { saveContext } from '@/lib/services/entity-context-service';
import {
  updateEntityContext,
  removeEntityContext,
} from '@/lib/services/entity-context-crud-service';
import { classifyEntity } from '@/lib/services/entity-classifier';
import { enrichCandidates } from '@/lib/services/entity-enricher';
import type { EntityCandidate } from '@/lib/services/entity-detector';
import {
  createAdapter,
  getEntityRoleKnowledge,
  getPendingRoleConflicts,
  recordEntityRoleKnowledge,
} from '@/memory/classification-knowledge';
import { db } from '@/lib/db';

let companyId: string;
let otherCompanyId: string;
let adapter: ReturnType<typeof createAdapter>;

beforeEach(async () => {
  await clearDatabase();
  companyId = (await createTestCompany('Role Bridge Co')).id;
  otherCompanyId = (await createTestCompany('Other Role Bridge Co')).id;
  adapter = createAdapter(db, (fn) => db.$transaction(fn));
});

describe('B1/B1b — updateEntityContext bridge', () => {
  it('writes BOTH projection and memory claim with provenance (correction)', async () => {
    await saveContext({ companyId, pattern: 'UBER', role: 'GASTO_OPERATIVO' });
    const ctx = await db.entityContext.findFirst({ where: { companyId, pattern: 'uber' } });
    expect(ctx).not.toBeNull();

    const updated = await updateEntityContext(
      companyId,
      ctx!.id,
      { role: 'CLIENTE' },
      'admin-1',
    );
    expect(updated).not.toBeNull();
    expect(updated!.role).toBe('CLIENTE');

    // Projection (operational reader surface) is intact and updated
    const row = await db.entityContext.findFirst({ where: { id: ctx!.id } });
    expect(row?.role).toBe('CLIENTE');

    // Memory claim written by the bridge
    const claims = await getEntityRoleKnowledge(adapter, companyId, {
      entityContextId: ctx!.id,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].content.role).toBe('CLIENTE');
    expect(claims[0].content.source).toBe('correction');
    expect(claims[0].content.actor).toBe('admin-1');
    expect(claims[0].content.reason).toBe('role change: GASTO_OPERATIVO -> CLIENTE');
    expect(claims[0].confidence).toBe('certain');
    expect(claims[0].status).toBe('active');

    // No prior claim existed (saveContext is projection-only) → no conflict
    expect(
      await db.memoryItem.count({ where: { companyId, type: 'entity_role_conflict' } }),
    ).toBe(0);
  });

  it('B1b — same-role re-confirmation stays idempotent (single claim)', async () => {
    await saveContext({ companyId, pattern: 'UBER', role: 'CLIENTE' });
    const ctx = await db.entityContext.findFirst({ where: { companyId, pattern: 'uber' } });

    await updateEntityContext(companyId, ctx!.id, { role: 'CLIENTE' }, 'admin-1');
    await updateEntityContext(companyId, ctx!.id, { role: 'CLIENTE' }, 'admin-2');

    const claims = await getEntityRoleKnowledge(adapter, companyId, {
      entityContextId: ctx!.id,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].content.role).toBe('CLIENTE');
    expect(claims[0].confidence).toBe('certain');
  });
});

describe('B2 — contradictory role change through the bridge', () => {
  it('records conflict + human resolution, prior claim preserved', async () => {
    await saveContext({ companyId, pattern: 'ACME', role: 'PROVEEDOR' });
    const ctx = await db.entityContext.findFirst({ where: { companyId, pattern: 'acme' } });

    // First human confirmation creates the prior claim
    await updateEntityContext(companyId, ctx!.id, { role: 'PROVEEDOR' }, 'admin-1');
    const priorClaims = await getEntityRoleKnowledge(adapter, companyId, {
      entityContextId: ctx!.id,
    });
    expect(priorClaims).toHaveLength(1);
    const priorClaimId = priorClaims[0].itemId;

    // Contradictory transition: PROVEEDOR (debit) → CLIENTE (credit)
    await updateEntityContext(companyId, ctx!.id, { role: 'CLIENTE' }, 'admin-1');

    // Conflict evidence + resolution persisted
    const conflicts = await db.memoryItem.findMany({
      where: { companyId, type: 'entity_role_conflict' },
    });
    expect(conflicts).toHaveLength(1);
    const conflict = JSON.parse(conflicts[0].content);
    expect(conflict.kind).toBe('ROLE_DIRECTION_CONFLICT');
    expect(conflict.priorClaimId).toBe(priorClaimId);
    expect(conflict.priorRole).toBe('PROVEEDOR');
    expect(conflict.newRole).toBe('CLIENTE');

    const resolutions = await db.memoryItem.findMany({
      where: { companyId, type: 'classification_conflict_resolution' },
    });
    expect(resolutions).toHaveLength(1);
    expect(JSON.parse(resolutions[0].content).conflictItemId).toBe(conflicts[0].id);
    expect(JSON.parse(resolutions[0].content).resolvedBy).toBe('admin-1');

    expect(await getPendingRoleConflicts(adapter, companyId)).toHaveLength(0);

    // Prior preserved: forgotten row with intact content + degrade log
    const priorItem = await db.memoryItem.findUnique({ where: { id: priorClaimId } });
    expect(priorItem?.status).toBe('forgotten');
    expect(priorItem?.forgetReason).toBe('superseded_by_role_change:CLIENTE');
    expect(JSON.parse(priorItem!.content).role).toBe('PROVEEDOR');

    const degradeLogs = await db.confidenceLog.findMany({
      where: { itemId: priorClaimId, newLevel: 'uncertain', reason: 'deterministic_conflict' },
    });
    expect(degradeLogs).toHaveLength(1);

    // Exactly one active claim: the new role
    const active = await getEntityRoleKnowledge(adapter, companyId, {
      entityContextId: ctx!.id,
    });
    expect(active).toHaveLength(1);
    expect(active[0].content.role).toBe('CLIENTE');
  });
});

describe('B3/B4 — classifyEntity bridge', () => {
  it('B3 — human classify flow writes a certain user_confirmed claim', async () => {
    const user = await createTestUser('role-bridge@example.com');

    const result = await classifyEntity({
      companyId,
      pattern: 'GLOBEL TELCO',
      role: 'PROVEEDOR',
      source: 'user',
      userId: user.id,
    });
    expect(result.context.role).toBe('PROVEEDOR');

    const claims = await getEntityRoleKnowledge(adapter, companyId, {
      entityContextId: result.context.id,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].content.role).toBe('PROVEEDOR');
    expect(claims[0].content.source).toBe('user_confirmed');
    expect(claims[0].content.actor).toBe(user.id);
    expect(claims[0].content.pattern).toBe(result.context.pattern);
    expect(claims[0].confidence).toBe('certain');
  });

  it('B4 — source "ai" stays tentative (system suggestion never promoted)', async () => {
    const result = await classifyEntity({
      companyId,
      pattern: 'AUTO VENDOR',
      role: 'GASTO_OPERATIVO',
      source: 'ai',
    });

    const claims = await getEntityRoleKnowledge(adapter, companyId, {
      entityContextId: result.context.id,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].content.source).toBe('system_suggested');
    expect(claims[0].confidence).toBe('tentative');

    const logs = await db.confidenceLog.findMany({ where: { itemId: claims[0].itemId } });
    expect(logs).toHaveLength(0);
  });
});

describe('B5 — role memory reuse in future flows (PASO 9)', () => {
  it('feeds enrichment after the EntityContext projection is deleted', async () => {
    await saveContext({ companyId, pattern: 'GLOBEL TELCO', role: 'PROVEEDOR' });
    const ctx = await db.entityContext.findFirst({ where: { companyId } });
    expect(ctx).not.toBeNull();

    // Human confirmation → memory claim (certain, human_confirmed)
    await updateEntityContext(companyId, ctx!.id, { role: 'PROVEEDOR' }, 'admin-1');
    const claims = await getEntityRoleKnowledge(adapter, companyId, {
      entityContextId: ctx!.id,
    });
    expect(claims).toHaveLength(1);

    // Projection deleted; memory claim survives as history/reuse source
    await removeEntityContext(companyId, ctx!.id);
    expect(await db.entityContext.findFirst({ where: { companyId } })).toBeNull();
    const afterDelete = await getEntityRoleKnowledge(adapter, companyId);
    expect(afterDelete).toHaveLength(1);

    // Future flow: enrichCandidates reuses the role from memory
    const candidate: EntityCandidate = {
      id: 'cand_1',
      canonicalName: 'GLOBEL TELCO',
      occurrences: 4,
      directionProfile: { creditPct: 0.1, debitPct: 0.9 },
      sampleDescriptions: ['GLOBEL TELCO MONTHLY'],
    };
    const enriched = await enrichCandidates(
      [candidate],
      new Map([['globel telco', 'GLOBEL TELCO MONTHLY']]),
      { companyId, prismaClient: db, contexts: [], glAccounts: [] },
    );

    expect(enriched).toHaveLength(1);
    expect(enriched[0].hasContext).toBe(false); // projection really gone
    expect(enriched[0].contextRole).toBe('PROVEEDOR'); // role from memory
    expect(enriched[0].directionWarning).toBeNull(); // debit profile matches
    expect(enriched[0].explanation).toContain('PROVEEDOR');

    // Direction mismatch is still validated against the memory role
    const creditCandidate: EntityCandidate = {
      id: 'cand_2',
      canonicalName: 'GLOBEL TELCO',
      occurrences: 4,
      directionProfile: { creditPct: 0.9, debitPct: 0.1 },
      sampleDescriptions: ['GLOBEL TELCO REFUND'],
    };
    const enrichedCredit = await enrichCandidates(
      [creditCandidate],
      new Map([['globel telco', 'GLOBEL TELCO REFUND']]),
      { companyId, prismaClient: db, contexts: [], glAccounts: [] },
    );
    expect(enrichedCredit[0].contextRole).toBe('PROVEEDOR');
    expect(enrichedCredit[0].directionWarning).not.toBeNull();
  });
});

describe('B6/B7 — no projection pollution + tenant isolation', () => {
  it('B6 — memory record alone never creates an EntityContext row', async () => {
    const res = await recordEntityRoleKnowledge(adapter, companyId, {
      entityContextId: 'ctx_ghost',
      pattern: 'ghost co',
      role: 'CLIENTE',
      source: 'user_confirmed',
      actor: 'admin-1',
    });
    expect(res.status).toBe('CREATED');

    expect(await db.entityContext.count({ where: { companyId } })).toBe(0);
    expect(await getEntityRoleKnowledge(adapter, companyId)).toHaveLength(1);
  });

  it('B7 — claims and conflicts never leak across tenants', async () => {
    await recordEntityRoleKnowledge(adapter, companyId, {
      entityContextId: 'ctx_a',
      pattern: 'acme',
      role: 'PROVEEDOR',
      source: 'user_confirmed',
      actor: 'admin-1',
    });

    expect(await getEntityRoleKnowledge(adapter, otherCompanyId)).toHaveLength(0);

    // Same anchor id under another tenant creates an isolated claim
    await recordEntityRoleKnowledge(adapter, otherCompanyId, {
      entityContextId: 'ctx_a',
      pattern: 'acme',
      role: 'CLIENTE',
      source: 'user_confirmed',
      actor: 'other-admin',
    });
    const mine = await getEntityRoleKnowledge(adapter, companyId);
    const theirs = await getEntityRoleKnowledge(adapter, otherCompanyId);
    expect(mine).toHaveLength(1);
    expect(mine[0].content.role).toBe('PROVEEDOR');
    expect(theirs).toHaveLength(1);
    expect(theirs[0].content.role).toBe('CLIENTE');
  });
});
