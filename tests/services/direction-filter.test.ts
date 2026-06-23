import { describe, it, expect } from 'vitest';
import { roleIsValidForDirection, DIRECTION_THRESHOLD } from '@/lib/services/direction-filter';

describe('DIRECTION_THRESHOLD', () => {
  it('is set to 80', () => {
    expect(DIRECTION_THRESHOLD).toBe(80);
  });
});

describe('roleIsValidForDirection', () => {
  // ── Pure credit profiles (creditPct >= 80) ──────────────────────
  describe('with pure credit profile (creditPct=85, debitPct=10)', () => {
    const creditProfile = { creditPct: 85, debitPct: 10 };

    it('allows CLIENTE (expects credit)', () => {
      const result = roleIsValidForDirection('CLIENTE', creditProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows INGRESO (expects credit)', () => {
      const result = roleIsValidForDirection('INGRESO', creditProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows INQUILINO (expects credit)', () => {
      const result = roleIsValidForDirection('INQUILINO', creditProfile);
      expect(result).toEqual({ valid: true });
    });

    it('rejects PROVEEDOR (expects debit)', () => {
      const result = roleIsValidForDirection('PROVEEDOR', creditProfile);
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });

    it('rejects EMPLEADO (expects debit)', () => {
      const result = roleIsValidForDirection('EMPLEADO', creditProfile);
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });

    it('rejects GASTO_OPERATIVO (expects debit)', () => {
      const result = roleIsValidForDirection('GASTO_OPERATIVO', creditProfile);
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });

    it('rejects TARJETA_CREDITO (expects debit)', () => {
      const result = roleIsValidForDirection('TARJETA_CREDITO', creditProfile);
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });

    it('rejects PRESTAMO (expects debit)', () => {
      const result = roleIsValidForDirection('PRESTAMO', creditProfile);
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });
  });

  // ── Pure debit profiles (debitPct >= 80) ────────────────────────
  describe('with pure debit profile (creditPct=10, debitPct=90)', () => {
    const debitProfile = { creditPct: 10, debitPct: 90 };

    it('allows PROVEEDOR (expects debit)', () => {
      const result = roleIsValidForDirection('PROVEEDOR', debitProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows EMPLEADO (expects debit)', () => {
      const result = roleIsValidForDirection('EMPLEADO', debitProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows GASTO_OPERATIVO (expects debit)', () => {
      const result = roleIsValidForDirection('GASTO_OPERATIVO', debitProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows TARJETA_CREDITO (expects debit)', () => {
      const result = roleIsValidForDirection('TARJETA_CREDITO', debitProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows PRESTAMO (expects debit)', () => {
      const result = roleIsValidForDirection('PRESTAMO', debitProfile);
      expect(result).toEqual({ valid: true });
    });

    it('rejects CLIENTE (expects credit)', () => {
      const result = roleIsValidForDirection('CLIENTE', debitProfile);
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });

    it('rejects INGRESO (expects credit)', () => {
      const result = roleIsValidForDirection('INGRESO', debitProfile);
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });

    it('rejects INQUILINO (expects credit)', () => {
      const result = roleIsValidForDirection('INQUILINO', debitProfile);
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });
  });

  // ── Ambas (mixed) profile ───────────────────────────────────────
  describe('with mixed profile (creditPct=50, debitPct=50)', () => {
    const mixedProfile = { creditPct: 50, debitPct: 50 };

    it('allows CLIENTE (expects credit)', () => {
      const result = roleIsValidForDirection('CLIENTE', mixedProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows PROVEEDOR (expects debit)', () => {
      const result = roleIsValidForDirection('PROVEEDOR', mixedProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows INGRESO (expects credit)', () => {
      const result = roleIsValidForDirection('INGRESO', mixedProfile);
      expect(result).toEqual({ valid: true });
    });

    it('allows EMPLEADO (expects debit)', () => {
      const result = roleIsValidForDirection('EMPLEADO', mixedProfile);
      expect(result).toEqual({ valid: true });
    });
  });

  // ── Bypass roles (always pass regardless of profile) ────────────
  describe('bypass roles', () => {
    const aggressiveCredit = { creditPct: 95, debitPct: 5 };
    const aggressiveDebit = { creditPct: 5, debitPct: 95 };

    it('allows SOCIO with pure credit', () => {
      expect(roleIsValidForDirection('SOCIO', aggressiveCredit)).toEqual({ valid: true });
    });

    it('allows SOCIO with pure debit', () => {
      expect(roleIsValidForDirection('SOCIO', aggressiveDebit)).toEqual({ valid: true });
    });

    it('allows SOCIO with ambas', () => {
      expect(roleIsValidForDirection('SOCIO', { creditPct: 50, debitPct: 50 })).toEqual({ valid: true });
    });

    it('allows OTRO with pure credit', () => {
      expect(roleIsValidForDirection('OTRO', aggressiveCredit)).toEqual({ valid: true });
    });

    it('allows OTRO with pure debit', () => {
      expect(roleIsValidForDirection('OTRO', aggressiveDebit)).toEqual({ valid: true });
    });

    it('allows IGNORADA with pure credit', () => {
      expect(roleIsValidForDirection('IGNORADA', aggressiveCredit)).toEqual({ valid: true });
    });

    it('allows IGNORADA with pure debit', () => {
      expect(roleIsValidForDirection('IGNORADA', aggressiveDebit)).toEqual({ valid: true });
    });
  });

  // ── Threshold boundary test (79% vs 80%) ────────────────────────
  describe('threshold boundary at 80%', () => {
    it('treats 79% credit as ambas (not pure credit)', () => {
      const result = roleIsValidForDirection('PROVEEDOR', { creditPct: 79, debitPct: 21 });
      // At 79% it's "ambas" — PROVEEDOR (debit) should be allowed
      expect(result).toEqual({ valid: true });
    });

    it('treats 80% credit as pure credit', () => {
      const result = roleIsValidForDirection('PROVEEDOR', { creditPct: 80, debitPct: 20 });
      // At 80% it's pure credit — PROVEEDOR (debit) should be rejected
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });

    it('treats 79% debit as ambas (not pure debit)', () => {
      const result = roleIsValidForDirection('CLIENTE', { creditPct: 21, debitPct: 79 });
      // At 79% it's "ambas" — CLIENTE (credit) should be allowed
      expect(result).toEqual({ valid: true });
    });

    it('treats 80% debit as pure debit', () => {
      const result = roleIsValidForDirection('CLIENTE', { creditPct: 20, debitPct: 80 });
      // At 80% it's pure debit — CLIENTE (credit) should be rejected
      expect(result).toMatchObject({ valid: false });
      expect(result.reason).toBeTruthy();
    });
  });
});
