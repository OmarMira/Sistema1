import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const auditLogs = await db.auditLog.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
        company: {
          select: {
            id: true,
            legalName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100, // Limit to last 100 logs for performance
    });

    return NextResponse.json({ auditLogs });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
