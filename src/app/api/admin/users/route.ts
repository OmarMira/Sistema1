import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { apiHandler, RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { saveLogo } from '@/lib/uploads/logo-service';
import { createUserSchema } from '@/lib/validations/admin';
import { parseAdminBody } from '@/lib/parse-admin-body';

export const GET = apiHandler(
  async (_request: NextRequest, _context: RouteContext) => {
    const users = await db.user.findMany({
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
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ users });
  },
  { requireSuperAdmin: true, requireMembership: false },
);

export const POST = apiHandler(
  async (request: NextRequest) => {
    const userId = requireCurrentUserId();

    const parsed = await parseAdminBody(request, createUserSchema);
    if (!parsed.ok) return parsed.error;

    const {
      email,
      firstName,
      lastName,
      password,
      role,
      phone,
      streetLine1,
      streetLine2,
      city,
      state,
      zipCode,
    } = parsed.body.data;
    const avatarFile = parsed.body.files.get('avatar') ?? null;

    const existingUser = await db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (existingUser) {
      return NextResponse.json({ error: 'User already exists' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);

    let avatarPath = '';
    if (avatarFile) {
      avatarPath = await saveLogo(avatarFile);
    }

    const newUser = await db.user.create({
      data: {
        email: email.toLowerCase().trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        passwordHash,
        role,
        isActive: true,
        phone: phone || '',
        streetLine1: streetLine1 || '',
        streetLine2: streetLine2 || '',
        city: city || '',
        state: state || '',
        zipCode: zipCode || '',
        avatar: avatarPath,
      },
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
        action: 'create_user',
        entity: 'User',
        entityId: newUser.id,
        details: `Created user ${newUser.email}`,
      },
    });

    return NextResponse.json({ user: newUser }, { status: 201 });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
