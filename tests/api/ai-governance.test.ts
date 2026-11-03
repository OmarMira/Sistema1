// S21 — AI governance (four-eyes, server-side attribution, no read-path writes,
// token budget/kill switch, loud provider failures, PII redaction).
//
// Behaviour-level coverage through the public HTTP routes and the real database.
// The AI provider and logger are the only mocked collaborators.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getAiConfig: vi.fn(),
  safeFetch: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/ai-config', () => ({ getAiConfig: mocks.getAiConfig }));
vi.mock('@/lib/security/safe-fetch', () => ({ safeFetch: mocks.safeFetch }));
vi.mock('@/lib/logger', () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error, slowQuery: vi.fn() },
}));

import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { createTestUser, createTestCompany, clearDatabase } from '../helpers/factories';
import { recordAiTokenUsage, getDailyTokenUsage } from '@/lib/ai-quota';
import { POST as proposeRoute } from '@/app/api/company-knowledge/propose/route';
import { POST as confirmRoute } from '@/app/api/company-knowledge/confirm/route';
import { POST as archiveRoute } from '@/app/api/company-knowledge/[id]/archive/route';
import { POST as restoreRoute } from '@/app/api/company-knowledge/[id]/restore/route';
import { POST as mergeRoute } from '@/app/api/company-knowledge/[id]/merge/route';
import { POST as conversationalParseRoute } from '@/app/api/learning/conversational-parse/route';
import { POST as suggestRoleRoute } from '@/app/api/learning/suggest-role/route';

const createdCompanyIds = new Set<string>();

async function seedCompany(label: string) {
  const admin = await createTestUser(`ai-gov-${label}-admin@example.com`);
  const company = await createTestCompany(`AI Governance ${label}`);
  createdCompanyIds.add(company.id);
  await db.companyMember.create({
    data: { userId: admin.id, companyId: company.id, role: 'company_admin' },
  });
  const employee = await createTestUser(`ai-gov-${label}-employee@example.com`);
  await db.companyMember.create({
    data: { userId: employee.id, companyId: company.id, role: 'employee' },
  });
  return { admin, employee, company };
}

function post(
  token: string | null,
  path: string,
  companyId: string,
  body: Record<string, unknown>,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new NextRequest(`http://localhost${path}?companyId=${companyId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function createKnowledge(companyId: string, canonicalName: string) {
  return db.companyKnowledge.create({
    data: {
      companyId,
      type: 'PERSON',
      canonicalName,
      aliases: [],
      metadata: {},
      source: 'company_knowledge',
      status: 'active',
    },
  });
}

async function createPendingUpdate(companyId: string, knowledgeId: string, requestedBy: string) {
  return db.pendingApproval.create({
    data: {
      companyId,
      knowledgeId,
      action: 'update',
      payload: {
        knowledgeId,
        before: { canonicalName: 'Before' },
        after: { canonicalName: 'After' },
        updates: { canonicalName: 'After' },
      },
      requestedBy,
      status: 'pending',
    },
  });
}

function aiSuggestion(role = 'PROVEEDOR', totalTokens = 42) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ role, confidence: 0.9, explanation: 'evidence-based' }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 22, total_tokens: totalTokens },
    }),
    { status: 200 },
  );
}

async function deleteAiUsageRows() {
  await db.systemConfig.deleteMany({ where: { key: { contains: 'ai.tokens' } } }).catch(() => {});
}

describe('S21 — AI governance', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.clearAllMocks();
    delete process.env.AI_DISABLED;
    delete process.env.AI_DAILY_TOKEN_BUDGET;
    await deleteAiUsageRows();
    // Default: AI is not configured, so no provider call can happen silently.
    mocks.getAiConfig.mockRejectedValue(new Error('AI not configured'));
  });

  afterEach(async () => {
    const ids = [...createdCompanyIds];
    createdCompanyIds.clear();
    const filter = { companyId: { in: ids } };
    await db.pendingApproval.deleteMany({ where: filter }).catch(() => {});
    await db.knowledgeAudit.deleteMany({ where: { companyKnowledge: filter } }).catch(() => {});
    await db.companyKnowledge.deleteMany({ where: filter }).catch(() => {});
    await db.entityContext.deleteMany({ where: filter }).catch(() => {});
    await deleteAiUsageRows();
    delete process.env.AI_DISABLED;
    delete process.env.AI_DAILY_TOKEN_BUDGET;
    await clearDatabase();
  });

  // ── (a) four-eyes ────────────────────────────────────────────────
  it('refuses a member (non-admin) confirming a pending proposal', async () => {
    const { admin, employee, company } = await seedCompany('member-confirm');
    const pending = await db.pendingApproval.create({
      data: {
        companyId: company.id,
        action: 'create',
        payload: {
          companyId: company.id,
          type: 'person',
          canonicalName: 'Member Confirm Attempt',
          aliases: [],
          relationship: null,
          metadata: {},
          source: 'company_knowledge',
        },
        requestedBy: admin.id,
        status: 'pending',
      },
    });
    const employeeToken = await createSession(employee.id);

    const res = await confirmRoute(
      post(employeeToken, '/api/company-knowledge/confirm', company.id, {
        pendingApprovalId: pending.id,
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(403);
    const created = await db.companyKnowledge.findFirst({
      where: { companyId: company.id, canonicalName: 'Member Confirm Attempt' },
    });
    expect(created).toBeNull();
    const stillPending = await db.pendingApproval.findUnique({ where: { id: pending.id } });
    expect(stillPending?.status).toBe('pending');
  });

  it('lets an admin confirm a proposal raised by another member', async () => {
    const { admin, employee, company } = await seedCompany('cross-user');
    const employeeToken = await createSession(employee.id);
    const adminToken = await createSession(admin.id);

    const proposeRes = await proposeRoute(
      post(employeeToken, '/api/company-knowledge/propose', company.id, {
        type: 'person',
        canonicalName: 'Two Pairs Entity',
        metadata: {},
      }),
      { params: Promise.resolve({}) },
    );
    expect(proposeRes.status).toBe(200);
    const { pendingApprovalId } = await proposeRes.json();

    const confirmRes = await confirmRoute(
      post(adminToken, '/api/company-knowledge/confirm', company.id, { pendingApprovalId }),
      { params: Promise.resolve({}) },
    );
    expect(confirmRes.status).toBe(200);

    const created = await db.companyKnowledge.findFirst({
      where: { companyId: company.id, canonicalName: 'Two Pairs Entity' },
    });
    expect(created).not.toBeNull();
    const audit = await db.knowledgeAudit.findFirst({
      where: { knowledgeId: created!.id, action: 'create' },
    });
    expect(audit?.changedByUserId).toBe(admin.id);
  });

  it('refuses a confirmer that is the proposer of the same pending item', async () => {
    const { admin, company } = await seedCompany('same-user');
    const adminToken = await createSession(admin.id);

    const proposeRes = await proposeRoute(
      post(adminToken, '/api/company-knowledge/propose', company.id, {
        type: 'person',
        canonicalName: 'Self Approved Entity',
        metadata: {},
      }),
      { params: Promise.resolve({}) },
    );
    expect(proposeRes.status).toBe(200);
    const { pendingApprovalId } = await proposeRes.json();

    const confirmRes = await confirmRoute(
      post(adminToken, '/api/company-knowledge/confirm', company.id, { pendingApprovalId }),
      { params: Promise.resolve({}) },
    );

    expect(confirmRes.status).toBe(403);
    const created = await db.companyKnowledge.findFirst({
      where: { companyId: company.id, canonicalName: 'Self Approved Entity' },
    });
    expect(created).toBeNull();
    const stillPending = await db.pendingApproval.findUnique({ where: { id: pendingApprovalId } });
    expect(stillPending?.status).toBe('pending');
  });

  it('requires company_admin for archive, restore and merge (member is refused)', async () => {
    const { admin, employee, company } = await seedCompany('destructive');
    const employeeToken = await createSession(employee.id);
    const adminToken = await createSession(admin.id);
    const entity = await createKnowledge(company.id, 'Destructive Target');
    const source = await createKnowledge(company.id, 'Destructive Source');

    const archiveAsMember = await archiveRoute(
      post(employeeToken, `/api/company-knowledge/${entity.id}/archive`, company.id, {}),
      { params: Promise.resolve({ id: entity.id }) },
    );
    expect(archiveAsMember.status).toBe(403);

    const mergeAsMember = await mergeRoute(
      post(employeeToken, `/api/company-knowledge/${entity.id}/merge`, company.id, {
        sourceKnowledgeId: source.id,
        fieldResolutions: {},
      }),
      { params: Promise.resolve({ id: entity.id }) },
    );
    expect(mergeAsMember.status).toBe(403);

    const untouched = await db.companyKnowledge.findUnique({ where: { id: entity.id } });
    expect(untouched?.status).toBe('active');
    const untouchedSource = await db.companyKnowledge.findUnique({ where: { id: source.id } });
    expect(untouchedSource?.status).toBe('active');

    // Admin path still works (previous behaviour preserved).
    const archiveAsAdmin = await archiveRoute(
      post(adminToken, `/api/company-knowledge/${entity.id}/archive`, company.id, {}),
      { params: Promise.resolve({ id: entity.id }) },
    );
    expect(archiveAsAdmin.status).toBe(200);

    const restoreAsAdmin = await restoreRoute(
      post(adminToken, `/api/company-knowledge/${entity.id}/restore`, company.id, {}),
      { params: Promise.resolve({ id: entity.id }) },
    );
    expect(restoreAsAdmin.status).toBe(200);
  });

  // ── (b) server-side attribution ──────────────────────────────────
  it('ignores requestedBy supplied in the body and stores the session user', async () => {
    const { admin, employee, company } = await seedCompany('attribution');
    const adminToken = await createSession(admin.id);
    const other = await createTestUser('ai-gov-attribution-other@example.com');

    const proposeRes = await proposeRoute(
      post(adminToken, '/api/company-knowledge/propose', company.id, {
        type: 'person',
        canonicalName: 'Attributed Entity',
        metadata: {},
        requestedBy: other.id,
      }),
      { params: Promise.resolve({}) },
    );
    expect(proposeRes.status).toBe(200);
    const { pendingApprovalId } = await proposeRes.json();

    const pending = await db.pendingApproval.findUnique({ where: { id: pendingApprovalId } });
    expect(pending?.requestedBy).toBe(admin.id);
    expect(pending?.requestedBy).not.toBe(other.id);

    // A second admin confirms: the audit keeps recording the confirmer.
    const secondAdmin = await createTestUser('ai-gov-attribution-admin2@example.com');
    await db.companyMember.create({
      data: { userId: secondAdmin.id, companyId: company.id, role: 'company_admin' },
    });
    const secondToken = await createSession(secondAdmin.id);
    const confirmRes = await confirmRoute(
      post(secondToken, '/api/company-knowledge/confirm', company.id, { pendingApprovalId }),
      { params: Promise.resolve({}) },
    );
    expect(confirmRes.status).toBe(200);

    const audit = await db.knowledgeAudit.findFirst({
      where: { action: 'create', companyKnowledge: { companyId: company.id } },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit?.changedByUserId).toBe(secondAdmin.id);
    expect(employee.id).not.toBe(audit?.changedByUserId);
  });

  // ── (c) read paths never create GL accounts ──────────────────────
  it('conversational-parse returns the suggested account without creating GL rows', async () => {
    const { employee, company } = await seedCompany('no-auto-gl');
    await db.entityContext.create({
      data: {
        companyId: company.id,
        pattern: 'acme socio',
        role: 'SOCIO',
        source: 'user',
      },
    });
    const token = await createSession(employee.id);
    const accountsBefore = await db.glAccount.count({ where: { companyId: company.id } });

    const res = await conversationalParseRoute(
      post(token, '/api/learning/conversational-parse', company.id, {
        pattern: 'ACME SOCIO PAYMENT',
        userInput: 'socio withdrawal',
        directionProfile: { creditPct: 0.5, debitPct: 0.5 },
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.glAccountCode).toBe('3010');
    expect(body.data.glAccountId).toBeNull();
    expect(body.data.suggestedGlAccount).toMatchObject({
      code: '3010',
      accountType: 'equity',
      parentCode: '3000',
    });

    const accountsAfter = await db.glAccount.count({ where: { companyId: company.id } });
    expect(accountsAfter).toBe(accountsBefore);
    const created = await db.glAccount.findFirst({
      where: { companyId: company.id, code: { in: ['3010', '3040', '3000'] } },
    });
    expect(created).toBeNull();
  });

  // ── (d) token budget + kill switch ───────────────────────────────
  it('records provider token usage and blocks once the daily budget is exhausted', async () => {
    const { admin, company } = await seedCompany('budget');
    const token = await createSession(admin.id);
    mocks.getAiConfig.mockResolvedValue({
      apiKey: 'mock-key-1234',
      model: 'mock-model',
      baseUrl: 'https://openrouter.invalid/api/v1',
    });
    mocks.safeFetch.mockResolvedValue(aiSuggestion('PROVEEDOR', 42));
    process.env.AI_DAILY_TOKEN_BUDGET = '1000';

    const first = await suggestRoleRoute(
      post(token, '/api/learning/suggest-role', company.id, { description: 'ACME STORE ONLINE' }),
      { params: Promise.resolve({}) },
    );
    expect(first.status).toBe(200);
    expect(await getDailyTokenUsage(company.id)).toBe(42);

    // Exhaust the budget for today and require the next call to be refused.
    await recordAiTokenUsage(company.id, 1000);
    mocks.safeFetch.mockClear();

    const blocked = await suggestRoleRoute(
      post(token, '/api/learning/suggest-role', company.id, { description: 'ACME STORE ONLINE' }),
      { params: Promise.resolve({}) },
    );
    expect(blocked.status).toBe(429);
    const blockedBody = await blocked.json();
    expect(blockedBody.code).toBe('AI_DAILY_BUDGET_EXCEEDED');
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('AI_DISABLED short-circuits every provider call', async () => {
    const { admin, company } = await seedCompany('kill-switch');
    const token = await createSession(admin.id);
    mocks.getAiConfig.mockResolvedValue({
      apiKey: 'mock-key-1234',
      model: 'mock-model',
      baseUrl: 'https://openrouter.invalid/api/v1',
    });
    mocks.safeFetch.mockResolvedValue(aiSuggestion());
    process.env.AI_DISABLED = '1';

    const suggest = await suggestRoleRoute(
      post(token, '/api/learning/suggest-role', company.id, { description: 'ACME STORE ONLINE' }),
      { params: Promise.resolve({}) },
    );
    expect(suggest.status).toBe(503);
    const suggestBody = await suggest.json();
    expect(suggestBody.code).toBe('AI_DISABLED');

    const conversational = await conversationalParseRoute(
      post(token, '/api/learning/conversational-parse', company.id, {
        pattern: 'ACME STORE ONLINE',
        userInput: 'some expense',
        directionProfile: { creditPct: 0, debitPct: 1 },
      }),
      { params: Promise.resolve({}) },
    );
    expect(conversational.status).toBe(200);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  // ── (e) no silent failures ───────────────────────────────────────
  it('logs a warning when the AI provider fails in the conversational path', async () => {
    const { admin, company } = await seedCompany('provider-failure');
    const token = await createSession(admin.id);
    mocks.getAiConfig.mockResolvedValue({
      apiKey: 'mock-key-1234',
      model: 'mock-model',
      baseUrl: 'https://openrouter.invalid/api/v1',
    });
    mocks.safeFetch.mockRejectedValue(new Error('provider exploded: upstream 502'));

    const res = await conversationalParseRoute(
      post(token, '/api/learning/conversational-parse', company.id, {
        pattern: 'ACME UNKNOWN PAYMENT',
        userInput: 'some expense',
        directionProfile: { creditPct: 0, debitPct: 1 },
      }),
      { params: Promise.resolve({}) },
    );

    expect(res.status).toBe(200);
    const failureLog = mocks.warn.mock.calls.find(([message]) =>
      String(message).includes('CONVERSATIONAL AI CALL FAILED'),
    );
    expect(failureLog).toBeTruthy();
    expect(JSON.stringify(failureLog?.[1] ?? {})).toContain('provider exploded');
  });

  // ── (f) PII redaction ────────────────────────────────────────────
  it('redacts the company tax id from the outbound prompt but keeps the legal name', async () => {
    const { admin, company } = await seedCompany('pii');
    const token = await createSession(admin.id);
    await db.company.update({
      where: { id: company.id },
      data: { legalName: 'ACME HOLDINGS LLC', taxId: 'TAXID-SECRET-7788' },
    });
    mocks.getAiConfig.mockResolvedValue({
      apiKey: 'mock-key-1234',
      model: 'mock-model',
      baseUrl: 'https://openrouter.invalid/api/v1',
    });
    mocks.safeFetch.mockResolvedValue(aiSuggestion());

    const res = await suggestRoleRoute(
      post(token, '/api/learning/suggest-role', company.id, { description: 'ACME STORE ONLINE' }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);

    const outbound = String(mocks.safeFetch.mock.calls[0][1].body);
    expect(outbound).not.toContain('TAXID-SECRET-7788');
    expect(outbound).toContain('ACME HOLDINGS LLC');
  });
});
