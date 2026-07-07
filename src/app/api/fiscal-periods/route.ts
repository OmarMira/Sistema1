import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';
import { companySettingsCache } from '@/lib/cache';
import { serverT } from '@/lib/server-i18n';

export const POST = apiHandler(async (req: NextRequest) => {
  const locale = req.headers.get('x-locale') || 'es';
  const { companyId } = requireCompanyContext();
  const { name, startDate, endDate } = await req.json();

  if (!name || !startDate || !endDate) {
    return NextResponse.json(
      { error: serverT(locale, 'apiErrors.fiscalPeriods.missingFields') },
      { status: 400 },
    );
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  const existing = await db.fiscalPeriod.findMany({ where: { companyId: companyId } });
  const overlap = existing.some((e) => !(end < e.startDate || start > e.endDate));
  if (overlap) {
    return NextResponse.json(
      { error: serverT(locale, 'apiErrors.fiscalPeriods.overlap') },
      { status: 409 },
    );
  }

  const nameExists = existing.some((e) => e.name === name);
  if (nameExists) {
    return NextResponse.json(
      { error: serverT(locale, 'apiErrors.fiscalPeriods.duplicateName') },
      { status: 409 },
    );
  }

  const period = await db.fiscalPeriod.create({
    data: {
      companyId: companyId,
      name,
      startDate: start,
      endDate: end,
      isLocked: false,
    },
  });

  // Invalidar caché
  companySettingsCache.invalidate(companyId);

  await db.auditLog.create({
    data: {
      companyId: companyId,
      action: 'PERIOD_CREATED',
      entity: 'FiscalPeriod',
      entityId: period.id,
      details: JSON.stringify({ name, startDate, endDate }),
    },
  });

  return NextResponse.json({ period });
});
