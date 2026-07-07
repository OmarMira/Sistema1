import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyPassword, hashPassword } from '@/lib/auth';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';

/**
 * POST /api/settings/password — Change user password
 * Body: { currentPassword, newPassword }
 */
export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();

    const body = await request.json();
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Current password and new password are required' },
        { status: 400 },
      );
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: 'New password must be at least 8 characters' },
        { status: 400 },
      );
    }

    // Get user with password hash
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Verify current password
    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
    }

    // Hash and save new password
    const newHash = await hashPassword(newPassword);
    await db.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });

    // Log audit
    await db.auditLog.create({
      data: {
        userId,
        action: 'change_password',
        entity: 'User',
        entityId: userId,
      },
    });

    return NextResponse.json({ message: 'Password changed successfully' });
  },
  { requireMembership: false },
);
