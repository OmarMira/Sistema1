// Knowledge Engine — PostgreSQL Integration Tests
// Tests against real accountexpress_test database using MemoryAdapter/MemoryService.
// Validates: A/B isolation, versioning (C4/C5), deterministic lookup.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { MemoryAdapter } from '../../src/memory/adapter';
import type { TransactionRunner } from '../../src/memory/prisma-types';
import {
  normalizeDescription,
  learnFromCorrection,
  lookupClassification,
  type ClassificationContent,
} from '../../src/memory/classification-knowledge';
import { createTestCompany, clearDatabase } from '../helpers/factories';

const prisma = new PrismaClient();
const runTx: TransactionRunner = (fn) => prisma.$transaction(fn);
const adapter = new MemoryAdapter(prisma, runTx);

// ─── Helpers ────────────────────────────────────────────────────

function createContent(pattern: string, glAccountId: string): string {
  return JSON.stringify({
    pattern,
    glAccountId,
    direction: 'any',
    source: 'user_correction',
    transactionId: 'test_txn',
  } satisfies ClassificationContent);
}

// ─── Setup / Teardown ──────────────────────────────────────────

beforeEach(async () => {
  await clearDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

// ─── Test A: Company A learns, lookup returns hit ───────────────

describe('PostgreSQL — Company A learns and retrieves', () => {
  it('records pattern and retrieves via deterministic lookup', async () => {
    const company = await createTestCompany('KE Test Company A');
    const pattern = 'AMZN MKTPLACE';
    const glAccountId = 'gl_x123';

    // Learn
    const result = await learnFromCorrection(
      adapter,
      company.id,
      pattern,
      glAccountId,
      'any',
      'txn_001',
    );
    expect(result.ok).toBe(true);

    // Lookup
    const lookup = await lookupClassification(adapter, company.id, pattern);
    expect(lookup.kind).toBe('hit');
    if (lookup.kind === 'hit') {
      expect(lookup.glAccountId).toBe(glAccountId);
      expect(lookup.direction).toBe('any');
    }
  });
});

// ─── Test B: Company B same pattern → miss ─────────────────────

describe('PostgreSQL — Company B isolation', () => {
  it('does not see Company A knowledge', async () => {
    const companyA = await createTestCompany('KE Test Company A2');
    const companyB = await createTestCompany('KE Test Company B2');
    const pattern = 'AMZN MKTPLACE';

    // Company A learns
    await learnFromCorrection(adapter, companyA.id, pattern, 'gl_x123', 'any', 'txn_001');

    // Company B looks up — should miss
    const lookup = await lookupClassification(adapter, companyB.id, pattern);
    expect(lookup.kind).toBe('miss');
  });
});

// ─── Test C: Second correction → same ID, updated content, version history ──

describe('PostgreSQL — Second correction updates same item', () => {
  it('same MemoryItem ID, new content, version history preserved', async () => {
    const company = await createTestCompany('KE Test Company Versioning');
    const pattern = 'AMZN MKTPLACE';

    // First correction
    const result1 = await learnFromCorrection(
      adapter,
      company.id,
      pattern,
      'gl_x123',
      'any',
      'txn_001',
    );
    expect(result1.ok).toBe(true);
    const itemId = result1.ok ? result1.itemId : null;
    expect(itemId).toBeTruthy();

    // Second correction — different GL account
    const result2 = await learnFromCorrection(
      adapter,
      company.id,
      pattern,
      'gl_y456',
      'any',
      'txn_002',
    );
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      // Same item ID — not a new item
      expect(result2.itemId).toBe(itemId);
    }

    // Verify current content has new GL account
    const lookup = await lookupClassification(adapter, company.id, pattern);
    expect(lookup.kind).toBe('hit');
    if (lookup.kind === 'hit') {
      expect(lookup.glAccountId).toBe('gl_y456');
    }

    // Verify version history exists (C4/C5)
    const versions = await prisma.memoryVersion.findMany({
      where: { itemId: itemId! },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.length).toBeGreaterThanOrEqual(2);

    // Version 1 should contain the original GL account
    const v1 = versions[0]!;
    const v1Content = JSON.parse(v1.content) as ClassificationContent;
    expect(v1Content.glAccountId).toBe('gl_x123');

    // Version 2 should contain the previous snapshot
    const v2 = versions[1]!;
    const v2Snapshot = v2.snapshot as Record<string, unknown>;
    // Snapshot contains the full item; content is JSON string with previous GL
    const v2Content = JSON.parse(v2Snapshot.content as string) as ClassificationContent;
    expect(v2Content.glAccountId).toBe('gl_x123');
  });
});

// ─── Test D: normalizeDescription produces consistent results ──

describe('PostgreSQL — Normalization consistency', () => {
  it('same raw description normalizes to same pattern', async () => {
    const a = normalizeDescription('AMZN MKTPLACE');
    const b = normalizeDescription('AMZN MKTPLACE');
    expect(a).toBe(b);
  });
});
