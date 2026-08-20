import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { INVITABLE_ROLES } from '@/lib/validations/admin';
export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {

    const { id: companyId } = await context.params as { id: string };

    // Get current members of company
    const members = await db.companyMember.findMany({
      where: { companyId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            platformRole: true,
            isActive: true,
          },
        },
      },
    });

    // Get all users in the system to allow assignment
    const allUsers = await db.user.findMany({
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        platformRole: true,
        isActive: true,
      },
    });

    return NextResponse.json({
      members: members.map((m) => ({
        ...m,
        user: {
          id: m.user.id,
          email: m.user.email,
          firstName: m.user.firstName,
          lastName: m.user.lastName,
          role: m.user.platformRole,
          isActive: m.user.isActive,
        },
      })),
      allUsers: allUsers.map((u) => ({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.platformRole,
        isActive: u.isActive,
      })),
    });
  },
  { requireSuperAdmin: true, requireMembership: false },
);

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();

    const { id: companyId } = await context.params as { id: string };
    const body = await request.json();
    const { userId: targetUserId, role = 'company_admin' } = body;

    if (!targetUserId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    if (!INVITABLE_ROLES.includes(role)) {
      return NextResponse.json(
        { error: `Invalid role: ${role}. Membership roles are limited to ${INVITABLE_ROLES.join(', ')}.` },
        { status: 400 },
      );
    }

    // Check if already a member
    const existing = await db.companyMember.findUnique({
      where: {
        userId_companyId: {
          userId: targetUserId,
          companyId,
        },
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'User is already a member of this company' },
        { status: 400 },
      );
    }

    const member = await db.companyMember.create({
      data: {
        companyId,
        userId: targetUserId,
        role,
      },
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
    });

    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'assign_user_company',
        entity: 'CompanyMember',
        entityId: member.id,
        details: `Assigned user ${(member as any).user.email} to company`,
      },
    });

    return NextResponse.json({ member }, { status: 201 });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
