import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { ForbiddenError, ValidationError } from '@/lib/api-error';

/**
 * PATCH /api/accounting-flow/audit/link
 *
 * Vincula una transacción bancaria conciliada a una línea de asiento contable
 * existente (JournalLine) para evitar el doble conteo en el flujo de caja.
 *
 * Body:
 *   - bankTransactionId: string (requerido)
 *   - journalLineId: string (requerido)
 */
export const PATCH = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await request.json();
  const { bankTransactionId, journalLineId } = body;

  if (!bankTransactionId || !journalLineId) {
    throw new ValidationError('Faltan campos requeridos: bankTransactionId y journalLineId');
  }

  // 1. Obtener la transacción bancaria y verificar su existencia y pertenencia
  const bankTx = await db.bankTransaction.findUnique({
    where: { id: bankTransactionId },
    include: {
      statement: {
        include: {
          bankAccount: true,
        },
      },
    },
  });

  if (!bankTx) {
    throw new ValidationError('Transacción bancaria no encontrada');
  }

  // 3. Verificar que la transacción no esté ya vinculada a otra línea
  if (bankTx.journalLineId) {
    throw new ValidationError('Esta transacción bancaria ya está vinculada a una línea de asiento');
  }

  // 4. Obtener la línea de asiento contable y verificar pertenencia
  const journalLine = await db.journalLine.findUnique({
    where: { id: journalLineId },
    include: {
      entry: true,
    },
  });

  if (!journalLine) {
    throw new ValidationError('Línea de asiento contable no encontrada');
  }

  if (journalLine.entry.companyId !== companyId) {
    throw new ForbiddenError();
  }

  // 5. Vincular de forma atómica
  await db.$transaction(async (tx) => {
    // Verificar si la línea ya fue vinculada por otra transacción bancaria (journalLineId es unique)
    const existingLink = await tx.bankTransaction.findUnique({
      where: { journalLineId },
    });

    if (existingLink) {
      throw new ValidationError(
        'Esta línea de asiento ya está vinculada a otra transacción bancaria',
      );
    }

    await tx.bankTransaction.update({
      where: { id: bankTransactionId },
      data: {
        journalLineId,
      },
    });
  });

  return NextResponse.json({ success: true, message: 'Transacción vinculada correctamente' });
});
