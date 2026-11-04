import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { requireCompanyRole } from '@/lib/rbac';
import { db } from '@/lib/db';
import { getPeriodStrategy } from '@/lib/fiscal-period/strategies';
import { fiscalConfigSchema } from '@/lib/fiscal-period/types';
import { serverT } from '@/lib/server-i18n';

export const POST = apiHandler(async (req: NextRequest) => {
  const locale = req.headers.get('x-locale') || 'es';
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);
  await requireModuleEntitlement('accounting');
  const { year, config } = await req.json();
  const validated = fiscalConfigSchema.parse(config);
  const strategy = getPeriodStrategy(validated.type);
  const calculated = strategy.calculate({ year, config: validated });

  // ⚠️ VALIDACIÓN Y ESCRITURA EN LA MISMA TRANSACCIÓN (S5)
  //
  // El chequeo de solapamiento vivía FUERA de la transacción de inserción: dos
  // generaciones concurrentes leían ambas la tabla vacía, ambas pasaban el
  // chequeo y la perdedora moría en el índice único (companyId, name) con un 400
  // genérico. El lock de asesoría (advisory lock transaccional) serializa
  // "chequear + insertar" por empresa: la segunda petición espera el commit de la
  // primera, ve sus períodos y responde 409 con el mensaje de conflicto.
  const created = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fiscal-periods:generate:${companyId}`}, 0))`;

    const existing = await tx.fiscalPeriod.findMany({
      where: { companyId },
      select: { name: true, startDate: true, endDate: true },
    });
    const conflict = calculated.find((p) =>
      existing.some(
        (e) => e.name === p.name || !(p.endDate < e.startDate || p.startDate > e.endDate),
      ),
    );
    if (conflict) return null;

    return Promise.all(
      calculated.map(({ isShort, ...p }) =>
        tx.fiscalPeriod.create({ data: { companyId, ...p } }),
      ),
    );
  });

  if (!created)
    return NextResponse.json(
      { error: serverT(locale, 'apiErrors.fiscalPeriods.conflict') },
      { status: 409 },
    );

  await db.auditLog.create({
    data: {
      companyId,
      action: 'PERIODS_GENERATED',
      entity: 'FiscalPeriod',
      details: JSON.stringify({ year, count: created.length }),
    },
  });
  return NextResponse.json({ periods: created });
});
