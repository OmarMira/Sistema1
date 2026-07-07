import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { db } from '@/lib/db';
import { companySettingsCache } from '@/lib/cache';

export const POST = apiHandler(async (req: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  const { id } = (await context.params) as { id: string };

  const period = await db.fiscalPeriod.findFirst({ where: { id, companyId } });
  if (!period) {
    return NextResponse.json({ error: 'Period not found' }, { status: 404 });
  }

  if (period.isLocked) {
    return NextResponse.json({ error: 'Period is already locked' }, { status: 400 });
  }

  const updated = await db.fiscalPeriod.update({
    where: { id },
    data: { isLocked: true },
  });

  // Invalidate cache
  companySettingsCache.invalidate(companyId);

  // Create audit log entry
  await db.auditLog.create({
    data: {
      companyId,
      action: 'PERIOD_LOCKED',
      entity: 'FiscalPeriod',
      entityId: id,
    },
  });

  return NextResponse.json({ period: updated });
});
