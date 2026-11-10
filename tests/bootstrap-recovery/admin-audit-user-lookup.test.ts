/**
 * T19 / S18 — `GET /api/admin/audit-logs` must keep its external response shape
 * after the `AuditLog.user` / `User.auditLogs` relations are removed.
 *
 * The relations are removed because `AuditLog.userId` carried
 * `ON DELETE SET NULL`: deleting an account rewrote signed audit attribution
 * (see docs/bootstrap-backup-recovery.md, T19). The endpoint used to resolve the
 * author with `include: { user: … }`, exactly like it used to resolve `company`
 * before that foreign key was dropped. The replacement follows the same
 * precedent: one batched read for the whole page, never one query per row.
 *
 * Only runtime boundaries are stubbed here (database module + session lookup) so
 * the handler body, `apiHandler` admission and response serialization stay real.
 * Nothing outside a temporary OS directory is written; no database, network or
 * application server is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// `apiHandler` acquires a normal-operation lease, which writes one small marker
// file under the configured data root. Keep that OUT of the worktree.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sistema1-admin-audit-'));
process.env.ACCOUNTEXPRESS_DATA_DIR = scratch;

const state = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  companies: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  auditQueries: [] as Array<Record<string, unknown>>,
  companyQueries: [] as Array<Record<string, unknown>>,
  userQueries: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/db', () => {
  const ids = (query: Record<string, unknown> | undefined): string[] => {
    const where = query?.where as { id?: { in?: string[] } } | undefined;
    return where?.id?.in ?? [];
  };
  const db = {
    auditLog: {
      findMany: async (query: Record<string, unknown>) => {
        state.auditQueries.push(query);
        return state.audits.map((row) => ({ ...row }));
      },
    },
    company: {
      findMany: async (query?: Record<string, unknown>) => {
        state.companyQueries.push(query ?? {});
        const wanted = ids(query);
        return state.companies.filter((row) => wanted.includes(String(row.id))).map((row) => ({ ...row }));
      },
    },
    user: {
      findUnique: async (query: { where: Record<string, unknown> }) => {
        if (query.where.id === 'admin-super') return { platformRole: 'super_admin' };
        return state.users.find((row) => row.id === query.where.id) ?? null;
      },
      findMany: async (query?: Record<string, unknown>) => {
        state.userQueries.push(query ?? {});
        const wanted = ids(query);
        return state.users.filter((row) => wanted.includes(String(row.id))).map((row) => ({ ...row }));
      },
    },
  };
  return { db };
});

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn(async () => 'admin-super'),
  getSessionCookieName: () => 'session',
}));

type RouteModule = typeof import('@/app/api/admin/audit-logs/route');
let GET: RouteModule['GET'];

const AUDIT_ROW = {
  id: 'audit-1',
  companyId: 'company-1',
  userId: null as string | null,
  action: 'JOURNAL_POSTED',
  entity: 'JournalEntry',
  entityId: 'entry-1',
  details: null,
  hash: 'a'.repeat(64),
  previousHash: null,
  createdAt: new Date('2026-01-05T10:00:00.000Z'),
};

beforeAll(async () => {
  // Imported AFTER the scratch data root is configured, so the admission lease
  // never touches the repository.
  ({ GET } = await import('@/app/api/admin/audit-logs/route'));
});

afterEach(() => {
  state.auditQueries.length = 0;
  state.companyQueries.length = 0;
  state.userQueries.length = 0;
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function call() {
  return GET(
    new NextRequest('http://localhost/api/admin/audit-logs'),
    { params: Promise.resolve({}) },
  );
}

describe('admin audit log listing without the AuditLog.user relation', () => {
  it('keeps the user shape, renders a deleted reference as null and batches the lookup', async () => {
    state.companies = [{ id: 'company-1', legalName: 'Empresa Uno' }];
    state.users = [
      { id: 'user-live', email: 'live@example.test', firstName: 'Live', lastName: 'User' },
    ];
    // One live author, one deleted author (attribution preserved on the row) and
    // one installation-wide event without an author.
    state.audits = [
      { ...AUDIT_ROW, id: 'audit-live', userId: 'user-live' },
      { ...AUDIT_ROW, id: 'audit-deleted', userId: 'user-deleted' },
      { ...AUDIT_ROW, id: 'audit-global', userId: null },
    ];

    const response = await call();
    expect(response.status).toBe(200);
    const body = await response.json() as {
      auditLogs: Array<Record<string, unknown> & { user: unknown }>;
    };

    expect(body.auditLogs.map((log) => log.user)).toEqual([
      { id: 'user-live', email: 'live@example.test', firstName: 'Live', lastName: 'User' },
      // The live user row is gone, so the response must still expose `user: null`
      // while keeping the recorded attribution on the row itself.
      null,
      null,
    ]);
    expect(body.auditLogs[1].userId).toBe('user-deleted');
    // Unchanged company resolution (same precedent, same shape).
    expect(body.auditLogs.map((log) => log.company)).toEqual([
      { id: 'company-1', legalName: 'Empresa Uno' },
      { id: 'company-1', legalName: 'Empresa Uno' },
      { id: 'company-1', legalName: 'Empresa Uno' },
    ]);

    // The listing must not depend on the removed relation…
    for (const query of state.auditQueries) expect(query).not.toHaveProperty('include');
    // …and it must not fan out one user read per row.
    expect(state.userQueries).toHaveLength(1);
    expect(state.userQueries[0]).toMatchObject({
      where: { id: { in: ['user-live', 'user-deleted'] } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    // Ordering, page size and the absence of a tenant filter are unchanged.
    expect(state.auditQueries[0]).toMatchObject({ orderBy: { createdAt: 'desc' }, take: 100 });
    expect(state.auditQueries[0]).not.toHaveProperty('where');
  });

  it('does not read audit history for a non-superadmin caller (authorization unchanged)', async () => {
    const { getSessionUserId } = await import('@/lib/sessions');
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null);
    const anonymous = await call();
    expect(anonymous.status).toBe(401);
    expect(state.auditQueries).toHaveLength(0);

    state.audits = [];
    state.companies = [];
    state.users = [];
    const { db } = await import('@/lib/db');
    const spy = vi.spyOn(db.user, 'findUnique').mockResolvedValueOnce({ platformRole: 'company_admin' } as never);
    const forbidden = await call();
    spy.mockRestore();
    expect(forbidden.status).toBe(403);
    expect(state.auditQueries).toHaveLength(0);
  });
});
