import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { hashPassword } from '@/lib/auth';
import { saveLogo, deleteLogo } from '@/lib/uploads/logo-service';
import { updateUserSchema } from '@/lib/validations/admin';
import { parseAdminBody } from '@/lib/parse-admin-body';

export const PATCH = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const { id } = await context.params;

    const contentType = request.headers.get('content-type') || '';
    const isFormData = contentType.includes('multipart/form-data');

    let avatarCleared = false;
    let avatarFile: File | null = null;

    if (isFormData) {
      const formData = await request.clone().formData();
      avatarCleared = formData.get('avatarCleared') === 'true';
    }

    const parsed = await parseAdminBody(request, updateUserSchema, (raw) => ({
      ...raw,
      isActive: raw.isActive !== undefined ? raw.isActive === 'true' : undefined,
    }));
    if (!parsed.ok) return parsed.error;

    avatarFile = parsed.body.files.get('avatar') ?? null;

    const userExists = await db.user.findUnique({
      where: { id },
      select: { avatar: true },
    });

    if (!userExists) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    let newAvatarPath: string | undefined;
    let shouldUpdateAvatar = false;

    if (avatarFile) {
      newAvatarPath = await saveLogo(avatarFile);
      if (userExists.avatar) {
        await deleteLogo(userExists.avatar);
      }
      shouldUpdateAvatar = true;
    } else if (avatarCleared) {
      newAvatarPath = '';
      if (userExists.avatar) {
        await deleteLogo(userExists.avatar);
      }
      shouldUpdateAvatar = true;
    }

    const fields = parsed.body.data;
    const data: Record<string, unknown> = {};

    if (fields.firstName !== undefined) data.firstName = fields.firstName.trim();
    if (fields.lastName !== undefined) data.lastName = fields.lastName.trim();
    if (fields.email !== undefined) data.email = fields.email.toLowerCase().trim();
    if (fields.role !== undefined) data.role = fields.role;
    if (fields.isActive !== undefined) data.isActive = fields.isActive;
    if (fields.password !== undefined && fields.password.trim() !== '') {
      data.passwordHash = await hashPassword(fields.password);
    }
    if (fields.phone !== undefined) data.phone = fields.phone.trim();
    if (fields.streetLine1 !== undefined) data.streetLine1 = fields.streetLine1.trim();
    if (fields.streetLine2 !== undefined) data.streetLine2 = fields.streetLine2.trim();
    if (fields.city !== undefined) data.city = fields.city.trim();
    if (fields.state !== undefined) data.state = fields.state;
    if (fields.zipCode !== undefined) data.zipCode = fields.zipCode.trim();
    if (shouldUpdateAvatar) {
      data.avatar = newAvatarPath === '' ? '' : newAvatarPath;
    }

    const updatedUser = await db.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        phone: true,
        streetLine1: true,
        streetLine2: true,
        city: true,
        state: true,
        zipCode: true,
        avatar: true,
      },
    });

    await db.auditLog.create({
      data: {
        userId,
        action: 'update_user',
        entity: 'User',
        entityId: updatedUser.id,
        details: `Updated user ${updatedUser.email}`,
      },
    });

    return NextResponse.json({ user: updatedUser });
  },
  { requireSuperAdmin: true, requireMembership: false },
);

export const DELETE = apiHandler(
  async (_request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const { id } = await context.params;

    if (userId === id) {
      return NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 });
    }

    const targetUser = await db.user.findUnique({ where: { id } });
    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    await db.user.delete({ where: { id } });

    await db.auditLog.create({
      data: {
        userId,
        action: 'delete_user',
        entity: 'User',
        entityId: id,
        details: `Permanently deleted user ${targetUser.email}`,
      },
    });

    return NextResponse.json({ message: 'User deleted successfully' });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
