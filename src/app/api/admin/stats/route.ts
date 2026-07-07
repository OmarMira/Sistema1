import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const [companiesCount, usersCount, logsCount] = await Promise.all([
      db.company.count(),
      db.user.count(),
      db.auditLog.count(),
    ]);

    return NextResponse.json({
      companiesCount,
      usersCount,
      logsCount,
    });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
