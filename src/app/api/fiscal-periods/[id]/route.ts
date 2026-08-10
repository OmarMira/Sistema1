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

  // Si se está desbloqueando, validar que el período esté cubierto por un cierre
  // de ejercicio. La cobertura se decide por la fecha fiscal del asiento de cierre
  // (JournalEntry.date del YEAR_CLOSED), nunca por la hora de ejecución (createdAt).
  if (isLocked === false) {
    const yearClosedLogs = await db.auditLog.findMany({
      where: { companyId, action: 'YEAR_CLOSED' },
      select: { entityId: true },
    });
    if (yearClosedLogs.length > 0) {
      const closingEntries = await db.journalEntry.findMany({
        where: { id: { in: yearClosedLogs.map((l) => l.entityId).filter((id): id is string => !!id) } },
        select: { date: true },
      });
      const coversPeriod = closingEntries.some((ce) => ce.date >= period.endDate);
      if (coversPeriod) {
        return NextResponse.json(
          { error: 'No se puede desbloquear. Existe un cierre de ejercicio posterior.' },
          { status: 400 },
        );
      }
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
