import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';

export const DELETE = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();

    const { id: companyId, userId: targetUserId } = await context.params;

    const member = await db.companyMember.findUnique({
      where: {
        userId_companyId: {
          userId: targetUserId,
          companyId,
        },
      },
      include: {
        user: { select: { email: true } },
      },
    });

    if (!member) {
      return NextResponse.json({ error: 'Membership not found' }, { status: 404 });
    }

    await db.companyMember.delete({
      where: {
        userId_companyId: {
          userId: targetUserId,
          companyId,
        },
      },
    });

    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'revoke_user_company',
        entity: 'CompanyMember',
        entityId: member.id,
        details: `Revoked user ${member.user.email} from company`,
      },
    });

    return NextResponse.json({ message: 'User access revoked successfully' });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
