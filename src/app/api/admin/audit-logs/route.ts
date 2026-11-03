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
      },
      orderBy: { createdAt: 'desc' },
      take: 100, // Limit to last 100 logs for performance
    });

    // S19(c) — audit rows outlive their company, so AuditLog carries no foreign
    // key to Company (see prisma/schema.prisma). The former
    // `include: { company }` is resolved here to keep the response shape:
    // `company` is the live tenant { id, legalName } while it exists, or null
    // once the company was deleted and only its evidence rows remain.
    const companyIds = [
      ...new Set(auditLogs.map((log) => log.companyId).filter((id): id is string => !!id)),
    ];
    const companies =
      companyIds.length > 0
        ? await db.company.findMany({
            where: { id: { in: companyIds } },
            select: { id: true, legalName: true },
          })
        : [];
    const companyById = new Map(companies.map((company) => [company.id, company]));

    const payload = auditLogs.map((log) => ({
      ...log,
      company: log.companyId ? (companyById.get(log.companyId) ?? null) : null,
    }));

    return NextResponse.json({ auditLogs: payload });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
