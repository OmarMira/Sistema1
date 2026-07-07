import { db } from './db';
import { ForbiddenError } from './api-error';
import type { PrismaClient } from '@prisma/client';

/**
 * Lanza un error ForbiddenError si la fecha proporcionada cae dentro de un período fiscal cerrado/bloqueado.
 * Acepta un transaction client opcional para evitar TOCTOU races dentro de transacciones.
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
    return;
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
