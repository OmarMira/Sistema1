import { db } from './db';
import { ForbiddenError, ValidationError } from './api-error';
import type { PrismaClient } from '@prisma/client';

/**
 * Lanza un error si la fecha proporcionada no es contabilizable según los
 * períodos fiscales de la empresa. Acepta un transaction client opcional para
 * evitar TOCTOU races dentro de transacciones.
 *
 * Contrato (revisión del propietario: se procesan datos históricos de
 * años anteriores):
 *  1. Una fecha no parseable (NaN) se rechaza con ValidationError (fail-closed):
 *     si no se puede determinar el período, no se puede verificar el bloqueo.
 *  2. Una fecha dentro de un período bloqueado se rechaza con ForbiddenError.
 *  3. Una fecha FUERA de todo período fiscal se PERMITE: el sistema procesa
 *     datos históricos regulares; los períodos del onboarding no cubren años
 *     pasados y bloquear esos movimientos sería incorrecto.
 *  4. El resto del sistema conserva sus protecciones (conciliación, validaciones
 *     de importación).
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
      `Fecha de transacción inválida: "${String(date)}". No se puede verificar la restricción del período fiscal, por lo que la transacción es rechazada.`,
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
      `No se pueden registrar transacciones en un período cerrado. Período bloqueado: "${lockedPeriod.name}".`,
    );
  }

  // Fechas fuera de todo período fiscal se PERMITEN: el sistema procesa
  // regularmente datos históricos de años anteriores a los períodos
  // configurados en la configuración inicial (decisión del propietario).
  // La protección contable es no tocar períodos CERRADOS.
  return;
}
