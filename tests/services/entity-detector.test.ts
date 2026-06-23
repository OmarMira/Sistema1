import { describe, it, expect } from 'vitest';
import { clusterCandidates, extractName, loadConfig } from '@/lib/services/entity-detector';
import type { ClusterOptions } from '@/lib/services/entity-detector';

describe('Entity Extraction & Clustering', () => {
  it('debe extraer y agrupar más de 3 entidades sin truncar o limitar a 3', () => {
    const transactions = [
      { description: 'Zelle from 7-ELEVEN', amount: 50.0, date: '2026-05-25' },
      { description: 'Zelle from 7-ELEVEN', amount: 50.0, date: '2026-05-25' },
      { description: 'Zelle from WAL-MART', amount: 100.0, date: '2026-05-25' },
      { description: 'Zelle from WAL-MART', amount: 100.0, date: '2026-05-25' },
      { description: 'Zelle from O\'REILLY', amount: 150.0, date: '2026-05-25' },
      { description: 'Zelle from O\'REILLY', amount: 150.0, date: '2026-05-25' },
      { description: 'Zelle from STARBUCKS', amount: 10.0, date: '2026-05-25' },
      { description: 'Zelle from STARBUCKS', amount: 10.0, date: '2026-05-25' },
      { description: 'Zelle from MCDONALDS', amount: 20.0, date: '2026-05-25' },
      { description: 'Zelle from MCDONALDS', amount: 20.0, date: '2026-05-25' },
    ];

    const config = loadConfig();
    const result = clusterCandidates(transactions, config);

    expect(result.length).toBeGreaterThan(3);
  });

  it('debe capturar correctamente nombres con dígitos, guiones y apóstrofes (7-ELEVEN, WAL-MART, O\'REILLY)', () => {
    const transactions = [
      { description: 'Zelle from 7-ELEVEN', amount: 50.0, date: '2026-05-25' },
      { description: 'Zelle from 7-ELEVEN', amount: 50.0, date: '2026-05-25' },
      { description: 'Zelle from WAL-MART', amount: 100.0, date: '2026-05-25' },
      { description: 'Zelle from WAL-MART', amount: 100.0, date: '2026-05-25' },
      { description: 'Zelle from O\'REILLY', amount: 150.0, date: '2026-05-25' },
      { description: 'Zelle from O\'REILLY', amount: 150.0, date: '2026-05-25' },
    ];

    const config = loadConfig();
    const result = clusterCandidates(transactions, config);

    const names = result.map(c => c.canonicalName.toUpperCase());
    expect(names).toContain('7-ELEVEN');
    expect(names).toContain('WAL-MART');
    expect(names).toContain('O\'REILLY');
  });
});

// ─── Escenario 1: P1 gana sobre P3 (el bug original de Amex + INDN:LAURA) ────
describe('extractName — Priority 1 (merchant) wins over Priority 3 (INDN ACH)', () => {
  it('debe retornar el merchant "AMERICAN EXPRESS" y NO "LAURA QUIJANO" cuando ambos están presentes', () => {
    // This is the exact bug: P3 (INDN:) was priority 1 before the fix,
    // causing "LAURA QUIJANO" to be extracted instead of "AMERICAN EXPRESS".
    const config = loadConfig();
    const raw = 'AMERICAN EXPRESS DES:ACH PMT ID:1234567890 INDN:LAURA QUIJANO CO ID:9876';
    const result = extractName(raw, config);

    expect(result).not.toBeNull();
    expect(result!.toUpperCase()).toContain('AMERICAN EXPRESS');
    expect(result!.toUpperCase()).not.toContain('LAURA QUIJANO');
  });

  it('debe retornar el merchant "KMF" y NO el nombre del socio cuando ambos están presentes', () => {
    const config = loadConfig();
    const raw = 'KMF DES:KMFUSA.com ID:9876543210 INDN:OMAR MIRA CO ID:1234';
    const result = extractName(raw, config);

    expect(result).not.toBeNull();
    expect(result!.toUpperCase()).toContain('KMF');
    expect(result!.toUpperCase()).not.toContain('OMAR MIRA');
  });
});

// ─── Escenario 2: P2 captura el nombre en Zelle directo (no confunde con merchant) ──
describe('extractName — Priority 2 (Zelle/transfer) captures person name correctly', () => {
  it('debe extraer "LAURA QUIJANO" de un Zelle payment to cuando no hay merchant al inicio', () => {
    // After sanitization "Zelle payment" prefix is stripped → "to LAURA QUIJANO" remains.
    // P1 won't match (no DES:/ID: descriptor), P2 matches "to LAURA QUIJANO".
    const config = loadConfig();
    const raw = 'Zelle payment to LAURA QUIJANO';
    const result = extractName(raw, config);

    expect(result).not.toBeNull();
    expect(result!.toUpperCase()).toContain('LAURA QUIJANO');
  });

  it('debe extraer "OMAR MIRA" de un Zelle to OMAR MIRA', () => {
    const config = loadConfig();
    const raw = 'Zelle to OMAR MIRA';
    const result = extractName(raw, config);

    expect(result).not.toBeNull();
    expect(result!.toUpperCase()).toContain('OMAR MIRA');
  });
});

// ─── Escenario 3: P3 solo actúa como fallback para ACH puro sin merchant ni keyword ──
describe('extractName — Priority 3 (INDN ACH) only fires as fallback', () => {
  it('debe extraer el nombre de INDN: cuando no hay merchant posicional ni keyword de transferencia', () => {
    // Pure ACH transaction with no merchant at start and no "from/to/payee" keyword.
    const config = loadConfig();
    const raw = 'ACH CREDIT INDN:JOHN SMITH CO ID:98765 CCD';
    const result = extractName(raw, config);

    expect(result).not.toBeNull();
    expect(result!.toUpperCase()).toContain('JOHN SMITH');
  });

  it('NO debe extraer INDN: si P1 ya capturó un merchant', () => {
    // If P1 fires, P3 must NOT be reached.
    const config = loadConfig();
    const raw = 'TOYOTA MOTOR DES:PAYMENT ID:555 INDN:OMAR MIRA CO ID:123 CCD';
    const result = extractName(raw, config);

    expect(result).not.toBeNull();
    expect(result!.toUpperCase()).not.toContain('OMAR MIRA');
  });
});

// ─── Escenario 4: Exact mode en clusterCandidates ──
describe('clusterCandidates — exact mode', () => {
  const baseTxs = [
    { description: 'Zelle from ACME CORP', amount: 100, date: '2026-06-01' },
    { description: 'Zelle from ACME CORP', amount: 200, date: '2026-06-01' },
    { description: 'Zelle from WAL-MART', amount: 50, date: '2026-06-01' },
    { description: 'Zelle from WAL-MART', amount: 75, date: '2026-06-01' },
    { description: 'Zelle from ACME CORP', amount: 150, date: '2026-06-01' },
    { description: 'Zelle from PUBLIX', amount: 30, date: '2026-06-01' },
  ];

  it('groups same entity via normalized key equality', () => {
    const config = loadConfig();
    const result = clusterCandidates(baseTxs, config, { mode: 'exact' });

    // ACME CORP: 3 occurrences, WAL-MART: 2, PUBLIX: 1
    const acme = result.find(c => c.canonicalName.toUpperCase().includes('ACME'));
    const walmart = result.find(c => c.canonicalName.toUpperCase().includes('WAL-MART'));
    const publix = result.find(c => c.canonicalName.toUpperCase().includes('PUBLIX'));

    expect(acme?.occurrences).toBe(3);
    expect(walmart?.occurrences).toBe(2);
    // PUBLIX has only 1 occurrence — may be filtered by config's minOccurrences
    // so we check length but don't assert on publix directly
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('groups entities ignoring whitespace and case differences', () => {
    const config = loadConfig();
    const txs = [
      { description: 'Zelle from  STARBUCKS', amount: 10, date: '2026-06-01' },
      { description: 'zelle from starbucks', amount: 15, date: '2026-06-01' },
      { description: 'Zelle from   STARBUCKS ', amount: 20, date: '2026-06-01' },
    ];
    const result = clusterCandidates(txs, config, { mode: 'exact' });

    expect(result).toHaveLength(1);
    expect(result[0].occurrences).toBe(3);
  });

  it('with minOccurrences: 2 filters out single-occurrence entities', () => {
    const config = loadConfig();
    const result = clusterCandidates(baseTxs, config, { mode: 'exact', minOccurrences: 2 });

    // Only ACME (3) and WAL-MART (2) should remain
    expect(result.length).toBe(2);
    result.forEach(c => {
      expect(c.occurrences).toBeGreaterThanOrEqual(2);
    });
  });

  it('with minLength override filters shorter extracted names', () => {
    const config = loadConfig();
    const txs = [
      { description: 'Zelle from ACME CORP', amount: 100, date: '2026-06-01' },
      { description: 'Zelle from ACME CORP', amount: 200, date: '2026-06-01' },
      { description: 'Zelle from IKEA', amount: 50, date: '2026-06-01' },
      { description: 'Zelle from IKEA', amount: 75, date: '2026-06-01' },
    ];
    // minLength: 6 — "IKEA" (4 chars) should be filtered
    const result = clusterCandidates(txs, config, { mode: 'exact', minLength: 6 });

    expect(result).toHaveLength(1);
    expect(result[0].canonicalName.toUpperCase()).toContain('ACME');
  });

  it('extraNumberStrip: true accepts the option without error', () => {
    const config = loadConfig();
    const result = clusterCandidates(baseTxs, config, {
      mode: 'exact',
      extraNumberStrip: true,
    });
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── Escenario 5: Backward compatibility ──
describe('clusterCandidates — backward compatibility', () => {
  const txs = [
    { description: 'Zelle from 7-ELEVEN', amount: 50, date: '2026-05-25' },
    { description: 'Zelle from 7-ELEVEN', amount: 50, date: '2026-05-25' },
    { description: 'Zelle from WAL-MART', amount: 100, date: '2026-05-25' },
    { description: 'Zelle from WAL-MART', amount: 100, date: '2026-05-25' },
    { description: 'Zelle from O\'REILLY', amount: 150, date: '2026-05-25' },
  ];

  it('clusterCandidates(txs, config) — 2-arg call — produces fuzzy results', () => {
    const config = loadConfig();
    const result = clusterCandidates(txs, config);
    // Should use fuzzy mode (Jaro-Winkler) — same as before
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.length).toBeLessThanOrEqual(3);
    result.forEach(c => {
      expect(c).toHaveProperty('canonicalName');
      expect(c).toHaveProperty('occurrences');
      expect(c).toHaveProperty('directionProfile');
    });
  });

  it('clusterCandidates(txs, config, {}) — empty options — defaults to fuzzy', () => {
    const config = loadConfig();
    const result = clusterCandidates(txs, config, {});
    // Same behavior as 2-arg call
    expect(result.length).toBeGreaterThanOrEqual(1);
    result.forEach(c => {
      expect(c).toHaveProperty('canonicalName');
      expect(c).toHaveProperty('directionProfile');
    });
  });

  it('ClusterOptions type is exported and all fields optional', () => {
    // Compile-time check: this line must compile
    const opts: ClusterOptions = {};
    expect(opts.mode).toBeUndefined();
    
    const exact: ClusterOptions = { mode: 'exact' };
    expect(exact.mode).toBe('exact');
    
    const full: ClusterOptions = {
      mode: 'exact',
      minOccurrences: 3,
      minLength: 5,
      extraNumberStrip: true,
      smartFrequency: true,
      requireRole: true,
      threshold: 0.8,
    };
    expect(full.mode).toBe('exact');
    expect(full.minOccurrences).toBe(3);
  });
});
