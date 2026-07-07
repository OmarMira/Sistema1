import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { db } from '@/lib/db';
import { getMetricsSummary } from '@/lib/metrics';

export const GET = apiHandler(
  async (request: NextRequest) => {
    requireCompanyContext();
    return NextResponse.json(getMetricsSummary());
  },
  { requireSuperAdmin: true },
);
