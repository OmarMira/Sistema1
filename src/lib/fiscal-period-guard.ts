import { db } from './db';
import { ForbiddenError, ValidationError } from './api-error';
import type { PrismaClient } from '@prisma/client';

/**
 * Lanza un error si la fecha proporcionada no es contabilizable según los
 * períodos fiscales de la empresa. Acepta un transaction client opcional para
 * evitar TOCTOU races dentro de transacciones.
 *
 * Contrato (S19b, chequeo positivo):
 *  1. Una fecha no parseable (NaN) se rechaza con ValidationError (fail-closed):
 *     si no se puede determinar el período, no se puede verificar el bloqueo.
 *  2. Una fecha dentro de un período bloqueado se rechaza con ForbiddenError.
 *  3. Si la empresa TIENE períodos fiscales, la fecha debe caer dentro de
 *     alguno de ellos; una fecha fuera de todo período (hueco entre períodos o
 *     fuera del rango configurado) se rechaza con ValidationError.
 *  4. Una empresa SIN períodos fiscales conserva el comportamiento histórico
 *     (se permite): instalaciones legacy siguen operando como antes.
 */
export async function assertActiveFiscalPeriod(
  companyId: string,
  date: Date | string | number,
  tx?:
    | PrismaClient
    | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
): Promise<void> {
  const checkDate = new Date(date);
  if (isNaN(checkDate.getTime())) {
    throw new ValidationError(
      `Invalid transaction date: "${String(date)}". Fiscal period lock cannot be verified, so the transaction is rejected.`,
    );
  }

  const client = tx || db;

  // 1. Período bloqueado que cubre la fecha → rechazo (contrato sin cambios).
  const lockedPeriod = await (client as typeof db).fiscalPeriod.findFirst({
    where: {
      companyId,
      startDate: { lte: checkDate },
      endDate: { gte: checkDate },
      isLocked: true,
    },
  });

  if (lockedPeriod) {
    throw new ForbiddenError(
      `Cannot post transactions to a closed period. Period locked: "${lockedPeriod.name}".`,
    );
  }

  // 2. Chequeo positivo: la fecha debe estar cubierta por algún período.
  const coveringPeriod = await (client as typeof db).fiscalPeriod.findFirst({
    where: {
      companyId,
      startDate: { lte: checkDate },
      endDate: { gte: checkDate },
    },
    select: { id: true },
  });

  if (coveringPeriod) return;

  // 3. …pero solo cuando la empresa define períodos fiscales.
  const anyPeriod = await (client as typeof db).fiscalPeriod.findFirst({
    where: { companyId },
    select: { id: true },
  });

  if (!anyPeriod) return; // sin períodos configurados: comportamiento legacy

  throw new ValidationError(
    `Transaction date "${checkDate.toISOString().slice(0, 10)}" is outside every fiscal period of this company. Create or extend a fiscal period covering it before posting.`,
  );
}
