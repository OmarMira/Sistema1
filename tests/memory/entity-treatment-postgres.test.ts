// Knowledge Engine — Entity-Aware Learning PostgreSQL Integration Test
// Demonstrates real C4/C5 versioning with learnEntityTreatment on actual PostgreSQL.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { TransactionRunner } from '../../src/memory/prisma-types';
import {
  learnEntityTreatment,
  lookupTreatment,
  type ClassificationContent,
} from '../../src/memory/classification-knowledge';
import { createTestCompany, clearDatabase } from '../helpers/factories';

const prisma = new PrismaClient();
const runTx: TransactionRunner = (fn) => prisma.$transaction(fn);
const adapter = new MemoryAdapter(prisma, runTx);

beforeEach(async () => {
  await clearDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

// ─── PostgreSQL C4/C5 Entity Treatment ──────────────────────────

describe('PostgreSQL — Entity Treatment C4/C5 versioning', () => {
  it('creates, updates with stable ID, and preserves version history', async () => {
    const company = await createTestCompany('KE PG Entity Test');
    const entityId = 'entity_pg_001';

    // ── Step 1: CREATE ──────────────────────────────────────────

    const createResult = await learnEntityTreatment(
      adapter,
      company.id,
      entityId,
      'gl_pg_100',
      'debit',
      'user_correction',
    );
    expect(createResult.status).toBe('CREATED');
    const itemId = createResult.status === 'CREATED' ? createResult.itemId : null;
    expect(itemId).toBeTruthy();

    // ── Step 2: Verify via lookupTreatment ──────────────────────

    const lookup1 = await lookupTreatment(adapter, company.id, entityId);
    expect(lookup1.status).toBe('FOUND');
    if (lookup1.status === 'FOUND') {
      expect(lookup1.glAccountId).toBe('gl_pg_100');
      expect(lookup1.direction).toBe('debit');
      expect(lookup1.memoryItemId).toBe(itemId);
    }

    // ── Step 3: UPDATE (different GL + direction) ───────────────

    const updateResult = await learnEntityTreatment(
      adapter,
      company.id,
      entityId,
      'gl_pg_999',
      'credit',
      'import_correction',
    );
    expect(updateResult.status).toBe('UPDATED');
    if (updateResult.status === 'UPDATED') {
      // C4: MemoryItem.id must be stable
      expect(updateResult.itemId).toBe(itemId);
    }

    // ── Step 4: Verify current content has new GL ───────────────

    const lookup2 = await lookupTreatment(adapter, company.id, entityId);
    expect(lookup2.status).toBe('FOUND');
    if (lookup2.status === 'FOUND') {
      expect(lookup2.glAccountId).toBe('gl_pg_999');
      expect(lookup2.direction).toBe('credit');
      expect(lookup2.memoryItemId).toBe(itemId);
    }

    // ── Step 5: Verify version history (C5) ─────────────────────

    const versions = await prisma.memoryVersion.findMany({
      where: { itemId: itemId! },
      orderBy: { versionNumber: 'asc' },
    });

    // Should have 2 versions: initial (v1) + previous snapshot (v2)
    expect(versions.length).toBe(2);

    // Version 1: initial creation content
    const v1Content = JSON.parse(versions[0].content) as ClassificationContent;
    expect(v1Content.glAccountId).toBe('gl_pg_100');
    expect(v1Content.direction).toBe('debit');
    expect(v1Content.entityId).toBe(entityId);

    // Version 2: snapshot of item BEFORE update (C5 preserves old content)
    const v2Snapshot = versions[1].snapshot as Record<string, unknown>;
    const v2Content = JSON.parse(v2Snapshot.content as string) as ClassificationContent;
    expect(v2Content.glAccountId).toBe('gl_pg_100');
    expect(v2Content.direction).toBe('debit');
  });
});

// ─── PostgreSQL Entity Treatment UNCHANGED ──────────────────────

describe('PostgreSQL — Entity Treatment UNCHANGED (no-op)', () => {
  it('does not create version when treatment is identical', async () => {
    const company = await createTestCompany('KE PG Entity Unchanged');
    const entityId = 'entity_pg_unchanged';

    // First: create
    const result1 = await learnEntityTreatment(
      adapter,
      company.id,
      entityId,
      'gl_unchanged',
      'debit',
      'user_correction',
    );
    expect(result1.status).toBe('CREATED');
    const itemId = result1.status === 'CREATED' ? result1.itemId : null;

    // Count versions after creation (should be 1 — initial)
    const versionsAfterCreate = await prisma.memoryVersion.findMany({
      where: { itemId: itemId! },
    });
    expect(versionsAfterCreate).toHaveLength(1);

    // Second: same treatment
    const result2 = await learnEntityTreatment(
      adapter,
      company.id,
      entityId,
      'gl_unchanged',
      'debit',
      'import_correction',
    );
    expect(result2.status).toBe('UNCHANGED');
    if (result2.status === 'UNCHANGED') {
      expect(result2.itemId).toBe(itemId);
    }

    // No new version created
    const versionsAfterUnchanged = await prisma.memoryVersion.findMany({
      where: { itemId: itemId! },
    });
    expect(versionsAfterUnchanged).toHaveLength(1);
  });
});

// ─── PostgreSQL Entity Treatment Ambiguity ──────────────────────

describe('PostgreSQL — Entity Treatment ambiguity detection', () => {
  it('returns ERROR when multiple active treatments exist for same entity', async () => {
    const company = await createTestCompany('KE PG Entity Ambiguity');
    const entityId = 'entity_pg_amb';

    // Create two active treatments for same entity (bypass normal flow)
    await adapter.record({
      content: JSON.stringify({
        pattern: '', glAccountId: 'gl_amb_A', direction: 'debit',
        source: 'user_correction', entityId,
      }),
      type: 'classification',
      companyId: company.id,
      sourceAuthor: 'user',
      sourceName: 'correction',
      sourceObservedAt: new Date(),
      confidence: 'certain',
    });

    await adapter.record({
      content: JSON.stringify({
        pattern: '', glAccountId: 'gl_amb_B', direction: 'debit',
        source: 'user_correction', entityId,
      }),
      type: 'classification',
      companyId: company.id,
      sourceAuthor: 'user',
      sourceName: 'correction',
      sourceObservedAt: new Date(),
      confidence: 'tentative',
    });

    // learnEntityTreatment should detect ambiguity
    const result = await learnEntityTreatment(
      adapter,
      company.id,
      entityId,
      'gl_amb_C',
      'credit',
      'user_correction',
    );
    expect(result.status).toBe('ERROR');
    if (result.status === 'ERROR') {
      expect(result.reason).toContain('Ambiguous active treatment for entity entity_pg_amb');
    }

    // lookupTreatment should also detect ambiguity
    const lookup = await lookupTreatment(adapter, company.id, entityId);
    expect(lookup.status).toBe('ERROR');
  });
});

// ─── PostgreSQL Entity Treatment Tenant Isolation ───────────────

describe('PostgreSQL — Entity Treatment tenant isolation', () => {
  it('same entity in different companies has independent treatments', async () => {
    const companyA = await createTestCompany('KE PG Tenant A');
    const companyB = await createTestCompany('KE PG Tenant B');
    const entityId = 'entity_pg_tenant_shared';

    // Both companies learn same entity with different GL
    const rA = await learnEntityTreatment(
      adapter, companyA.id, entityId, 'gl_tA', 'debit', 'user_correction',
    );
    const rB = await learnEntityTreatment(
      adapter, companyB.id, entityId, 'gl_tB', 'credit', 'user_correction',
    );
    expect(rA.status).toBe('CREATED');
    expect(rB.status).toBe('CREATED');

    // Lookup each — independent results
    const lookupA = await lookupTreatment(adapter, companyA.id, entityId);
    expect(lookupA.status).toBe('FOUND');
    if (lookupA.status === 'FOUND') {
      expect(lookupA.glAccountId).toBe('gl_tA');
      expect(lookupA.direction).toBe('debit');
    }

    const lookupB = await lookupTreatment(adapter, companyB.id, entityId);
    expect(lookupB.status).toBe('FOUND');
    if (lookupB.status === 'FOUND') {
      expect(lookupB.glAccountId).toBe('gl_tB');
      expect(lookupB.direction).toBe('credit');
    }

    // Update A — B must not change
    const updateA = await learnEntityTreatment(
      adapter, companyA.id, entityId, 'gl_tA_NEW', 'any', 'import_correction',
    );
    expect(updateA.status).toBe('UPDATED');

    const lookupBAfter = await lookupTreatment(adapter, companyB.id, entityId);
    expect(lookupBAfter.status).toBe('FOUND');
    if (lookupBAfter.status === 'FOUND') {
      expect(lookupBAfter.glAccountId).toBe('gl_tB');
      expect(lookupBAfter.direction).toBe('credit');
    }
  });
});
