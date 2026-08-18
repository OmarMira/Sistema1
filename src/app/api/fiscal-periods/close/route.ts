import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { executeYearClose } from '@/lib/services/closing-engine';
import { fiscalConfigSchema } from '@/lib/fiscal-period/types';
import { logger } from '@/lib/logger';

export const POST = apiHandler(async (req: NextRequest) => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);
  const { year, config } = await req.json();

  if (!year || !config) {
    return NextResponse.json({ error: 'Faltan parámetros requeridos' }, { status: 400 });
  }

  const validatedConfig = fiscalConfigSchema.parse(config);

  try {
    const result = await executeYearClose(companyId, year, validatedConfig);
    return NextResponse.json(result);
  } catch (error: unknown) {
    logger.error('[YEAR CLOSE API ERROR]', { errorName: error instanceof Error ? error.name : 'UnknownError' });
    return NextResponse.json(
      { error: 'Error al cerrar el período fiscal' },
      { status: 500 },
    );
  }
});
