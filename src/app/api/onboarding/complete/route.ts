import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { completeOnboarding } from '@/lib/services/onboarding.service';
import { onboardingPayloadSchema } from '@/lib/validations/onboarding';
import { handleRouteError } from '@/lib/route-error-handler';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    // 2. Parsear el body de la petición
    const body = await request.json();

    // 3. Mapeo inteligente y tolerante (Retrocompatibilidad total con Wizard viejo y nuevo)
    const rawLegalName = body.legalName || 'LQ & OM LLC';
    const rawCurrency = body.currency || 'USD';

    // Normalizar mes
    let rawMonth = 1;
    if (body.fiscalYearStartMonth !== undefined) {
      rawMonth = parseInt(body.fiscalYearStartMonth, 10);
    } else if (body.fiscalYearStartMonth === undefined && body.fiscalMonth !== undefined) {
      rawMonth = parseInt(body.fiscalMonth, 10);
    }

    // Normalizar año
    let rawYear = 2025;
    if (body.fiscalYearStartYear !== undefined) {
      rawYear = parseInt(body.fiscalYearStartYear, 10);
    } else if (body.fiscalYearStartYear === undefined && body.fiscalYear !== undefined) {
      rawYear = parseInt(body.fiscalYear, 10);
    }

    const rawPeriodType = body.periodType || 'CALENDAR';
    const rawInitialBalance =
      body.initialCashBalance !== undefined ? parseFloat(body.initialCashBalance) : 0;

    const payload = {
      companyId,
      legalName: rawLegalName,
      currency: rawCurrency,
      fiscalYearStartMonth: rawMonth,
      fiscalYearStartYear: rawYear,
      periodType: rawPeriodType,
      initialCashBalance: rawInitialBalance,
    };

    // 4. Validar con Zod
    const validation = onboardingPayloadSchema.safeParse(payload);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Datos de validación inválidos', details: validation.error.format() },
        { status: 400 },
      );
    }

    const {
      legalName,
      currency,
      fiscalYearStartMonth,
      fiscalYearStartYear,
      periodType,
      initialCashBalance,
    } = validation.data;

    // 5. Verificar rol del usuario y membresía administrativa en la compañía
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });

    let isAuthorized = false;

    if (user?.platformRole === 'super_admin') {
      isAuthorized = true;
    } else {
      const membership = await db.companyMember.findFirst({
        where: {
          userId,
          companyId,
          role: 'company_admin', // solo admins pueden realizar onboarding
        },
      });
      if (membership) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { error: 'Acceso denegado: Se requieren privilegios de administrador' },
        { status: 403 },
      );
    }

    // 6. Ejecutar el servicio de onboarding robusto
    const result = await completeOnboarding(
      companyId,
      legalName,
      currency,
      fiscalYearStartMonth,
      fiscalYearStartYear,
      periodType,
      initialCashBalance,
      userId,
    );

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, '[API ONBOARDING COMPLETE ERROR]');
  }
});
