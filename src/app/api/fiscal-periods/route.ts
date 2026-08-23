import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { companySettingsCache } from '@/lib/cache';
import { serverT } from '@/lib/server-i18n';

export const POST = apiHandler(async (req: NextRequest) => {
  const locale = req.headers.get('x-locale') || 'es';
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);
  const { name, startDate, endDate } = await req.json();

  if (!name || !startDate || !endDate) {
    return NextResponse.json(
      { error: serverT(locale, 'apiErrors.fiscalPeriods.missingFields') },
      { status: 400 },
    );
  }

  const start = new Date(startDate);
  const end = new Date(endDate + 'T23:59:59.999Z');

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

  const period = await db.$transaction(async (tx) => {
    const result = await tx.fiscalPeriod.create({
      data: {
        companyId: companyId,
        name,
        startDate: start,
        endDate: end,
        isLocked: false,
      },
    });

    await tx.auditLog.create({
      data: {
        companyId: companyId,
        action: 'PERIOD_CREATED',
        entity: 'FiscalPeriod',
        entityId: result.id,
        details: JSON.stringify({ name, startDate, endDate }),
      },
    });

    return result;
  });

  companySettingsCache.invalidate(companyId);

  return NextResponse.json({ period });
});
