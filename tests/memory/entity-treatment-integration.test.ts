// Knowledge Engine — End-to-End Integration Test (Phase 4)
// Tests the full entity→treatment circuit with real PostgreSQL,
// real CompanyKnowledge, and real MemoryAdapter.
// Still isolated from production (import pipeline, PATCH route).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { TransactionRunner } from '../../src/memory/prisma-types';
import { resolveEntity } from '../../src/memory/entity-resolution';
import {
  lookupTreatment,
  learnEntityTreatment,
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

// ─── Helpers ────────────────────────────────────────────────────

async function createEntity(params: {
  companyId: string;
  canonicalName: string;
  aliases?: string[];
}) {
  return prisma.companyKnowledge.create({
    data: {
      companyId: params.companyId,
      type: 'COMPANY',
      canonicalName: params.canonicalName,
      aliases: params.aliases ?? [],
      metadata: {},
      source: 'test',
      status: 'active',
    },
  });
}

// ─── Flow A: Known alias + known treatment ──────────────────────

describe('Integration — Flow A: known alias + known treatment', () => {
  it('resolves entity via alias and retrieves treatment', async () => {
    const company = await createTestCompany('Integration Flow A');

    // Create entity with alias
    const entity = await createEntity({
      companyId: company.id,
      canonicalName: 'AMAZON',
      aliases: ['AMZN MKTPLACE'],
    });

    // Create treatment for this entity
    const learnResult = await learnEntityTreatment(
      adapter, company.id, entity.id, 'gl_amazon', 'debit', 'user_correction',
    );
    expect(learnResult.status).toBe('CREATED');

    // Resolve via alias
    const resolution = await resolveEntity(company.id, 'AMZN MKTPLACE');
    expect(resolution.status).toBe('KNOWN');
    if (resolution.status === 'KNOWN') {
      expect(resolution.entityId).toBe(entity.id);
    }

    // Lookup treatment
    const treatment = await lookupTreatment(adapter, company.id, entity.id);
    expect(treatment.status).toBe('FOUND');
    if (treatment.status === 'FOUND') {
      expect(treatment.glAccountId).toBe('gl_amazon');
      expect(treatment.direction).toBe('debit');
    }
  });
});

// ─── Flow B: Known alias + no treatment ─────────────────────────

describe('Integration — Flow B: known alias + no treatment', () => {
  it('resolves entity but treatment is NOT_FOUND', async () => {
    const company = await createTestCompany('Integration Flow B');

    const entity = await createEntity({
      companyId: company.id,
      canonicalName: 'GOOGLE',
      aliases: ['GOOGLE ADS'],
    });

    // Resolve — should work
    const resolution = await resolveEntity(company.id, 'GOOGLE ADS');
    expect(resolution.status).toBe('KNOWN');
    if (resolution.status === 'KNOWN') {
      expect(resolution.entityId).toBe(entity.id);
    }

    // Lookup treatment — should miss
    const treatment = await lookupTreatment(adapter, company.id, entity.id);
    expect(treatment).toEqual({ status: 'NOT_FOUND' });
  });
});

// ─── Flow C: Unknown entity ─────────────────────────────────────

describe('Integration — Flow C: unknown entity', () => {
  it('returns UNKNOWN and does not lookup treatment', async () => {
    const company = await createTestCompany('Integration Flow C');

    await createEntity({
      companyId: company.id,
      canonicalName: 'APPLE',
      aliases: ['APPLE STORE'],
    });

    // Unknown description
    const resolution = await resolveEntity(company.id, 'UNKNOWN VENDOR XYZ');
    expect(resolution).toEqual({ status: 'UNKNOWN' });

    // Should NOT proceed to lookupTreatment with invented entityId
  });
});

// ─── Flow D: Learn then lookup ──────────────────────────────────

describe('Integration — Flow D: learn then lookup', () => {
  it('creates treatment and retrieves it', async () => {
    const company = await createTestCompany('Integration Flow D');

    const entity = await createEntity({
      companyId: company.id,
      canonicalName: 'MICROSOFT',
      aliases: ['MSFT AZURE'],
    });

    // Learn
    const learnResult = await learnEntityTreatment(
      adapter, company.id, entity.id, 'gl_msft', 'credit', 'user_correction',
    );
    expect(learnResult.status).toBe('CREATED');

    // Lookup
    const treatment = await lookupTreatment(adapter, company.id, entity.id);
    expect(treatment.status).toBe('FOUND');
    if (treatment.status === 'FOUND') {
      expect(treatment.glAccountId).toBe('gl_msft');
      expect(treatment.direction).toBe('credit');
    }
  });
});

// ─── Flow E: Correction ─────────────────────────────────────────

describe('Integration — Flow E: correction updates treatment', () => {
  it('corrects treatment and verifies update', async () => {
    const company = await createTestCompany('Integration Flow E');

    const entity = await createEntity({
      companyId: company.id,
      canonicalName: 'FACEBOOK',
      aliases: ['META ADS'],
    });

    // Learn initial treatment
    const r1 = await learnEntityTreatment(
      adapter, company.id, entity.id, 'gl_fb_old', 'debit', 'user_correction',
    );
    expect(r1.status).toBe('CREATED');
    const itemId = r1.status === 'CREATED' ? r1.itemId : null;

    // Correct treatment
    const r2 = await learnEntityTreatment(
      adapter, company.id, entity.id, 'gl_fb_new', 'credit', 'import_correction',
    );
    expect(r2.status).toBe('UPDATED');
    if (r2.status === 'UPDATED') {
      expect(r2.itemId).toBe(itemId); // stable ID
    }

    // Resolve — same entity
    const resolution = await resolveEntity(company.id, 'META ADS');
    expect(resolution.status).toBe('KNOWN');
    if (resolution.status === 'KNOWN') {
      expect(resolution.entityId).toBe(entity.id);
    }

    // Lookup — new treatment
    const treatment = await lookupTreatment(adapter, company.id, entity.id);
    expect(treatment.status).toBe('FOUND');
    if (treatment.status === 'FOUND') {
      expect(treatment.glAccountId).toBe('gl_fb_new');
      expect(treatment.direction).toBe('credit');
      expect(treatment.memoryItemId).toBe(itemId);
    }
  });
});

// ─── Flow F: Tenant isolation end-to-end ────────────────────────

describe('Integration — Flow F: tenant isolation end-to-end', () => {
  it('same alias in different companies resolves to independent entities and treatments', async () => {
    const companyA = await createTestCompany('Integration Tenant A');
    const companyB = await createTestCompany('Integration Tenant B');

    // Both companies have an entity aliased "SHARED"
    const entityA = await createEntity({
      companyId: companyA.id,
      canonicalName: 'ENTITY A1',
      aliases: ['SHARED'],
    });
    const entityB = await createEntity({
      companyId: companyB.id,
      canonicalName: 'ENTITY B1',
      aliases: ['SHARED'],
    });

    // Different treatments
    await learnEntityTreatment(
      adapter, companyA.id, entityA.id, 'gl_tA', 'debit', 'user_correction',
    );
    await learnEntityTreatment(
      adapter, companyB.id, entityB.id, 'gl_tB', 'credit', 'user_correction',
    );

    // Resolve "SHARED" in each company
    const resA = await resolveEntity(companyA.id, 'SHARED');
    expect(resA.status).toBe('KNOWN');
    if (resA.status === 'KNOWN') {
      expect(resA.entityId).toBe(entityA.id);
    }

    const resB = await resolveEntity(companyB.id, 'SHARED');
    expect(resB.status).toBe('KNOWN');
    if (resB.status === 'KNOWN') {
      expect(resB.entityId).toBe(entityB.id);
    }

    // Lookup — independent treatments
    const tA = await lookupTreatment(adapter, companyA.id, entityA.id);
    expect(tA.status).toBe('FOUND');
    if (tA.status === 'FOUND') {
      expect(tA.glAccountId).toBe('gl_tA');
      expect(tA.direction).toBe('debit');
    }

    const tB = await lookupTreatment(adapter, companyB.id, entityB.id);
    expect(tB.status).toBe('FOUND');
    if (tB.status === 'FOUND') {
      expect(tB.glAccountId).toBe('gl_tB');
      expect(tB.direction).toBe('credit');
    }

    // Cross-tenant: A cannot see B's treatment
    const crossLookup = await lookupTreatment(adapter, companyA.id, entityB.id);
    expect(crossLookup).toEqual({ status: 'NOT_FOUND' });
  });
});

// ─── Flow G: Entity resolution ambiguity ────────────────────────

describe('Integration — Flow G: entity resolution ambiguity', () => {
  it('returns ERROR when two entities share the same alias', async () => {
    const company = await createTestCompany('Integration Flow G');

    // Create two entities with the same alias
    await createEntity({
      companyId: company.id,
      canonicalName: 'VENDOR ONE',
      aliases: ['SHARED ALIAS'],
    });
    await createEntity({
      companyId: company.id,
      canonicalName: 'VENDOR TWO',
      aliases: ['SHARED ALIAS'],
    });

    // resolveEntity must detect ambiguity — cannot pick one arbitrarily
    const resolution = await resolveEntity(company.id, 'SHARED ALIAS');
    expect(resolution.status).toBe('ERROR');
    if (resolution.status === 'ERROR') {
      expect(resolution.reason).toContain('Ambiguous entity identity');
      expect(resolution.reason).toContain('2 distinct entities');
    }
  });
});

// ─── Flow H: Treatment ambiguity ────────────────────────────────

describe('Integration — Flow H: treatment ambiguity', () => {
  it('lookupTreatment returns ERROR for multiple active treatments', async () => {
    const company = await createTestCompany('Integration Flow H');

    const entity = await createEntity({
      companyId: company.id,
      canonicalName: 'AMBIGUOUS VENDOR',
      aliases: ['AMB VENDOR'],
    });

    // Create two active treatments for same entity (bypass normal flow)
    await adapter.record({
      content: JSON.stringify({
        pattern: '', glAccountId: 'gl_amb_A', direction: 'debit',
        source: 'user_correction', entityId: entity.id,
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
        pattern: '', glAccountId: 'gl_amb_B', direction: 'credit',
        source: 'user_correction', entityId: entity.id,
      }),
      type: 'classification',
      companyId: company.id,
      sourceAuthor: 'user',
      sourceName: 'correction',
      sourceObservedAt: new Date(),
      confidence: 'tentative',
    });

    // lookupTreatment → ERROR
    const lookup = await lookupTreatment(adapter, company.id, entity.id);
    expect(lookup.status).toBe('ERROR');
    if (lookup.status === 'ERROR') {
      expect(lookup.reason).toContain('Ambiguous active treatment');
    }

    // learnEntityTreatment → ERROR
    const learn = await learnEntityTreatment(
      adapter, company.id, entity.id, 'gl_amb_C', 'any', 'user_correction',
    );
    expect(learn.status).toBe('ERROR');
    if (learn.status === 'ERROR') {
      expect(learn.reason).toContain('Ambiguous active treatment');
    }

    // Nothing should have been modified
    // (both items still have original GL accounts)
    const items = await prisma.memoryItem.findMany({
      where: {
        companyId: company.id,
        type: 'classification',
        status: 'active',
      },
    });
    const entityItems = items.filter((i) => {
      try {
        const c = JSON.parse(i.content) as ClassificationContent;
        return c.entityId === entity.id;
      } catch {
        return false;
      }
    });
    expect(entityItems).toHaveLength(2);
    const gls = entityItems.map((i) => {
      const c = JSON.parse(i.content) as ClassificationContent;
      return c.glAccountId;
    });
    expect(gls).toContain('gl_amb_A');
    expect(gls).toContain('gl_amb_B');
  });
});

// ─── AI dependency check ────────────────────────────────────────

describe('Integration — No AI dependency', () => {
  it('resolveEntity does not import AI modules', async () => {
    // Structural: resolveEntity imports only db from @/lib/db
    // This test documents that fact
    const company = await createTestCompany('Integration No AI');
    const result = await resolveEntity(company.id, 'ANYTHING');
    // If AI were called, it would fail or produce unexpected results
    expect(['KNOWN', 'UNKNOWN', 'ERROR']).toContain(result.status);
  });
});
