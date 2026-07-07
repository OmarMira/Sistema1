import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { getVarianceReport } from '@/lib/budget/engine';
import { requireCompanyContext } from '@/lib/context-storage';
import { db } from '@/lib/db';

export const GET = apiHandler(async (req: NextRequest) => {
  const { companyId } = requireCompanyContext();

  const { searchParams } = new URL(req.url);
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString(), 10);
  const month = parseInt(searchParams.get('month') || (new Date().getMonth() + 1).toString(), 10);

  const report = await getVarianceReport(companyId, year, month);

  return NextResponse.json({
    period: `${year}-${month}`,
    data: report,
    generatedAt: new Date().toISOString(),
  });
});
