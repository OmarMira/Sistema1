import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
type User = {
    id: string;
    email: string;
    platformRole: string;
    isActive: boolean;
    emailVerifiedAt: Date | null;
    legacyUser: boolean;
    companyMemberships: {
        id: string;
    }[];
};
const state = vi.hoisted(() => ({
    users: new Map<string, User>(), companies: [{ id: 'company-a' }, { id: 'inactive-company' }],
    sessionUserId: vi.fn(), writes: [] as boolean[], inTransaction: false,
    find: vi.fn(), count: vi.fn(), company: vi.fn(), remove: vi.fn(), audit: vi.fn(), sessions: vi.fn(), lock: vi.fn(), transaction: vi.fn(), identity: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: {
        user: { findUnique: state.find, count: state.count, delete: state.remove },
        company: { findFirst: state.company }, auditLog: { create: state.audit },
        session: { deleteMany: state.sessions }, $queryRaw: state.lock, $executeRaw: state.identity, $transaction: state.transaction,
    } }));
// Keep the real session-revocation helper; replace only request authentication
// synchronously, avoiding an async partial-mock dependency during collection.
vi.mock('@/lib/uploads/logo-service', () => ({ saveLogo: vi.fn(), deleteLogo: vi.fn() }));
vi.mock('@/lib/security/rate-limiter', () => ({ checkRateLimit: () => ({ allowed: true, limit: 100, remaining: 99, resetAt: new Date(0) }) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
import { DELETE } from '@/app/api/admin/users/[id]/route';
import { db } from '@/lib/db';
import * as sessions from '@/lib/sessions';
const { getSessionCookieName } = sessions;
function user(id: string, overrides: Partial<User> = {}): User {
    return { id, email: `${id}@example.test`, platformRole: 'super_admin', isActive: true, emailVerifiedAt: new Date('2025-01-01Z'), legacyUser: false, companyMemberships: [{ id: `membership-${id}` }], ...overrides };
}
const request = (id = 'actor') => DELETE(new NextRequest(`http://localhost/api/admin/users/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    state.users.clear();
    state.writes = [];
    state.inTransaction = false;
    vi.spyOn(sessions, 'getSessionUserId').mockImplementation(state.sessionUserId);
    state.users.set('actor', user('actor'));
    state.users.set('peer', user('peer', { companyMemberships: [] }));
    state.companies = [{ id: 'company-a' }, { id: 'inactive-company' }];
    state.sessionUserId.mockResolvedValue('actor');
    state.find.mockImplementation(async ({ where }: {
        where: {
            id: string;
        };
    }) => state.users.get(where.id) ?? null);
    state.count.mockImplementation(async ({ where }: {
        where: {
            id: {
                not: string;
            };
            platformRole: string;
            isActive: boolean;
            OR: unknown[];
        };
    }) => [...state.users.values()].filter(u => u.id !== where.id.not && u.platformRole === where.platformRole && u.isActive === where.isActive && (u.emailVerifiedAt !== null || u.legacyUser)).length);
    state.company.mockImplementation(async () => state.companies[0] ?? null);
    state.sessions.mockImplementation(async () => { state.writes.push(state.inTransaction); return { count: 1 }; });
    state.audit.mockImplementation(async () => { state.writes.push(state.inTransaction); return {}; });
    state.remove.mockImplementation(async () => { state.writes.push(state.inTransaction); return {}; });
    state.lock.mockResolvedValue([]);
    state.identity.mockResolvedValue(1);
    state.transaction.mockImplementation(async (callback: (client: typeof db) => unknown) => {
        state.inTransaction = true;
        try {
            return await callback(db);
        }
        finally {
            state.inTransaction = false;
        }
    });
});
it('blocks the last usable global superadmin while any company exists, without revocation or writes', async () => {
    state.users.delete('peer');
    const res = await request();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Deleting this user would leave companies without an active superadmin.', code: 'LAST_COMPANY_SUPERADMIN' });
    expect(state.sessions).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.company).toHaveBeenCalledWith({ select: { id: true } });
});
it('allows self-deletion with another usable global superadmin even without a membership, atomically', async () => {
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'User deleted successfully', selfDeleted: true });
    expect(res.headers.get('set-cookie')).toContain(`${getSessionCookieName()}=`);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(state.sessions).toHaveBeenCalledWith({ where: { userId: 'actor' } });
    expect(state.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'actor', action: 'delete_user', entityId: 'actor' }) });
    expect(state.remove).toHaveBeenCalledWith({ where: { id: 'actor' } });
    expect(state.writes).toEqual([true, true, true]);
    expect(state.count).toHaveBeenCalledWith({ where: {
            id: { not: 'actor' }, platformRole: 'super_admin', isActive: true,
            OR: [{ emailVerifiedAt: { not: null } }, { legacyUser: true }],
        } });
    expect(String(state.lock.mock.calls[0][0])).toMatch(/ORDER BY.*id.*FOR UPDATE/s);
});
it.each([
    { isActive: false }, { emailVerifiedAt: null }, { platformRole: 'user' },
])('does not count an unusable replacement: %j', async (overrides) => {
    state.users.set('peer', user('peer', overrides));
    expect((await request()).status).toBe(409);
    expect(state.writes).toEqual([]);
});
it('preserves access eligibility of active legacy superadmins', async () => {
    state.users.set('peer', user('peer', { emailVerifiedAt: null, legacyUser: true }));
    expect((await request()).status).toBe(200);
});
it('preserves self-deletion and session expiry after every company has been removed', async () => {
    state.users.delete('peer');
    state.companies = [];
    state.users.set('actor', user('actor', { companyMemberships: [] }));
    expect((await request()).status).toBe(200);
    expect(state.writes).toEqual([true, true, true]);
});
it('preserves deletion of an ordinary user and does not expire the caller session', async () => {
    state.users.set('peer', user('peer', { platformRole: 'user' }));
    const res = await request('peer');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'User deleted successfully', selfDeleted: false });
    expect(res.headers.get('set-cookie')).toBeNull();
});
it('preserves not-found and superadmin authorization responses before mutations', async () => {
    const missing = await request('missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'User not found' });
    state.sessionUserId.mockResolvedValue(null);
    expect((await request()).status).toBe(401);
    state.sessionUserId.mockResolvedValue('peer');
    state.users.set('peer', user('peer', { platformRole: 'user' }));
    expect((await request()).status).toBe(403);
    expect(state.writes).toEqual([]);
});
it('blocks the last superadmin even without any membership, including when only inactive companies remain', async () => {
    state.users.delete('peer');
    state.users.set('actor', user('actor', { companyMemberships: [] }));
    state.companies = [{ id: 'inactive-company' }];
    expect((await request()).status).toBe(409);
    expect(state.writes).toEqual([]);
});
it('rechecks caller authority after waiting for the lock and before all mutations', async () => {
    state.lock.mockImplementationOnce(async () => { state.users.delete('actor'); return []; });
    expect((await request('peer')).status).toBe(401);
    expect(state.writes).toEqual([]);
});
it('runs session revocation and audit inside the transaction even if deletion fails', async () => {
    state.remove.mockImplementation(async () => { state.writes.push(state.inTransaction); throw new Error('forced deletion failure'); });
    state.users.set('peer', user('peer', { platformRole: 'user' }));
    const res = await request('peer');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    expect(state.writes).toEqual([true, true, true]);
});
it('removes only the deleted identity access in the transaction and keeps a minimal audit', async () => {
    const calls: Array<{ sql: string; args: unknown[]; inside: boolean }> = [];
    state.identity.mockImplementation(async (parts: TemplateStringsArray, ...args: unknown[]) => {
        calls.push({ sql: parts.join('?'), args, inside: state.inTransaction });
        return 1;
    });
    const res = await request('peer');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'User deleted successfully', selfDeleted: false });
    const deletions = calls.filter(call => call.sql.includes('DELETE'));
    expect(deletions).toHaveLength(2);
    expect(deletions.every(call => call.inside)).toBe(true);
    expect(deletions.some(call => call.sql.includes('IdentityChallenge') && call.args.includes('peer'))).toBe(true);
    expect(deletions.some(call => call.sql.includes('IdentityPendingRegistration') && call.args.includes('peer@example.test'))).toBe(true);
    expect(calls.some(call => /DELETE.*(?:IdentityRateLimit|IdentitySecurityEvent)/s.test(call.sql))).toBe(false);
    expect(state.audit.mock.calls[0][0].data.details).not.toContain('peer@example.test');
    expect(state.remove).toHaveBeenCalledWith({ where: { id: 'peer' } });
});
it('does not delete the user or revoke sessions when identity cleanup fails', async () => {
    state.identity.mockImplementation(async (parts: TemplateStringsArray) => {
        if (parts.join('?').includes('DELETE')) throw new Error('isolated cleanup failure');
        return 1;
    });
    const res = await request('peer');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    expect(state.sessions).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
});
it('refuses a concurrently changed email without deleting another identity request', async () => {
    state.lock.mockImplementationOnce(async () => {
        state.users.set('peer', user('peer', { email: 'changed@example.test' }));
        return [];
    });
    const res = await request('peer');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'User details changed. Refresh and try again.', code: 'USER_CHANGED' });
    expect(state.writes).toEqual([]);
    expect(state.identity.mock.calls.some(call => String(call[0]).includes('DELETE'))).toBe(false);
});
