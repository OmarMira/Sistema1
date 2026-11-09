/**
 * T20 / S18-S19 — the AI assistant's `get_audit_logs` tool must keep its exact
 * payload now that `AuditLog.user` / `User.auditLogs` no longer exist.
 *
 * The relation was removed because `AuditLog.userId` carried `ON DELETE SET NULL`
 * (deleting an account rewrote signed audit attribution). The tool used
 * `include: { user: … }`; a freshly generated Prisma client rejects that, and the
 * tool must instead resolve the author with ONE batched read — the same precedent
 * as `GET /api/admin/audit-logs` — while keeping:
 *   - the payload keys, the row order and the `take`/tenant filter unchanged;
 *   - the label `<first> <last> (<email>)` for a known account;
 *   - the existing fallback label `Sistema` when there is no author, INCLUDING the
 *     new case where `userId` still names an account that no longer exists (the
 *     reference is no longer nulled by the database).
 *
 * The test drives the REAL `POST` handler (imported from the route module and
 * invoked as a function — no server, no port) through a fake AI transport: the
 * provider is stubbed, so no network call, key or model is used, and the tool
 * payload is asserted exactly as the assistant would have received it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const COMPANY_ID = 'company-ai-audit';

const state = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  auditQueries: [] as Array<Record<string, unknown>>,
  userQueries: [] as Array<Record<string, unknown>>,
  fetchBodies: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: unknown) => handler }));
vi.mock('@/lib/context-storage', () => ({
  requireCompanyContext: () => ({ userId: 'user-actor', companyId: COMPANY_ID }),
}));
vi.mock('@/lib/rbac', () => ({ requireCompanyRole: async () => undefined }));
vi.mock('@/lib/ai-config', () => ({
  getAiConfig: async () => ({
    apiKey: 'synthetic-ai-key-not-a-credential',
    baseUrl: 'https://ai.invalid',
    model: 'synthetic-model',
  }),
}));
// Short-circuit the memory context lookup: this test is about the audit tool only.
vi.mock('@/lib/config-loader', () => ({ readJsonConfig: async () => ({}) }));
vi.mock('@/lib/audit', () => ({ createAuditLogWithRetry: async () => undefined }));
vi.mock('@/lib/db', () => ({
  db: {
    auditLog: {
      findMany: async (query: Record<string, unknown>) => {
        state.auditQueries.push(query);
        return state.audits.map((row) => ({ ...row }));
      },
    },
    user: {
      findMany: async (query: Record<string, unknown>) => {
        state.userQueries.push(query);
        const where = query.where as { id?: { in?: string[] } } | undefined;
        const wanted = where?.id?.in ?? [];
        return state.users.filter((row) => wanted.includes(String(row.id))).map((row) => ({ ...row }));
      },
    },
    systemMemory: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  },
}));

/** Fake AI transport: first turn asks for the audit tool, second turn answers. */
vi.mock('@/lib/security/safe-fetch', () => ({
  safeFetch: async (url: string, init?: { body?: string }) => {
    state.fetchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    if (state.fetchBodies.length === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-audit-1',
                type: 'function',
                function: { name: 'get_audit_logs', arguments: '{"limit":3}' },
              }],
            },
          }],
        }),
        text: async () => '',
      };
    }
    expect(url).toBe('https://ai.invalid/chat/completions');
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Listo' } }] }),
      text: async () => '',
    };
  },
}));

const AUDIT_ROWS = [
  {
    id: 'audit-live', userId: 'user-live', action: 'JOURNAL_POSTED', entity: 'JournalEntry',
    entityId: 'entry-1', details: 'det-a', createdAt: new Date('2026-01-05T10:00:00.000Z'),
  },
  {
    id: 'audit-deleted', userId: 'user-deleted', action: 'COMPANY_CREATED', entity: 'Company',
    entityId: COMPANY_ID, details: null, createdAt: new Date('2026-01-05T09:00:00.000Z'),
  },
  {
    id: 'audit-system', userId: null, action: 'GLOBAL_MAINTENANCE', entity: 'System',
    entityId: null, details: null, createdAt: new Date('2026-01-05T08:00:00.000Z'),
  },
];

/** The payload this tool has always produced for these three rows. */
const EXPECTED_PAYLOAD = [
  {
    id: 'audit-live', action: 'JOURNAL_POSTED', entity: 'JournalEntry', entityId: 'entry-1',
    details: 'det-a', user: 'Ana Perez (ana@example.test)', createdAt: '2026-01-05T10:00:00.000Z',
  },
  {
    id: 'audit-deleted', action: 'COMPANY_CREATED', entity: 'Company', entityId: COMPANY_ID,
    details: null, user: 'Sistema', createdAt: '2026-01-05T09:00:00.000Z',
  },
  {
    id: 'audit-system', action: 'GLOBAL_MAINTENANCE', entity: 'System', entityId: null,
    details: null, user: 'Sistema', createdAt: '2026-01-05T08:00:00.000Z',
  },
];

type RouteModule = typeof import('@/app/api/ai-assistant/route');
let POST: RouteModule['POST'];

function chat() {
  return POST(
    new NextRequest('http://localhost/api/ai-assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'mostrame los ultimos movimientos', mode: 'chat' }),
    }),
    { params: Promise.resolve({}) },
  );
}

beforeEach(async () => {
  ({ POST } = await import('@/app/api/ai-assistant/route'));
  state.audits = AUDIT_ROWS.map((row) => ({ ...row }));
  // One live author; the other reference points at an account that no longer exists.
  state.users = [{ id: 'user-live', firstName: 'Ana', lastName: 'Perez', email: 'ana@example.test' }];
  state.auditQueries.length = 0;
  state.userQueries.length = 0;
  state.fetchBodies.length = 0;
});

describe('AI assistant get_audit_logs without the AuditLog.user relation', () => {
  it('keeps the exact tool payload for a known and a deleted author', async () => {
    const response = await chat();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reply: 'Listo' });

    // Two provider turns only (tool call + answer) — no other outbound attempt.
    expect(state.fetchBodies).toHaveLength(2);
    const messages = (state.fetchBodies[1].messages ?? []) as Array<Record<string, unknown>>;
    const toolMessage = messages.find((message) => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.name).toBe('get_audit_logs');
    // The real tool payload, exactly as the assistant receives it.
    expect(JSON.parse(String(toolMessage?.content))).toEqual(EXPECTED_PAYLOAD);

    // The listing must not depend on the removed relation…
    for (const query of state.auditQueries) expect(query).not.toHaveProperty('include');
    // …and the tenant filter, order and page size are unchanged.
    expect(state.auditQueries[0]).toMatchObject({
      where: { companyId: COMPANY_ID }, take: 3, orderBy: { createdAt: 'desc' },
    });
    // One batched author read for the whole page, not one per row.
    expect(state.userQueries).toHaveLength(1);
    expect(state.userQueries[0]).toMatchObject({
      where: { id: { in: ['user-live', 'user-deleted'] } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
  });

  it('reads no author when every row is installation-wide', async () => {
    state.audits = [{
      id: 'audit-system', userId: null, action: 'GLOBAL_MAINTENANCE', entity: 'System',
      entityId: null, details: null, createdAt: new Date('2026-01-05T08:00:00.000Z'),
    }];
    const response = await chat();
    expect(response.status).toBe(200);
    const messages = (state.fetchBodies[1].messages ?? []) as Array<Record<string, unknown>>;
    const payload = JSON.parse(String(messages.find((m) => m.role === 'tool')?.content));
    expect(payload).toEqual([EXPECTED_PAYLOAD[2]]);
    // No ids to resolve -> no user query at all.
    expect(state.userQueries).toHaveLength(0);
  });
});
