import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { findUsableResetToken } from '@/lib/password-reset';

/**
 * Non-consuming token check so the reset form can render "this link is no
 * longer valid" instead of failing after the user types a new password.
 * The answer is a bare boolean: invalid, expired and already used are
 * deliberately indistinguishable.
 */
export const GET = apiHandler(
  async (request: NextRequest) => {
    const token = new URL(request.url).searchParams.get('token') ?? '';
    const usable = await findUsableResetToken(token);
    return NextResponse.json({ valid: Boolean(usable) });
  },
  { allowAnonymous: true, requireMembership: false },
);
