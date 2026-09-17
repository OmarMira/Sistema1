/**
 * JH2.12 — HMAC secret resolution contract.
 *
 * A: importing the module under NODE_ENV=production WITHOUT HMAC_SECRET
 *    must not throw by itself (next build page-data collection).
 * B: a crypto operation that actually needs the HMAC in production must
 *    reject a missing secret (no insecure fallback).
 * C: production WITH HMAC_SECRET computes normally (secret never printed).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
  delete process.env.HMAC_SECRET;
  process.env.NODE_ENV = 'test';
});

describe('JH2.12 — lazy HMAC_SECRET resolution (build-safe import, strict runtime)', () => {
  it('MODULE_IMPORT_WITHOUT_SECRET_PRODUCTION: importing journal-hash must not throw', async () => {
    delete process.env.HMAC_SECRET;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const mod = await import('@/lib/journal-hash');
    expect(typeof mod.computeEntryHashV2).toBe('function');
    expect(typeof mod.getJournalHmacSecret).toBe('function');
    process.env.NODE_ENV = 'test';
  });

  it('CRYPTO_OPERATION_WITHOUT_SECRET_PRODUCTION: compute must FAIL fast, no fallback', async () => {
    delete process.env.HMAC_SECRET;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const mod = await import('@/lib/journal-hash');
    expect(() =>
      mod.computeEntryHashV2({
        id: 'e1',
        companyId: 'c1',
        date: new Date('2026-01-01T00:00:00.000Z'),
        description: 'd',
        reference: null,
        previousHash: null,
        lines: [],
      }),
    ).toThrow(/HMAC_SECRET environment variable is required in production/);
    process.env.NODE_ENV = 'test';
  });

  it('CRYPTO_OPERATION_WITH_SECRET_PRODUCTION: computes a proper hex digest', async () => {
    process.env.HMAC_SECRET = 'x'.repeat(64);
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const mod = await import('@/lib/journal-hash');
    const hash = mod.computeEntryHashV2({
      id: 'e1',
      companyId: 'c1',
      date: new Date('2026-01-01T00:00:00.000Z'),
      description: 'd',
      reference: null,
      previousHash: null,
      lines: [{ glAccountId: 'g', debit: 10, credit: 10, description: null }],
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('x'.repeat(64));
    process.env.NODE_ENV = 'test';
  });

  it('test/development keeps the historical dev fallback behaviour', async () => {
    delete process.env.HMAC_SECRET;
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    const mod = await import('@/lib/journal-hash');
    const h1 = mod.computeEntryHashV2({
      id: 'e1',
      companyId: 'c1',
      date: new Date('2026-01-01T00:00:00.000Z'),
      description: 'd',
      reference: null,
      previousHash: null,
      lines: [],
    });
    const h2 = mod.computeEntryHashV2({
      id: 'e1',
      companyId: 'c1',
      date: new Date('2026-01-01T00:00:00.000Z'),
      description: 'd',
      reference: null,
      previousHash: null,
      lines: [],
    });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
