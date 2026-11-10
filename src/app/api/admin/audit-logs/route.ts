import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';

/** Author fields the endpoint has always exposed (and only these). */
const USER_SELECT = { id: true, email: true, firstName: true, lastName: true } as const;

export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const auditLogs = await db.auditLog.findMany({
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

    // S18/T19 — the author reference is evidence, not a foreign key: deleting an
    // account must never rewrite it (AuditLog_userId_fkey was dropped in
    // 20261109010000). `include: { user }` therefore no longer exists; resolve the
    // author here, in ONE batched read for the whole page (never one per row),
    // and keep the exact response shape: the four public fields while the account
    // exists, `null` once it was deleted. The stored `userId` stays on the row.
    const userIds = [
      ...new Set(auditLogs.map((log) => log.userId).filter((id): id is string => !!id)),
    ];
    const users =
      userIds.length > 0
        ? await db.user.findMany({
            where: { id: { in: userIds } },
            select: USER_SELECT,
          })
        : [];
    const userById = new Map(users.map((user) => [user.id, user]));

    const payload = auditLogs.map((log) => ({
      ...log,
      company: log.companyId ? (companyById.get(log.companyId) ?? null) : null,
      user: log.userId ? (userById.get(log.userId) ?? null) : null,
    }));

    return NextResponse.json({ auditLogs: payload });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
