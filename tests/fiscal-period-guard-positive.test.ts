/**
 * S19(b) — Fiscal guard positive check.
 *
 * Before this change `assertActiveFiscalPeriod` only blocked a date covered by
 * a LOCKED period: a date that fell in no period at all (a gap between periods,
 * or outside the configured range) silently passed.
 *
 * New contract, pinned here:
 *   - when the company has at least one FiscalPeriod row, a date outside every
 *     period is rejected with a ValidationError (400),
 *   - a date inside an open period passes,
 *   - a date inside a locked period is still blocked (ForbiddenError, 403),
 *   - a company with ZERO FiscalPeriod rows keeps the legacy allow behavior,
 *   - an unparseable date is still rejected (fail-closed, S9).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { ForbiddenError, ValidationError } from '@/lib/api-error';
import { db } from '@/lib/db';
import { createTestCompany, clearDatabase } from './helpers/factories';

async function addPeriod(
  companyId: string,
  name: string,
  startDate: string,
  endDate: string,
  isLocked = false,
) {
  return db.fiscalPeriod.create({
    data: { companyId, name, startDate: new Date(startDate), endDate: new Date(endDate), isLocked },
  });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('S19(b) — guard fiscal con chequeo positivo de período', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('rechaza una fecha que no cae en ningún período cuando la empresa tiene períodos', async () => {
    const company = await createTestCompany('S19b Gap Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    const error = await captureError(assertActiveFiscalPeriod(company.id, '2026-08-15'));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).statusCode).toBe(400);
    expect((error as ValidationError).code).toBe('VALIDATION_ERROR');
    expect((error as ValidationError).message).toContain('2026-08-15');
    expect((error as ValidationError).message).toMatch(/outside every fiscal period/i);
  });

  it('rechaza una fecha que cae en el hueco entre dos períodos', async () => {
    const company = await createTestCompany('S19b Between Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    await addPeriod(company.id, 'August 2026', '2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z');

    const error = await captureError(assertActiveFiscalPeriod(company.id, '2026-07-10'));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toMatch(/outside every fiscal period/i);
  });

  it('rechaza una fecha anterior al primer período', async () => {
    const company = await createTestCompany('S19b Before Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // One millisecond before the period starts.
    await expect(
      assertActiveFiscalPeriod(company.id, '2026-05-31T23:59:59.999Z'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('no crea ni modifica períodos al rechazar por hueco', async () => {
    const company = await createTestCompany('S19b NoWrite Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    await expect(assertActiveFiscalPeriod(company.id, '2026-08-15')).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(await db.fiscalPeriod.count({ where: { companyId: company.id } })).toBe(1);
  });

  // ── PRESERVE: comportamiento previo del código modificado ─────────────
  it('PRESERVE: permite una fecha dentro de un período abierto', async () => {
    const company = await createTestCompany('S19b Open Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    await expect(assertActiveFiscalPeriod(company.id, '2026-06-15')).resolves.toBeUndefined();
  });

  it('PRESERVE: permite los extremos exactos del período abierto', async () => {
    const company = await createTestCompany('S19b Bounds Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    await expect(assertActiveFiscalPeriod(company.id, '2026-06-01')).resolves.toBeUndefined();
    await expect(
      assertActiveFiscalPeriod(company.id, '2026-06-30T23:59:59.999Z'),
    ).resolves.toBeUndefined();
  });

  it('PRESERVE: bloquea una fecha dentro de un período bloqueado', async () => {
    const company = await createTestCompany('S19b Locked Co');
    await addPeriod(company.id, 'May 2026', '2026-05-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z', true);

    const error = await captureError(assertActiveFiscalPeriod(company.id, '2026-05-15'));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).statusCode).toBe(403);
    expect((error as ForbiddenError).message).toBe(
      'Cannot post transactions to a closed period. Period locked: "May 2026".',
    );
  });

  it('PRESERVE: un período bloqueado gana sobre un hueco (fecha fuera de todo período)', async () => {
    const company = await createTestCompany('S19b Locked Gap Co');
    await addPeriod(company.id, 'May 2026', '2026-05-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z', true);
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // Inside the locked period → still 403 (unchanged).
    await expect(assertActiveFiscalPeriod(company.id, '2026-05-15')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Inside the open period → allowed.
    await expect(assertActiveFiscalPeriod(company.id, '2026-06-15')).resolves.toBeUndefined();
    // Outside every period → rejected without creating anything.
    await expect(assertActiveFiscalPeriod(company.id, '2026-09-01')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('PRESERVE: una empresa sin períodos fiscales conserva el comportamiento legacy', async () => {
    const company = await createTestCompany('S19b Legacy Co');

    await expect(assertActiveFiscalPeriod(company.id, '2026-08-15')).resolves.toBeUndefined();
    await expect(assertActiveFiscalPeriod(company.id, '1999-01-01')).resolves.toBeUndefined();
  });

  it('PRESERVE: una fecha inválida sigue rechazándose aunque la empresa tenga períodos', async () => {
    const company = await createTestCompany('S19b Invalid Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    const error = await captureError(assertActiveFiscalPeriod(company.id, 'not-a-date'));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(
      'Invalid transaction date: "not-a-date". Fiscal period lock cannot be verified, so the transaction is rejected.',
    );
  });

  it('acepta un Date y aplica el mismo chequeo positivo', async () => {
    const company = await createTestCompany('S19b DateObj Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    await expect(
      assertActiveFiscalPeriod(company.id, new Date('2026-06-10T12:00:00.000Z')),
    ).resolves.toBeUndefined();
    await expect(
      assertActiveFiscalPeriod(company.id, new Date('2026-09-10T12:00:00.000Z')),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
