import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { db } from '@/lib/db';
import { companySettingsCache } from '@/lib/cache';

export const PATCH = apiHandler(async (req: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  const { id } = (await context.params) as { id: string };
  const { isLocked } = await req.json();

  if (isLocked === undefined) {
    return NextResponse.json({ error: 'Campos requeridos faltantes' }, { status: 400 });
  }

  const period = await db.fiscalPeriod.findFirst({ where: { id, companyId } });
  if (!period) {
    return NextResponse.json({ error: 'Period not found' }, { status: 404 });
  }

  // Si se está desbloqueando, validar que no haya un cierre de ejercicio posterior
  if (isLocked === false) {
    const yearClosed = await db.auditLog.findFirst({
      where: {
        companyId,
        action: 'YEAR_CLOSED',
        createdAt: { gte: period.endDate },
      },
    });
    if (yearClosed) {
      return NextResponse.json(
        { error: 'No se puede desbloquear. Existe un cierre de ejercicio posterior.' },
        { status: 400 },
      );
    }
  }

  const updated = await db.fiscalPeriod.update({
    where: { id },
    data: { isLocked },
  });

  // Invalidar caché
  companySettingsCache.invalidate(companyId);

  await db.auditLog.create({
    data: {
      companyId,
      action: isLocked ? 'PERIOD_LOCKED' : 'PERIOD_UNLOCKED',
      entity: 'FiscalPeriod',
      entityId: id,
    },
  });

  return NextResponse.json({ period: updated });
});
