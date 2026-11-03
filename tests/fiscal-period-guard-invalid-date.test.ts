/**
 * S9 — Fiscal guard must fail CLOSED on unparseable dates.
 *
 * Before this change `assertActiveFiscalPeriod` returned silently when
 * `new Date(date)` was NaN, so an entry with an invalid date bypassed period
 * locking entirely. These tests pin:
 *   - invalid dates are rejected (ValidationError / 400) BEFORE any Prisma read,
 *   - valid dates inside a locked period are still blocked (preserved),
 *   - valid dates with no locked period (open period or the documented
 *     gap-between-periods limitation) still pass (preserved).
 *
 * DB-free: `@/lib/db` is mocked, so no PostgreSQL fixture is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: {
    fiscalPeriod: { findFirst },
  },
}));

import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { ValidationError } from '@/lib/api-error';

describe('assertActiveFiscalPeriod — invalid date is fail-closed (S9)', () => {
  beforeEach(() => {
    findFirst.mockReset();
    findFirst.mockResolvedValue(null);
  });

  it('rejects an unparseable date string instead of silently passing', async () => {
    await expect(assertActiveFiscalPeriod('company-1', 'not-a-date')).rejects.toThrow(
      'Invalid transaction date: "not-a-date"',
    );
  });

  it('rejects an invalid date with a 400 ValidationError (no lock bypass)', async () => {
    const error = await assertActiveFiscalPeriod('company-1', 'not-a-date').then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).statusCode).toBe(400);
    expect((error as ValidationError).code).toBe('VALIDATION_ERROR');
  });

  it('does not query fiscal periods for an invalid date', async () => {
    await expect(assertActiveFiscalPeriod('company-1', 'not-a-date')).rejects.toThrow();

    expect(findFirst, 'no Prisma read for an unparseable date').not.toHaveBeenCalled();
  });

  it('rejects a NaN numeric date', async () => {
    await expect(assertActiveFiscalPeriod('company-1', Number.NaN)).rejects.toThrow(
      'Invalid transaction date',
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('rejects an empty-string date', async () => {
    await expect(assertActiveFiscalPeriod('company-1', '')).rejects.toThrow(
      'Invalid transaction date',
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  // ── PRESERVE: existing valid-date behavior of the modified code ──────────
  it('still blocks a valid date inside a locked period', async () => {
    findFirst.mockResolvedValue({ name: 'May 2026' });

    await expect(assertActiveFiscalPeriod('company-1', '2026-05-15')).rejects.toThrow(
      'Cannot post transactions to a closed period. Period locked: "May 2026".',
    );

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: {
        companyId: 'company-1',
        isLocked: true,
      },
    });
  });

  it('still allows a valid date with no locked period (open period / gap limitation)', async () => {
    await expect(assertActiveFiscalPeriod('company-1', '2026-06-15')).resolves.toBeUndefined();
    // S19b added the positive period check, so the guard performs more than one
    // fiscalPeriod read (locked coverage → coverage → any-period). Assert the
    // reads stay company-scoped instead of pinning an internal call count.
    expect(findFirst).toHaveBeenCalled();
    for (const [args] of findFirst.mock.calls) {
      expect(args.where.companyId).toBe('company-1');
    }
  });
});
