import { db } from './db';
import { ForbiddenError, ValidationError } from './api-error';
import type { PrismaClient } from '@prisma/client';

/**
 * Lanza un error si la fecha proporcionada cae dentro de un período fiscal cerrado/bloqueado.
 * Acepta un transaction client opcional para evitar TOCTOU races dentro de transacciones.
 *
 * Fail-closed: una fecha no parseable (NaN) se rechaza con ValidationError en lugar de
 * dejar pasar la transacción — si no se puede determinar el período, no se puede verificar
 * el bloqueo. Las fechas que caen en el hueco entre períodos y las empresas sin
 * FiscalPeriod siguen permitiéndose (limitación documentada).
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
}
