// §GAP10 Block C — boundary tests for POST /api/transactions/[id]/rollback.
// Certifies the HUMAN-ONLY control boundary around the certified rollback core:
// authenticated session required, actorUserId only from session (never body),
// tenant-scoped companyId, truthful fail-closed error mapping, and delegation
// to the certified core (no duplicated rollback logic in the route).
//
// C8 (no automatic AI invocation) is certified by call-site evidence, not by
// an artificial unit test — see the PASO 11 call-site search in the report.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  clearDatabase,
} from './helpers/factories';

// C7: observe delegation to the certified core (passthrough — real behavior).
vi.mock('@/lib/rollback-automation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rollback-automation')>();
  return {
    ...actual,
    rollbackAutomationDecision: vi.fn(actual.rollbackAutomationDecision),
  };
});

import * as rollbackModule from '@/lib/rollback-automation';
import { POST } from '../src/app/api/transactions/[id]/rollback/route';

const rollbackSpy = vi.mocked(rollbackModule.rollbackAutomationDecision);

interface Fixture {
  userId: string;
  token: string;
  companyId: string;
  glOldId: string;
  glNewId: string;
  txId: string;
}

async function setupTenant(tag: string): Promise<Fixture> {
  const user = await createTestUser(`boundary-${tag}@example.com`);
  const company = await createTestCompany(`Boundary Co ${tag}`);
  await createTestCompanyMember(user.id, company.id);
  const glOld = await createTestGlAccount({
    companyId: company.id,
    code: '6100',
    name: `Old GL ${tag}`,
  });
  const glNew = await createTestGlAccount({
    companyId: company.id,
    code: '6200',
    name: `New GL ${tag}`,
  });
  const bankAccount = await createTestBankAccount(company.id, glOld.id, `Bank ${tag}`);
  const statement = await createTestBankStatement(company.id, bankAccount.id);
  const tx = await db.bankTransaction.create({
    data: {
      statementId: statement.id,
      date: new Date('2025-03-15'),
      amount: 100,
      description: `boundary tx ${tag}`,
      glAccountId: glOld.id,
    },
  });
  const token = await createSession(user.id);
  return {
    userId: user.id,
    token,
    companyId: company.id,
    glOldId: glOld.id,
    glNewId: glNew.id,
    txId: tx.id,
  };
}

async function seedProvenance(
  userId: string,
  companyId: string,
  txId: string,
  details: Record<string, string>,
) {
  return db.auditLog.create({
    data: {
      companyId,
      userId,
      action: 'FINAL_DECISION_SOURCE',
      entity: 'BankTransaction',
      entityId: txId,
      details: JSON.stringify(details),
    },
  });
}

async function postRollback(opts: {
  token: string | null;
  companyId: string;
  txId: string;
  body: Record<string, unknown>;
}) {
  const url = `http://localhost/api/transactions/${opts.txId}?companyId=${opts.companyId}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token}`;
  const req = new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
  return POST(req, { params: Promise.resolve({ id: opts.txId }) });
}

describe('§GAP10 Block C — rollback human boundary', () => {
  beforeEach(async () => {
    await clearDatabase();
    rollbackSpy.mockClear();
  });

  afterEach(async () => {
    await clearDatabase();
    rollbackSpy.mockClear();
  });

  it('C1 authenticated user can invoke rollback', async () => {
    const f = await setupTenant('c1');

    const res = await postRollback({
      token: f.token,
      companyId: f.companyId,
      txId: f.txId,
      body: { reason: 'C1 explicit human rollback', correctedGlAccountId: f.glNewId },
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { rollback?: { ok?: boolean } };
    expect(payload.rollback?.ok).toBe(true);

    const recorded = await db.auditLog.findFirst({
      where: { action: 'ROLLBACK_RECORDED', entityId: f.txId },
    });
    expect(recorded).not.toBeNull();
    expect(recorded?.userId).toBe(f.userId);
    const after = await db.bankTransaction.findUnique({ where: { id: f.txId } });
    expect(after?.glAccountId).toBe(f.glNewId);
  });

  it('C2 request without session is rejected', async () => {
    const f = await setupTenant('c2');

    const res = await postRollback({
      token: null,
      companyId: f.companyId,
      txId: f.txId,
      body: { reason: 'C2 anonymous attempt' },
    });
    expect(res.status).toBe(401);

    const recorded = await db.auditLog.count({
      where: { action: 'ROLLBACK_RECORDED', entityId: f.txId },
    });
    expect(recorded).toBe(0);
  });

  it('C3 body actorUserId cannot override the authenticated user', async () => {
    const f = await setupTenant('c3');

    const res = await postRollback({
      token: f.token,
      companyId: f.companyId,
      txId: f.txId,
      body: { reason: 'C3 spoof attempt', actorUserId: 'attacker-user-id' },
    });
    expect(res.status).toBe(200);

    const recorded = await db.auditLog.findFirst({
      where: { action: 'ROLLBACK_RECORDED', entityId: f.txId },
      orderBy: { createdAt: 'desc' },
    });
    expect(recorded).not.toBeNull();
    expect(recorded?.userId).toBe(f.userId);
    const details = JSON.parse(recorded?.details ?? '{}') as { actorUserId?: string };
    expect(details.actorUserId).toBe(f.userId);
    expect(details.actorUserId).not.toBe('attacker-user-id');
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    expect(rollbackSpy.mock.calls[0][0].actorUserId).toBe(f.userId);
  });

  it('C4 cross-tenant transaction is rejected without mutation', async () => {
    const a = await setupTenant('c4a');
    const b = await setupTenant('c4b');
    await seedProvenance(b.userId, b.companyId, b.txId, { source: 'KNOWLEDGE' });

    const res = await postRollback({
      token: a.token,
      companyId: a.companyId,
      txId: b.txId,
      body: { reason: 'C4 cross tenant', correctedGlAccountId: a.glNewId },
    });
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error?: string };
    expect(payload.error).toBe('Transaction not found');

    const txB = await db.bankTransaction.findUnique({ where: { id: b.txId } });
    expect(txB?.glAccountId).toBe(b.glOldId);
    const recordedForB = await db.auditLog.count({
      where: { action: 'ROLLBACK_RECORDED', entityId: b.txId },
    });
    expect(recordedForB).toBe(0);
    // Architecture: the endpoint DELEGATES the attempt to the certified core,
    // which performs the tenant-safe lookup and fail-closes inside.
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    const arg = rollbackSpy.mock.calls[0][0];
    expect(arg.companyId).toBe(a.companyId); // tenant A
    expect(arg.transactionId).toBe(b.txId); // transaction B
    expect(arg.actorUserId).toBe(a.userId); // user A
  });

  it('C5 RULE provenance without matchedRuleId surfaces fail-closed, not success', async () => {
    const f = await setupTenant('c5');
    await seedProvenance(f.userId, f.companyId, f.txId, { source: 'RULE' });

    const res = await postRollback({
      token: f.token,
      companyId: f.companyId,
      txId: f.txId,
      body: { reason: 'C5 rule missing id', correctedGlAccountId: f.glNewId },
    });
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error?: string };
    expect(payload.error).toContain('RULE provenance missing matchedRuleId');

    const after = await db.bankTransaction.findUnique({ where: { id: f.txId } });
    expect(after?.glAccountId).toBe(f.glOldId);
    const reclassifyAudits = await db.auditLog.count({
      where: { action: 'ROLLBACK_RECLASSIFY', entityId: f.txId },
    });
    expect(reclassifyAudits).toBe(0);
    const recorded = await db.auditLog.count({
      where: { action: 'ROLLBACK_RECORDED', entityId: f.txId },
    });
    expect(recorded).toBe(0);
  });

  it('C6 invalid or missing reason fails validation with 400', async () => {
    const f = await setupTenant('c6');

    const missing = await postRollback({
      token: f.token,
      companyId: f.companyId,
      txId: f.txId,
      body: {},
    });
    expect(missing.status).toBe(400);

    const empty = await postRollback({
      token: f.token,
      companyId: f.companyId,
      txId: f.txId,
      body: { reason: '   ' },
    });
    expect(empty.status).toBe(400);

    const recorded = await db.auditLog.count({
      where: { action: 'ROLLBACK_RECORDED', entityId: f.txId },
    });
    expect(recorded).toBe(0);
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('C7 endpoint delegates to the certified core exactly once', async () => {
    const f = await setupTenant('c7');

    const res = await postRollback({
      token: f.token,
      companyId: f.companyId,
      txId: f.txId,
      body: { reason: 'C7 delegation', correctedGlAccountId: f.glNewId },
    });
    expect(res.status).toBe(200);

    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    const arg = rollbackSpy.mock.calls[0][0];
    expect(arg.companyId).toBe(f.companyId);
    expect(arg.transactionId).toBe(f.txId);
    expect(arg.actorUserId).toBe(f.userId); // session-derived, not body-derived
    expect(arg.correctedGlAccountId).toBe(f.glNewId);
    expect(arg.reason).toBe('C7 delegation');
  });
});
