import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Token rules for superadministrator password recovery (S4, S5, S6).
 *
 * These are contract tests over the storage boundary, so they run against an
 * in-memory Prisma double instead of a database: the behaviour that matters is
 * which rows are created, replaced, claimed or ignored.
 */

const state = {
  users: [] as Array<Record<string, unknown>>,
  tokens: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
};

vi.mock('@/lib/db', () => {
  const user = {
    findUnique: async ({ where }: any) => state.users.find((u) => u.email === where.email) ?? null,
    update: async ({ where, data }: any) => {
      const row = state.users.find((u) => u.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
  };
  const passwordResetToken = {
    deleteMany: async ({ where }: any) => {
      const before = state.tokens.length;
      state.tokens = state.tokens.filter((t) => t.userId !== where.userId);
      return { count: before - state.tokens.length };
    },
    create: async ({ data }: any) => {
      state.tokens.push({ ...data, usedAt: null });
      return data;
    },
    findFirst: async ({ where }: any) => {
      const now = new Date();
      return (
        state.tokens.find(
          (t) =>
            t.tokenHash === where.tokenHash &&
            !t.usedAt &&
            (t.expiresAt as Date) > now,
        ) ?? null
      );
    },
    updateMany: async ({ where, data }: any) => {
      const row = state.tokens.find((t) => t.id === where.id && !t.usedAt);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  const client = { user, passwordResetToken, session: { deleteMany: async () => ({ count: 0 }) } };
  return { db: { ...client, $transaction: async (fn: any) => fn(client) } };
});

vi.mock('@/lib/sessions', () => ({
  deleteAllUserSessions: async (userId: string) => {
    state.sessions.push({ deletedFor: userId });
  },
}));

vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: async (data: any) => {
    state.audits.push(data);
  },
}));

const { issueResetToken, findUsableResetToken, consumeResetToken, isWellFormedToken } = await import(
  '@/lib/password-reset'
);

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

beforeEach(() => {
  state.users = [{ ...OWNER }, { ...ORDINARY }, { ...UNVERIFIED }];
  state.tokens = [];
  state.sessions = [];
  state.audits = [];
});

describe('eligible account only (S4)', () => {
  it('issues a token for an active verified superadministrator', async () => {
    const issued = await issueResetToken('owner@example.com');
    expect(issued).not.toBeNull();
    expect(state.tokens).toHaveLength(1);
    // Only the digest is stored, never the token itself.
    expect(state.tokens[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.tokens[0].tokenHash).not.toBe(issued!.token);
  });

  it('issues nothing for an ordinary user, an unverified owner or an unknown address', async () => {
    expect(await issueResetToken('user@example.com')).toBeNull();
    expect(await issueResetToken('owner2@example.com')).toBeNull();
    expect(await issueResetToken('nobody@example.com')).toBeNull();
    expect(state.tokens).toHaveLength(0);
  });
});

describe('single outstanding token (S5)', () => {
  it('replaces the previous token so only the newest is usable', async () => {
    const first = await issueResetToken('owner@example.com');
    const second = await issueResetToken('owner@example.com');
    expect(state.tokens).toHaveLength(1);
    expect(await findUsableResetToken(first!.token)).toBeNull();
    expect(await findUsableResetToken(second!.token)).not.toBeNull();
  });

  it('refuses a malformed token without touching storage', async () => {
    expect(isWellFormedToken('short')).toBe(false);
    expect(await findUsableResetToken('short')).toBeNull();
    expect(await consumeResetToken('short', 'hash')).toBeNull();
  });
});

describe('single use and session closure (S6, S7)', () => {
  it('consumes once, sets the password and closes sessions', async () => {
    const issued = await issueResetToken('owner@example.com');
    const userId = await consumeResetToken(issued!.token, 'new-hash');
    expect(userId).toBe(OWNER.id);
    expect(state.users.find((u) => u.id === OWNER.id)!.passwordHash).toBe('new-hash');
    expect(state.sessions).toEqual([{ deletedFor: OWNER.id }]);
  });

  it('rejects a replay without touching the password or sessions', async () => {
    const issued = await issueResetToken('owner@example.com');
    await consumeResetToken(issued!.token, 'first-hash');
    state.sessions = [];
    const replay = await consumeResetToken(issued!.token, 'second-hash');
    expect(replay).toBeNull();
    expect(state.users.find((u) => u.id === OWNER.id)!.passwordHash).toBe('first-hash');
    expect(state.sessions).toHaveLength(0);
  });

  it('rejects an expired token', async () => {
    const issued = await issueResetToken('owner@example.com');
    state.tokens[0].expiresAt = new Date(Date.now() - 1000);
    expect(await consumeResetToken(issued!.token, 'hash')).toBeNull();
  });
});
