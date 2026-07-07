import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { executeYearClose } from '@/lib/services/closing-engine';
import { fiscalConfigSchema } from '@/lib/fiscal-period/types';
import { logger } from '@/lib/logger';

export const POST = apiHandler(async (req: NextRequest) => {
  const { companyId } = requireCompanyContext();
  const { year, config } = await req.json();

  if (!year || !config) {
    return NextResponse.json({ error: 'Faltan parámetros requeridos' }, { status: 400 });
  }

  const validatedConfig = fiscalConfigSchema.parse(config);

  try {
    const result = await executeYearClose(companyId, year, validatedConfig);
    return NextResponse.json(result);
  } catch (error: unknown) {
    logger.error('[YEAR CLOSE API ERROR]', { error: String(error) });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
