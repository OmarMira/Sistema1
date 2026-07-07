import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { validateRequest } from '@/lib/validate-request';
import { createUserSchema } from '@/lib/validations/admin';
import { logger } from '@/lib/logger';

/**
 * GET /api/users?companyId=xxx — List users in a company
 * POST /api/users — Invite a new user to a company
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    // Verify requesting user is admin
    const requestingUser = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (
      !requestingUser ||
      (requestingUser.role !== 'company_admin' && requestingUser.role !== 'super_admin')
    ) {
      return NextResponse.json({ error: 'Only admins can view users' }, { status: 403 });
    }

    // Get all members with user info
    const members = await db.companyMember.findMany({
      where: { companyId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    const users = members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      fullName: `${m.user.firstName} ${m.user.lastName}`,
      role: m.user.role,
      isActive: m.user.isActive,
      companyRole: m.role,
      joinedAt: m.joinedAt.toISOString(),
      createdAt: m.user.createdAt.toISOString(),
    }));

    return NextResponse.json({ users });
  } catch (error) {
    logger.error('[USERS LIST ERROR]', { error: String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    const body = await validateRequest(request, createUserSchema);
    if (body instanceof NextResponse) return body;
    const { email, firstName, lastName, password, role = 'company_admin' } = body;

    if (!email || !firstName || !lastName || !password) {
      return NextResponse.json(
        { error: 'companyId, email, firstName, lastName, and password are required' },
        { status: 400 },
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 },
      );
    }

    // Verify requesting user is admin
    const requestingUser = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (
      !requestingUser ||
      (requestingUser.role !== 'company_admin' && requestingUser.role !== 'super_admin')
    ) {
      return NextResponse.json({ error: 'Only admins can invite users' }, { status: 403 });
    }

    // Check if user already exists
    const existingUser = await db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (existingUser) {
      // Check if already a member of this company
      const existingMembership = await db.companyMember.findFirst({
        where: { userId: existingUser.id, companyId },
      });

      if (existingMembership) {
        return NextResponse.json(
          { error: 'This user is already a member of this company' },
          { status: 409 },
        );
      }

      // Add existing user to company
      await db.companyMember.create({
        data: {
          userId: existingUser.id,
          companyId,
          role: role || 'company_admin',
        },
      });

      await db.auditLog.create({
        data: {
          companyId,
          userId,
          action: 'invite_existing_user',
          entity: 'CompanyMember',
          details: `Added existing user ${existingUser.email} to company`,
        },
      });

      return NextResponse.json(
        {
          message: 'Existing user added to company',
          user: {
            id: existingUser.id,
            email: existingUser.email,
            firstName: existingUser.firstName,
            lastName: existingUser.lastName,
            role: existingUser.role,
          },
        },
        { status: 201 },
      );
    }

    // Create new user + membership in a transaction
    const passwordHash = await hashPassword(password);

    const newUser = await db.user.create({
      data: {
        email: email.toLowerCase().trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        passwordHash,
        role: role || 'company_admin',
        companyMemberships: {
          create: {
            companyId,
            role: role || 'company_admin',
          },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'create_user',
        entity: 'User',
        entityId: newUser.id,
        details: `Created user ${newUser.email}`,
      },
    });

    return NextResponse.json(
      {
        message: 'User created and added to company',
        user: newUser,
      },
      { status: 201 },
    );
  } catch (error) {
    logger.error('[USER CREATE ERROR]', { error: String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
