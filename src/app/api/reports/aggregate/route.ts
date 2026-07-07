import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';
import { toUTCRange } from '@/lib/reports/date-filter';
import { aggregateFinancialData } from '@/lib/reports/aggregation';

export const GET = apiHandler(async (req: NextRequest) => {
  const { companyId } = requireCompanyContext();

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');
  const startDateStr = searchParams.get('startDate');
  const endDateStr = searchParams.get('endDate');

  if (!type) {
    return NextResponse.json({ error: 'companyId y type son requeridos' }, { status: 400 });
  }

  try {
    const { startDate, endDate } = toUTCRange(startDateStr, endDateStr);
    const data = await aggregateFinancialData(companyId, startDate, endDate, type);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
});
