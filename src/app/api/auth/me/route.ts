import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { getRequestContext } from '@/lib/context-storage';
import { AuthError } from '@/lib/api-error';

// ─── GET /api/auth/me ─────────────────────────────────────────────────
export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const ctx = getRequestContext();
    if (!ctx?.userId) throw new AuthError('Unauthorized');
    const userId = ctx.userId;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        companyMemberships: {
          where: { company: { isActive: true } },
          include: {
            company: {
              select: {
                id: true,
                legalName: true,
                taxId: true,
                logo: true,
                isActive: true,
                isOnboardingComplete: true,
              },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let companies;
    if (user.role === 'super_admin') {
      companies = await db.company.findMany({
        where: { isActive: true },
        select: {
          id: true,
          legalName: true,
          taxId: true,
          logo: true,
          isActive: true,
          isOnboardingComplete: true,
        },
        orderBy: { legalName: 'asc' },
      });
    } else {
      companies = user.companyMemberships.map((m) => m.company);
    }

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
      companies,
    });
  },
  { requireMembership: false },
);
