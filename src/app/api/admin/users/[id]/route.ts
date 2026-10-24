import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { AppError, AuthError, ForbiddenError } from '@/lib/api-error';
import { hashPassword } from '@/lib/auth';
import { deleteAllUserSessions, getSessionCookieName } from '@/lib/sessions';
import { deleteIdentityAccess, lockIdentityForDeletion } from '@/lib/identity/cleanup';
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
    if (fields.role !== undefined) data.platformRole = fields.role;
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

    // If a password was set, the user's new hash is committed AND all their
    // sessions are revoked atomically (F-8 policy C: admin reset invalidates
    // every session of the target user, forcing a fresh login).
    const updatedUser = await db.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          platformRole: true,
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

      if (data.passwordHash) {
        await deleteAllUserSessions(id, tx);
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: 'update_user',
          entity: 'User',
          entityId: user.id,
          details: `Updated user ${user.email}`,
        },
      });

      return user;
    });

    const { platformRole, ...userPayload } = updatedUser;
    return NextResponse.json({ user: { ...userPayload, role: platformRole } });
  },
  { requireSuperAdmin: true, requireMembership: false },
);

export const DELETE = apiHandler(
  async (_request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const { id } = await context.params;

    return db.$transaction(async (tx) => {
      const identityTarget = await tx.user.findUnique({ where: { id }, select: { email: true } });
      const identityEmail = identityTarget?.email.trim().toLowerCase();
      if (identityEmail) await lockIdentityForDeletion(tx, identityEmail);

      // Superadmins have global company access, independent of memberships.
      // Lock in a stable order before counting: concurrent deletions must not
      // both count the other account as the company's surviving administrator.
      await tx.$queryRaw`
        SELECT "id" FROM "User" WHERE "role" = 'super_admin'
        ORDER BY "id" FOR UPDATE
      `;

      // Recovery also locks User before its challenge. Follow that order for
      // ordinary users too, not only the superadmin rows locked above.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE id = ${id} FOR UPDATE`;

      // Authorization may have changed while this request waited for the lock.
      const actor = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, platformRole: true, isActive: true, emailVerifiedAt: true, legacyUser: true },
      });
      if (!actor?.isActive || (!actor.emailVerifiedAt && !actor.legacyUser)) {
        throw new AuthError();
      }
      if (actor.platformRole !== 'super_admin') throw new ForbiddenError();

      const targetUser = id === userId ? actor : await tx.user.findUnique({
        where: { id },
        select: { id: true, email: true, platformRole: true },
      });
      if (!targetUser) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }

      if (!identityEmail || targetUser.email.trim().toLowerCase() !== identityEmail) {
        throw new AppError(409, 'User details changed. Refresh and try again.', 'USER_CHANGED');
      }

      if (targetUser.platformRole === 'super_admin') {
        const remaining = await tx.user.count({
          where: {
            id: { not: id },
            platformRole: 'super_admin',
            isActive: true,
            OR: [{ emailVerifiedAt: { not: null } }, { legacyUser: true }],
          },
        });
        // Inactive companies also retain administration through global admins.
        if (remaining === 0 && await tx.company.findFirst({ select: { id: true } })) {
          throw new AppError(
            409,
            'Deleting this user would leave companies without an active superadmin.',
            'LAST_COMPANY_SUPERADMIN',
          );
        }
      }

      // Guard, access cleanup, revocation, audit and deletion share one commit.
      await deleteIdentityAccess(tx, id, identityEmail);
      await deleteAllUserSessions(id, tx);
      await tx.auditLog.create({
        data: {
          userId,
          action: 'delete_user',
          entity: 'User',
          entityId: id,
          details: 'Permanently deleted user and authentication state',
        },
      });
      await tx.user.delete({ where: { id } });

      const response = NextResponse.json({
        message: 'User deleted successfully',
        selfDeleted: userId === id,
      });
      if (userId === id) {
        response.cookies.set(getSessionCookieName(), '', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 0,
        });
      }
      return response;
    }, { maxWait: 5000, timeout: 10000 });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
