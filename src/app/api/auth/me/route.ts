import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyPassword } from '@/lib/auth';

/**
 * In-memory session store.  Tokens map to userId strings.
 * For MVP / dev purposes this is sufficient.
 * In production, swap for Redis or a database-backed session table.
 */
const sessions = new Map<string, { userId: string; createdAt: number }>();

export { sessions as sessionStore };

export function getSessionUserId(request: NextRequest): string | null {
  const token =
    request.cookies.get('session')?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  // Sessions expire after 7 days
  if (Date.now() - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return null;
  }
  return session.userId;
}

// ─── GET /api/auth/me ─────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
            select: { id: true, legalName: true, taxId: true, isActive: true },
          },
        },
      },
    },
  });

  if (!user || !user.isActive) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const companies = user.companyMemberships.map((m) => m.company);

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
}

// ─── POST /api/auth/login ─────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      );
    }

    const user = await db.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        passwordHash: true,
        companyMemberships: {
          where: { company: { isActive: true } },
          include: {
            company: {
              select: { id: true, legalName: true, taxId: true, isActive: true },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Create session token
    const token = crypto.randomUUID();
    sessions.set(token, { userId: user.id, createdAt: Date.now() });

    const companies = user.companyMemberships.map((m) => m.company);

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
      companies,
    });

    // Set httpOnly cookie
    response.cookies.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    return response;
  } catch (error) {
    console.error('[AUTH LOGIN ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ─── DELETE /api/auth/logout ──────────────────────────────────────────
export async function DELETE(request: NextRequest) {
  const token =
    request.cookies.get('session')?.value ??
    request.headers.get('authorization')?.replace('Bearer ', '');

  if (token) {
    sessions.delete(token);
  }

  const response = NextResponse.json({ success: true });

  response.cookies.set('session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}
