/**
 * Guard fiscal — contrato tras la revisión del propietario (datos históricos).
 *
 * El sistema procesa regularmente extractos de AÑOS ANTERIORES a los períodos
 * configurados en la configuración inicial, por lo que bloquear una fecha
 * fuera de todo período fiscal era incorrecto (decisión del propietario,
 * verbatim: "recorda que el sistema no siempre esta procesando datos actuales
 * puede procesar datos de años anteriores").
 *
 * Contrato vigente, fijado aquí:
 *   - una fecha dentro de un período ABIERTO pasa,
 *   - una fecha FUERA de todo período (hueco, año histórico, futuro) pasa,
 *   - una fecha dentro de un período BLOQUEADO se rechaza (403),
 *   - una empresa sin períodos se comporta como antes (permite),
 *   - una fecha no parseable se rechaza (fail-closed, en español).
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

describe('guard fiscal — fechas históricas permitidas, períodos cerrados bloqueados', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('permite una fecha de AÑO ANTERIOR a los períodos configurados (dato histórico)', async () => {
    const company = await createTestCompany('Historic Import Co');
    await addPeriod(company.id, 'Ejercicio 2026', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z');

    // Extracto bancario de 2024: dato histórico regular, debe importarse.
    await expect(assertActiveFiscalPeriod(company.id, '2024-03-15')).resolves.toBeUndefined();
    // También una fecha futura fuera del rango configurado.
    await expect(assertActiveFiscalPeriod(company.id, '2028-08-15')).resolves.toBeUndefined();
  });

  it('permite una fecha que cae en el hueco entre dos períodos', async () => {
    const company = await createTestCompany('Historic Gap Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    await addPeriod(company.id, 'August 2026', '2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z');

    await expect(assertActiveFiscalPeriod(company.id, '2026-07-10')).resolves.toBeUndefined();
  });

  it('no crea ni modifica períodos al validar', async () => {
    const company = await createTestCompany('Historic NoWrite Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    await expect(assertActiveFiscalPeriod(company.id, '2024-08-15')).resolves.toBeUndefined();

    expect(await db.fiscalPeriod.count({ where: { companyId: company.id } })).toBe(1);
  });

  // ── PRESERVE: comportamiento previo del código modificado ─────────────
  it('PRESERVE: permite una fecha dentro de un período abierto', async () => {
    const company = await createTestCompany('Historic Open Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    await expect(assertActiveFiscalPeriod(company.id, '2026-06-15')).resolves.toBeUndefined();
  });

  it('PRESERVE: permite los extremos exactos del período abierto', async () => {
    const company = await createTestCompany('Historic Bounds Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    await expect(assertActiveFiscalPeriod(company.id, '2026-06-01')).resolves.toBeUndefined();
    await expect(
      assertActiveFiscalPeriod(company.id, '2026-06-30T23:59:59.999Z'),
    ).resolves.toBeUndefined();
  });

  it('PRESERVE: bloquea una fecha dentro de un período bloqueado (en español)', async () => {
    const company = await createTestCompany('Historic Locked Co');
    await addPeriod(company.id, 'May 2026', '2026-05-01T00:00:00.000Z', '2026-05-31T23:59:59.999Z', true);

    const error = await captureError(assertActiveFiscalPeriod(company.id, '2026-05-15'));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).statusCode).toBe(403);
    expect((error as ForbiddenError).message).toBe(
      'No se pueden registrar transacciones en un período cerrado. Período bloqueado: "May 2026".',
    );
  });

  it('PRESERVE: un período bloqueado gana sobre una fecha histórica que cae dentro de él', async () => {
    const company = await createTestCompany('Historic Locked Gap Co');
    await addPeriod(company.id, 'May 2024', '2024-05-01T00:00:00.000Z', '2024-05-31T23:59:59.999Z', true);
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // Dentro del período bloqueado de 2024 → 403 aunque sea "dato histórico".
    await expect(assertActiveFiscalPeriod(company.id, '2024-05-15')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Dentro del período abierto → permitido.
    await expect(assertActiveFiscalPeriod(company.id, '2026-06-15')).resolves.toBeUndefined();
    // Fuera de todo período → permitido (dato histórico).
    await expect(assertActiveFiscalPeriod(company.id, '2024-01-01')).resolves.toBeUndefined();
  });

  it('PRESERVE: una empresa sin períodos fiscales se comporta como antes', async () => {
    const company = await createTestCompany('Historic Legacy Co');

    await expect(assertActiveFiscalPeriod(company.id, '2026-08-15')).resolves.toBeUndefined();
    await expect(assertActiveFiscalPeriod(company.id, '1999-01-01')).resolves.toBeUndefined();
  });

  it('PRESERVE: una fecha inválida sigue rechazándose (fail-closed, en español)', async () => {
    const company = await createTestCompany('Historic Invalid Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    const error = await captureError(assertActiveFiscalPeriod(company.id, 'not-a-date'));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe(
      'Fecha de transacción inválida: "not-a-date". No se puede verificar la restricción del período fiscal, por lo que la transacción es rechazada.',
    );
  });

  it('acepta un objeto Date y aplica el mismo contrato', async () => {
    const company = await createTestCompany('Historic DateObj Co');
    await addPeriod(company.id, 'June 2026', '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    await expect(
      assertActiveFiscalPeriod(company.id, new Date('2026-06-10T12:00:00.000Z')),
    ).resolves.toBeUndefined();
    await expect(
      assertActiveFiscalPeriod(company.id, new Date('2024-09-10T12:00:00.000Z')),
    ).resolves.toBeUndefined();
  });
});
