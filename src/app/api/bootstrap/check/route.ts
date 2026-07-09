import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';

export const GET = apiHandler(
  async () => {
    const companyCount = await db.company.count();
    return NextResponse.json({ empty: companyCount === 0 });
  },
  { allowAnonymous: true, requireMembership: false },
);
