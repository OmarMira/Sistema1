import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { createBackup, restoreBackup, validateBackup, type BackupData } from '@/lib/backup';
import { clearDatabase } from '../helpers/factories';
import { deleteBackup } from '@/lib/backup';

/**
 * H-DR-1C — POLICY_A (MEMORY_FOLLOWS_BACKUP) contract tests.
 *
 * A Sistema1 backup is a recoverable snapshot of the company state at creation
 * time. Memory Core (SystemMemory + MemoryItem + 6 children) must travel with
 * the backup, and restore must leave the destination memory exactly as the
 * snapshot contains it (product owner decision).
 *
 * Synthetic fixtures only — no real data. Runs on accountexpress_bootstraptest
 * via vitest.forensic-f9.config.ts. Backup files created by the tests are
 * removed in afterEach (repo db/backups stays inventory-clean).
 */

const isBootstrapDb = (process.env.DATABASE_URL ?? '').includes('accountexpress_bootstraptest');

const CO_A = 'hdr1c-co-A';
const CO_B = 'hdr1c-co-B';
const ACTOR_ID = 'hdr1c-actor-user';
const ACTOR_EMAIL = 'hdr1c-actor@example.com';
const baseDate = new Date('2026-01-01T00:00:00.000Z');

const EXPECTED_SET = {
  systemMemories: 1,
  memoryItems: 3,
  memoryVersions: 1,
  relationships: 1,
  contradictions: 1,
  evolutionLinks: 1,
  traceabilityLogs: 1,
  confidenceLogs: 1,
} as const;

async function seedCompany(id: string, legalName: string): Promise<void> {
  await db.company.create({ data: { id, legalName, entityType: 'BUSINESS', isActive: true } });
}

async function createActor(): Promise<string> {
  const user = await db.user.create({
    data: {
      id: ACTOR_ID,
      email: ACTOR_EMAIL,
      passwordHash: 'fixture-hash-not-real',
      firstName: 'H',
      lastName: 'Actor',
      platformRole: 'user',
    },
  });
  return user.id;
}

/** Seeds one complete Memory Core set for a tenant (synthetic, exact ids). */
async function seedMemoryCore(companyId: string, tag: string): Promise<void> {
  const itemA = `hdr1c-item-${tag}-main`;
  const itemB = `hdr1c-item-${tag}-sub`;
  const itemC = `hdr1c-item-${tag}-third`;
  await db.memoryItem.createMany({
    data: [
      {
        id: itemA,
        companyId,
        content: `Sintetica ${tag}: facturas de energia van a Gastos`,
        type: 'email',
        confidence: 'certain',
        status: 'active',
        sourceAuthor: 'user',
        sourceName: 'test-fixture',
        sourceObservedAt: baseDate,
      },
      {
        id: itemB,
        companyId,
        content: `Sintetica ${tag}: proveedor ligado al registro contable`,
        type: 'pdf',
        confidence: 'tentative',
        status: 'confirmed',
        sourceAuthor: 'system',
        sourceName: 'test-fixture',
      },
      {
        id: itemC,
        companyId,
        content: `Sintetica ${tag}: superseded por item main`,
        type: 'note',
        status: 'forgotten',
        forgetReason: 'superseded-fixture',
        sourceAuthor: 'system',
        sourceName: 'test-fixture',
      },
    ],
  });
  await db.memoryVersion.create({
    data: {
      id: `hdr1c-ver-${tag}-v1`,
      itemId: itemA,
      versionNumber: 1,
      content: `Version 1 de ${tag}`,
      snapshot: JSON.stringify({ id: itemA, content: `Version 1 de ${tag}` }),
      createdAt: baseDate,
    },
  });
  await db.relationship.create({
    data: {
      id: `hdr1c-rel-${tag}`,
      sourceId: itemA,
      targetId: itemB,
      label: 'documenta',
      createdAt: baseDate,
    },
  });
  await db.contradiction.create({
    data: {
      id: `hdr1c-ctd-${tag}`,
      itemAId: itemA,
      itemBId: itemC,
      evidence: `Contradiccion sintetica ${tag}`,
      confidence: 1,
      detectedAt: baseDate,
      resolved: false,
    },
  });
  await db.evolutionLink.create({
    data: {
      id: `hdr1c-evo-${tag}`,
      supersededId: itemC,
      supersededById: itemA,
      linkType: 'supersedes',
      createdAt: baseDate,
    },
  });
  await db.traceabilityLog.create({
    data: {
      id: `hdr1c-trace-${tag}`,
      itemId: itemA,
      action: 'recorded',
      timestamp: baseDate,
      actor: 'user',
      details: JSON.stringify({ synthetic: true }),
    },
  });
  await db.confidenceLog.create({
    data: {
      id: `hdr1c-conf-${tag}`,
      itemId: itemA,
      previousLevel: 'tentative',
      newLevel: 'certain',
      reason: 'confirmacion sintetica',
      changedAt: baseDate,
    },
  });
  await db.systemMemory.create({
    data: {
      id: `hdr1c-sysmem-${tag}`,
      companyId,
      type: 'note',
      title: `Nota ${tag}`,
      content: `Content sintetico ${tag}`,
      keywords: 'sintetico, test',
      importance: 5,
      accessCount: 3,
      lastAccessedAt: baseDate,
      embedding: '[0.1,0.2,0.3]',
      createdAt: baseDate,
    },
  });
}

async function memoryCounts(companyId: string) {
  return {
    systemMemories: await db.systemMemory.count({ where: { companyId } }),
    memoryItems: await db.memoryItem.count({ where: { companyId } }),
    memoryVersions: await db.memoryVersion.count({ where: { item: { companyId } } }),
    relationships: await db.relationship.count({
      where: { source: { companyId }, target: { companyId } },
    }),
    contradictions: await db.contradiction.count({
      where: { itemA: { companyId }, itemB: { companyId } },
    }),
    evolutionLinks: await db.evolutionLink.count({
      where: { superseded: { companyId }, supersedingBy: { companyId } },
    }),
    traceabilityLogs: await db.traceabilityLog.count({ where: { item: { companyId } } }),
    confidenceLogs: await db.confidenceLog.count({ where: { item: { companyId } } }),
  };
}

function parseBackup(base64: string): BackupData {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8')) as BackupData;
}

/** Removes suite leftovers of this suite only (exact 'hdr1c-' prefix scope). */
async function cleanupHdr1c(): Promise<void> {
  await db.systemMemory.deleteMany({ where: { companyId: { startsWith: 'hdr1c-' } } });
  await db.memoryItem.deleteMany({ where: { companyId: { startsWith: 'hdr1c-' } } });
  await db.auditLog.deleteMany({ where: { companyId: { startsWith: 'hdr1c-' } } });
  await db.companyMember.deleteMany({ where: { companyId: { startsWith: 'hdr1c-' } } });
  await db.company.deleteMany({ where: { id: { startsWith: 'hdr1c-' } } });
  await db.user.deleteMany({ where: { email: { contains: 'hdr1c-' } } });
}

describe.skipIf(!isBootstrapDb)('H-DR-1C — Memory Core backup/restore (POLICY_A)', () => {
  let createdBackups: Array<{ filename: string; companyId: string }> = [];

  beforeEach(async () => {
    await cleanupHdr1c();
    await clearDatabase();
    createdBackups = [];
  });

  afterEach(async () => {
    for (const b of createdBackups) {
      deleteBackup(b.filename, b.companyId);
    }
    await cleanupHdr1c();
    await clearDatabase();
  });

  it('T1 — BACKUP CAPTURE: createBackup contains exactly this tenant memory core', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    await createActor();
    await seedMemoryCore(CO_A, 't1');

    const backup = await createBackup(CO_A);
    createdBackups.push({ filename: backup.filename, companyId: CO_A });
    const parsed = parseBackup(backup.data);

    expect(parsed.manifest.recordCounts.memoryItems).toBe(3);
    expect(parsed.manifest.recordCounts.memoryVersions).toBe(1);
    expect(parsed.manifest.recordCounts.systemMemories).toBe(1);
    expect(parsed.data.memoryItems?.length).toBe(3);
    expect(parsed.data.memoryVersions?.length).toBe(1);
    expect(parsed.data.relationships?.length).toBe(1);
    expect(parsed.data.contradictions?.length).toBe(1);
    expect(parsed.data.evolutionLinks?.length).toBe(1);
    expect(parsed.data.traceabilityLogs?.length).toBe(1);
    expect(parsed.data.confidenceLogs?.length).toBe(1);
    expect(parsed.data.systemMemories?.length).toBe(1);
  });

  it('T2 — TENANT ISOLATION: memory of Co B never appears in backup of Co A', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    await seedCompany(CO_B, 'HDR1C Co B');
    await seedMemoryCore(CO_A, 't2');
    await db.memoryItem.create({
      data: {
        id: 'hdr1c-item-bx',
        companyId: CO_B,
        type: 'note',
        content: 'Memoria del tenant B',
        sourceAuthor: 'user',
        sourceName: 'fixture-b',
      },
    });

    const backup = await createBackup(CO_A);
    createdBackups.push({ filename: backup.filename, companyId: CO_A });
    const parsed = parseBackup(backup.data);

    const memoryItems = (parsed.data.memoryItems ?? []).map((m) => m.id as string);
    expect(memoryItems).not.toContain('hdr1c-item-bx');
    // B memory remains in DB, untouched.
    expect(await db.memoryItem.count({ where: { companyId: CO_B } })).toBe(1);
  });

  it('T3 — TOTAL LOSS: bootstrap restore onto empty destination recovers all 8 collections', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    const actor = await createActor();
    await seedMemoryCore(CO_A, 't3');
    const backup = await createBackup(CO_A);
    createdBackups.push({ filename: backup.filename, companyId: CO_A });
    const parsed = parseBackup(backup.data);

    // Simulate total loss: memory vanishes at the destination.
    await db.memoryItem.deleteMany({ where: { companyId: CO_A } });
    await db.systemMemory.deleteMany({ where: { companyId: CO_A } });

    const result = await restoreBackup(CO_A, parsed, actor, { bootstrap: true });
    expect(result.success).toBe(true);

    const after = await memoryCounts(CO_A);
    expect(after).toEqual(EXPECTED_SET);
  });

  it('T4 — POINT-IN-TIME ROLLBACK: memory T1 restored, learning T2 gone', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    const actor = await createActor();
    await seedMemoryCore(CO_A, 't4');
    const t1Backup = await createBackup(CO_A);
    createdBackups.push({ filename: t1Backup.filename, companyId: CO_A });
    const t1 = parseBackup(t1Backup.data);

    // Learning after T1: new item + modified existing item.
    await db.memoryItem.create({
      data: {
        id: 'hdr1c-item-t4-new',
        companyId: CO_A,
        type: 'note',
        content: 'Aprendido DESPUES del backup',
        sourceAuthor: 'user',
        sourceName: 'post-backup',
      },
    });
    await db.memoryItem.update({
      where: { id: 'hdr1c-item-t4-main' },
      data: { content: 'MODIFICADO post-backup' },
    });

    const result = await restoreBackup(CO_A, t1, actor, {});
    expect(result.success).toBe(true);

    const items = await db.memoryItem.findMany({ where: { companyId: CO_A } });
    expect(items.some((i) => i.id === 'hdr1c-item-t4-new')).toBe(false);
    const main = items.find((i) => i.id === 'hdr1c-item-t4-main');
    expect(main?.content).toBe('Sintetica t4: facturas de energia van a Gastos');
    const after = await memoryCounts(CO_A);
    expect(after).toEqual(EXPECTED_SET);
  });

  it('T5 — STALE MEMORY ELIMINATION: destination-only memory disappears on restore', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    const actor = await createActor();
    // Snapshot from an empty memory state.
    const fresh = await createBackup(CO_A);
    createdBackups.push({ filename: fresh.filename, companyId: CO_A });
    const t1 = parseBackup(fresh.data);

    // Destination later gains a stale memory row.
    await db.memoryItem.create({
      data: {
        id: 'hdr1c-item-t5-later',
        companyId: CO_A,
        type: 'note',
        content: 'stale',
        sourceAuthor: 'system',
        sourceName: 'destiny-only',
      },
    });

    const result = await restoreBackup(CO_A, t1, actor, {});
    expect(result.success).toBe(true);

    const stale = await db.memoryItem.findUnique({ where: { id: 'hdr1c-item-t5-later' } });
    expect(stale).toBeNull();
    expect(await db.memoryItem.count({ where: { companyId: CO_A } })).toBe(0);
  });

  it('T6 — OTHER TENANT PRESERVATION: restore of Co A does not touch Co B memory', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    await seedCompany(CO_B, 'HDR1C Co B');
    const actor = await createActor();
    await seedMemoryCore(CO_A, 't6');
    await seedMemoryCore(CO_B, 'b6');

    const backup = await createBackup(CO_A);
    createdBackups.push({ filename: backup.filename, companyId: CO_A });
    const parsed = parseBackup(backup.data);

    const result = await restoreBackup(CO_A, parsed, actor, {});
    expect(result.success).toBe(true);

    const afterB = await memoryCounts(CO_B);
    expect(afterB).toEqual(EXPECTED_SET);
  });

  it('T7 — HISTORY: MemoryVersion/TraceabilityLog/ConfidenceLog recover exactly', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    const actor = await createActor();
    await seedMemoryCore(CO_A, 't7');
    const backup = await createBackup(CO_A);
    createdBackups.push({ filename: backup.filename, companyId: CO_A });
    const parsed = parseBackup(backup.data);

    await db.memoryItem.deleteMany({ where: { companyId: CO_A } });
    await db.systemMemory.deleteMany({ where: { companyId: CO_A } });

    const result = await restoreBackup(CO_A, parsed, actor, {});
    expect(result.success).toBe(true);

    const version = await db.memoryVersion.findUnique({ where: { id: 'hdr1c-ver-t7-v1' } });
    expect(version?.versionNumber).toBe(1);
    expect(version?.content).toBe('Version 1 de t7');
    expect(JSON.parse((version?.snapshot as unknown as string) ?? '{}')).toEqual({
      id: 'hdr1c-item-t7-main',
      content: 'Version 1 de t7',
    });

    const trace = await db.traceabilityLog.findUnique({ where: { id: 'hdr1c-trace-t7' } });
    expect(trace?.action).toBe('recorded');
    expect(trace?.actor).toBe('user');
    expect(trace?.details).toBe(JSON.stringify({ synthetic: true }));

    const conf = await db.confidenceLog.findUnique({ where: { id: 'hdr1c-conf-t7' } });
    expect(conf?.previousLevel).toBe('tentative');
    expect(conf?.newLevel).toBe('certain');
    expect(conf?.reason).toBe('confirmacion sintetica');
  });

  it('T8 — GRAPH INTEGRITY: edges reference restored MemoryItems', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    const actor = await createActor();
    await seedMemoryCore(CO_A, 't8');
    const backup = await createBackup(CO_A);
    createdBackups.push({ filename: backup.filename, companyId: CO_A });
    const parsed = parseBackup(backup.data);

    await db.memoryItem.deleteMany({ where: { companyId: CO_A } });
    const result = await restoreBackup(CO_A, parsed, actor, {});
    expect(result.success).toBe(true);

    const item = await db.memoryItem.findUnique({ where: { id: 'hdr1c-item-t8-main' } });
    expect(item?.id).toBe('hdr1c-item-t8-main');
  });

  it('T9 — SYSTEM MEMORY: recovered with tenant scope and persisted state', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    const actor = await createActor();
    await seedMemoryCore(CO_A, 't9');
    const backup = await createBackup(CO_A);
    createdBackups.push({ filename: backup.filename, companyId: CO_A });
    const parsed = parseBackup(backup.data);
    await db.systemMemory.deleteMany({ where: { companyId: CO_A } });

    const result = await restoreBackup(CO_A, parsed, actor, {});
    expect(result.success).toBe(true);

    const mem = await db.systemMemory.findUnique({ where: { id: 'hdr1c-sysmem-t9' } });
    expect(mem?.companyId).toBe(CO_A);
    expect(mem?.embedding).toBe('[0.1,0.2,0.3]');
    expect(mem?.keywords).toBe('sintetico, test');
    expect(mem?.accessCount).toBe(3);
  });

  it('T10 — LEGACY BACKUP (1.0.0, no memory sections): restore succeeds and memory ends EMPTY', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    const actor = await createActor();
    await seedMemoryCore(CO_A, 't10');
    const fresh = await createBackup(CO_A);
    createdBackups.push({ filename: fresh.filename, companyId: CO_A });
    const payload = parseBackup(fresh.data);

    // Legacy 1.0.0 snapshot legitimately has no Memory Core sections.
    const legacy: BackupData = {
      manifest: JSON.parse(JSON.stringify({ ...payload.manifest, version: '1.0.0' })),
      data: JSON.parse(
        JSON.stringify({
          ...payload.data,
          systemMemories: undefined,
          memoryItems: undefined,
          memoryVersions: undefined,
          relationships: undefined,
          contradictions: undefined,
          evolutionLinks: undefined,
          traceabilityLogs: undefined,
          confidenceLogs: undefined,
        }),
      ) as BackupData['data'],
    };
    expect(legacy.data.memoryItems).toBeUndefined();

    // Destination currently HAS memory — legacy restore must reset it to empty.
    const result = await restoreBackup(CO_A, legacy, actor, {});
    expect(result.success).toBe(true);
    const after = await memoryCounts(CO_A);
    expect(after.systemMemories).toBe(0);
    expect(after.memoryItems).toBe(0);
    expect(after.memoryVersions).toBe(0);
    expect(after.relationships).toBe(0);
    expect(after.contradictions).toBe(0);
    expect(after.evolutionLinks).toBe(0);
    expect(after.traceabilityLogs).toBe(0);
    expect(after.confidenceLogs).toBe(0);
  });

  it('T11 — NEW FORMAT VALIDATION: 1.1.0 backup missing a memory section is rejected', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    await seedMemoryCore(CO_A, 't11');
    const fresh = await createBackup(CO_A);
    createdBackups.push({ filename: fresh.filename, companyId: CO_A });
    const payload = parseBackup(fresh.data);

    // New-format backup missing memoryVersions → malformed (no silent legacy degrade).
    const invalid: BackupData = {
      manifest: payload.manifest,
      data: { ...payload.data, memoryVersions: undefined as unknown as Record<string, unknown>[] },
    };
    const validation = validateBackup(invalid);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes('memoryVersions'))).toBe(true);

    // Legacy versions without memory sections remain valid.
    const legacy: BackupData = {
      manifest: { ...payload.manifest, version: '1.0.0' },
      data: payload.data,
    };
    expect(validateBackup(legacy).valid).toBe(true);
  });

  it('T12 — ATOMIC FAILURE: memory-core failure leaves no partial restore', async () => {
    await seedCompany(CO_A, 'HDR1C Co A');
    const actor = await createActor();
    await seedMemoryCore(CO_A, 't12');
    const backup = await createBackup(CO_A);
    createdBackups.push({ filename: backup.filename, companyId: CO_A });
    const parsed = parseBackup(backup.data);

    // Poison: a contradiction referencing an item NOT part of the snapshot →
    // restore must fail closed and roll back (no partial memory or accounting).
    const poisoned: BackupData = {
      manifest: parsed.manifest,
      data: {
        ...parsed.data,
        contradictions: [
          ...((parsed.data.contradictions ?? []) as Array<Record<string, unknown>>),
          {
            id: 'hdr1c-ctd-poison',
            itemAId: 'hdr1c-item-t12-main',
            itemBId: 'hdr1c-ghost-item',
            evidence: 'poison',
            confidence: 1,
            detectedAt: baseDate,
            resolved: false,
          },
        ],
      },
    };

    const preItems = await db.memoryItem.count({ where: { companyId: CO_A } });
    const result = await restoreBackup(CO_A, poisoned, actor, {});
    expect(result.success).toBe(false);
    const postItems = await db.memoryItem.count({ where: { companyId: CO_A } });
    expect(postItems).toBe(preItems);
    expect(result.restoredCounts.memoryItems ?? 0).toBe(0);
  });
});
