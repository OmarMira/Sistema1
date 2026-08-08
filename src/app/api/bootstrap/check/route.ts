import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';

export const GET = apiHandler(
  async () => {
    const [companyCount, userCount] = await Promise.all([
      db.company.count(),
      db.user.count(),
    ]);
    return NextResponse.json({ empty: companyCount === 0, hasUsers: userCount > 0 });
  },
  { allowAnonymous: true, requireMembership: false },
);
