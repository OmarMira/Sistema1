import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { companySettingsCache } from '@/lib/cache';
import { serverT } from '@/lib/server-i18n';
import { validateRequest } from '@/lib/validate-request';

const CreateFiscalPeriodSchema = z.object({
  name: z.string().min(1),
  startDate: z.string().refine((v) => {
    const match = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const [, y, m, d] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 && date.getDate() === Number(d);
  }, 'Invalid date'),
  endDate: z.string().refine((v) => {
    const match = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const [, y, m, d] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 && date.getDate() === Number(d);
  }, 'Invalid date'),
});

export const POST = apiHandler(async (req: NextRequest) => {
  const locale = req.headers.get('x-locale') || 'es';
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);

  const validated = await validateRequest(req, CreateFiscalPeriodSchema);
  if (validated instanceof NextResponse) return validated;

  const { name, startDate, endDate } = validated;

  const start = new Date(startDate);
  const end = new Date(endDate + 'T23:59:59.999Z');

  const period = await db.$transaction(async (tx) => {
    // Overlap check INSIDE transaction to prevent TOCTOU race condition
    const existing = await tx.fiscalPeriod.findMany({ where: { companyId: companyId } });
    const overlap = existing.some((e) => !(end < e.startDate || start > e.endDate));
    if (overlap) {
      throw new Error('OVERLAP');
    }

    const nameExists = existing.some((e) => e.name === name);
    if (nameExists) {
      throw new Error('DUPLICATE_NAME');
    }

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
  }).catch((err) => {
    if (err instanceof Error && err.message === 'OVERLAP') {
      return NextResponse.json(
        { error: serverT(locale, 'apiErrors.fiscalPeriods.overlap') },
        { status: 409 },
      );
    }
    if (err instanceof Error && err.message === 'DUPLICATE_NAME') {
      return NextResponse.json(
        { error: serverT(locale, 'apiErrors.fiscalPeriods.duplicateName') },
        { status: 409 },
      );
    }
    throw err;
  });

  // If the transaction returned a NextResponse (error), return it directly
  if (period instanceof NextResponse) return period;

  companySettingsCache.invalidate(companyId);

  return NextResponse.json({ period });
});
