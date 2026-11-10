import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Route contract for superadministrator password recovery.
 *
 * S3: every request gets the same status and body, whether the address is
 * unknown, an ordinary user, an unverified owner or the eligible owner.
 * S9: discarded requests are still audited.
 * S10: an installation with no mail transport says so instead of pretending.
 */

const state = {
  users: [] as Array<Record<string, unknown>>,
  tokens: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  delivered: [] as Array<{ to: string; token: string }>,
  transport: null as unknown,
};

vi.mock('@/lib/db', () => {
  const user = {
    findUnique: async ({ where }: any) => state.users.find((u) => u.email === where.email) ?? null,
    update: async () => ({}),
  };
  const passwordResetToken = {
    deleteMany: async () => {
      state.tokens = [];
      return { count: 0 };
    },
    create: async ({ data }: any) => {
      state.tokens.push({ ...data, usedAt: null });
      return data;
    },
    findFirst: async () => null,
    updateMany: async () => ({ count: 0 }),
  };
  return {
    db: {
      user,
      passwordResetToken,
      $transaction: async (fn: any) => fn({ user, passwordResetToken }),
    },
  };
});

vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: async (data: any) => {
    state.audits.push(data);
  },
}));

vi.mock('@/lib/sessions', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getSessionUserId: async () => null,
    deleteAllUserSessions: async () => {},
  };
});

vi.mock('@/lib/rate-limiter', () => ({
  authRateLimiter: { check: () => ({ success: true }), increment: () => {}, reset: () => {} },
}));

vi.mock('@/lib/security/client-ip', () => ({ getClientIp: () => '127.0.0.1' }));

vi.mock('@/lib/backup-recovery-mail', () => ({
  createRecoveryMailTransport: () => state.transport,
  deliverRecoveryToken: async (_t: unknown, input: { to: string; token: string }) => {
    state.delivered.push(input);
    return 'sent';
  },
}));

const { POST } = await import('@/app/api/auth/forgot-password/route');

const OWNER = {
  id: 'owner-1',
  email: 'owner@example.com',
  isActive: true,
  platformRole: 'super_admin',
  emailVerifiedAt: new Date(),
};
const ORDINARY = {
  id: 'user-1',
  email: 'user@example.com',
  isActive: true,
  platformRole: 'user',
  emailVerifiedAt: new Date(),
};
const UNVERIFIED = {
  id: 'owner-2',
  email: 'owner2@example.com',
  isActive: true,
  platformRole: 'super_admin',
  emailVerifiedAt: null,
};

function post(email: string) {
  return POST(
    new NextRequest('http://localhost/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
    {} as never,
  );
}

beforeEach(() => {
  state.users = [{ ...OWNER }, { ...ORDINARY }, { ...UNVERIFIED }];
  state.tokens = [];
  state.audits = [];
  state.delivered = [];
  state.transport = { send: async () => {} };
});

describe('no mail transport (S10)', () => {
  it('reports the installation has no delivery channel and issues nothing', async () => {
    state.transport = null;
    const res = await post('owner@example.com');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/no tiene envío de correo configurado/i);
    expect(state.tokens).toHaveLength(0);
    expect(state.delivered).toHaveLength(0);
  });
});

describe('identical answer for every case (S3)', () => {
  it('answers unknown, ordinary and unverified addresses exactly like the owner', async () => {
    const ownerRes = await post('owner@example.com');
    const ownerBody = await ownerRes.json();
    const ownerStatus = ownerRes.status;

    for (const email of ['nobody@example.com', 'user@example.com', 'owner2@example.com']) {
      const res = await post(email);
      const body = await res.json();
      expect(res.status).toBe(ownerStatus);
      expect(body).toEqual(ownerBody);
    }
  });

  it('sends exactly one mail, only to the eligible owner', async () => {
    await post('owner@example.com');
    await post('user@example.com');
    await post('nobody@example.com');
    expect(state.delivered).toHaveLength(1);
    expect(state.delivered[0].to).toBe('owner@example.com');
    expect(state.tokens).toHaveLength(1);
  });
});

describe('discarded requests are audited (S9)', () => {
  it('records the discard without any token material', async () => {
    await post('user@example.com');
    expect(state.audits).toHaveLength(1);
    const audit = state.audits[0];
    expect(audit.action).toBe('PASSWORD_RESET_DISCARDED');
    expect(String(audit.details)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('records the request when a token is actually delivered', async () => {
    await post('owner@example.com');
    const actions = state.audits.map((a) => a.action);
    expect(actions).toContain('PASSWORD_RESET_REQUESTED');
  });
});
