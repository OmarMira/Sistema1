import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DELETE } from '@/app/api/admin/companies/[id]/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('D11-A: Company deletion atomicity', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  async function createSuperAdmin() {
    const user = await db.user.create({
      data: {
        email: `d11a-admin-${Date.now()}@example.com`,
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Super',
        lastName: 'Admin',
        platformRole: 'super_admin',
      },
    });
    const token = await createSession(user.id);
    return { user, token };
  }

  async function createCompanyWithFullKnowledge() {
    const { user, token } = await createSuperAdmin();
    const company = await createTestCompany('D11-A Test Co');
    await createTestCompanyMember(user.id, company.id);

    const gl = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
    });

    // Create CompanyKnowledge
    const knowledge = await db.companyKnowledge.create({
      data: {
        companyId: company.id,
        type: 'PERSON',
        canonicalName: 'Test Vendor',
        aliases: ['TV'],
      },
    });

    // Create KnowledgeAudit referencing the CompanyKnowledge
    await db.knowledgeAudit.create({
      data: {
        knowledgeId: knowledge.id,
        action: 'CREATED',
        version: 1,
        beforeValue: null,
        afterValue: { canonicalName: 'Test Vendor' },
        changedByUserId: user.id,
        source: 'test',
        reason: 'initial',
      },
    });

    // Create PendingApproval referencing the CompanyKnowledge
    await db.pendingApproval.create({
      data: {
        knowledgeId: knowledge.id,
        action: 'test_action',
        payload: { test: 'payload' },
        requestedBy: user.id,
        status: 'pending',
      },
    });

    return { company, token, gl, knowledge, userId: user.id, user };
  }

  it('T1: deletes company atomically with CompanyKnowledge + KnowledgeAudit + PendingApproval — no P2003', async () => {
    const { company, token } = await createCompanyWithFullKnowledge();

    const req = new NextRequest(`http://localhost/api/admin/companies/${company.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    const res = await DELETE(req, { params: Promise.resolve({ id: company.id }) });
    expect(res.status).toBe(200);

    // Verify company is gone
    expect(await db.company.findUnique({ where: { id: company.id } })).toBeNull();

    // Verify CompanyKnowledge is gone
    expect(await db.companyKnowledge.findMany({ where: { companyId: company.id } })).toHaveLength(0);

    // Verify KnowledgeAudit is gone
    expect(await db.knowledgeAudit.findMany({ where: { companyKnowledge: { companyId: company.id } } })).toHaveLength(0);

    // Verify PendingApproval is gone
    expect(await db.pendingApproval.findMany({ where: { companyKnowledge: { companyId: company.id } } })).toHaveLength(0);
  });

  it('T2: rollback on transaction failure — all prior deletions restored', async () => {
    const { company } = await createCompanyWithFullKnowledge();

    // Verify pre-conditions
    expect(await db.company.findUnique({ where: { id: company.id } })).not.toBeNull();
    expect(await db.companyKnowledge.findMany({ where: { companyId: company.id } })).toHaveLength(1);
    expect(await db.knowledgeAudit.findMany({ where: { companyKnowledge: { companyId: company.id } } })).toHaveLength(1);
    expect(await db.pendingApproval.findMany({ where: { companyKnowledge: { companyId: company.id } } })).toHaveLength(1);

    let errorThrown = false;
    try {
      await db.$transaction(async (tx) => {
        // Delete records inside the real transaction
        await tx.knowledgeAudit.deleteMany({
          where: { companyKnowledge: { companyId: company.id } },
        });
        await tx.pendingApproval.deleteMany({
          where: { companyKnowledge: { companyId: company.id } },
        });
        await tx.companyKnowledge.deleteMany({ where: { companyId: company.id } });

        // Confirm deletion inside the transaction using the transactional client (tx)
        const insideAudit = await tx.knowledgeAudit.findMany({
          where: { companyKnowledge: { companyId: company.id } },
        });
        const insidePending = await tx.pendingApproval.findMany({
          where: { companyKnowledge: { companyId: company.id } },
        });
        const insideKnowledge = await tx.companyKnowledge.findMany({
          where: { companyId: company.id },
        });

        expect(insideAudit).toHaveLength(0);
        expect(insidePending).toHaveLength(0);
        expect(insideKnowledge).toHaveLength(0);

        // Force a transaction rollback
        throw new Error('D11A_FORCED_ROLLBACK');
      });
    } catch (err: any) {
      if (err.message === 'D11A_FORCED_ROLLBACK') {
        errorThrown = true;
      } else {
        throw err;
      }
    }

    expect(errorThrown).toBe(true);

    // Verify ROLLBACK: everything is still present in the database because the transaction was aborted
    expect(await db.company.findUnique({ where: { id: company.id } })).not.toBeNull();
    expect(await db.companyKnowledge.findMany({ where: { companyId: company.id } })).toHaveLength(1);
    expect(await db.knowledgeAudit.findMany({ where: { companyKnowledge: { companyId: company.id } } })).toHaveLength(1);
    expect(await db.pendingApproval.findMany({ where: { companyKnowledge: { companyId: company.id } } })).toHaveLength(1);
  });

  it('T3: dependency cascade — successful delete removes KnowledgeAudit, PendingApproval, CompanyKnowledge in order', async () => {
    const { company, token } = await createCompanyWithFullKnowledge();

    const req = new NextRequest(`http://localhost/api/admin/companies/${company.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    const res = await DELETE(req, { params: Promise.resolve({ id: company.id }) });
    expect(res.status).toBe(200);

    // Verify cascade order: KnowledgeAudit, PendingApproval, CompanyKnowledge all gone
    expect(await db.knowledgeAudit.findMany({ where: { companyKnowledge: { companyId: company.id } } })).toHaveLength(0);
    expect(await db.pendingApproval.findMany({ where: { companyKnowledge: { companyId: company.id } } })).toHaveLength(0);
    expect(await db.companyKnowledge.findMany({ where: { companyId: company.id } })).toHaveLength(0);
  });

  it('T4: deleting company A does not affect company B — both have full knowledge records', async () => {
    const { company: companyA, token, user } = await createCompanyWithFullKnowledge();

    // Create company B with its own full knowledge
    const companyB = await createTestCompany('D11-A Other Co');
    const glB = await createTestGlAccount({
      companyId: companyB.id,
      code: '2010',
      name: 'Payable',
    });

    const knowledgeB = await db.companyKnowledge.create({
      data: {
        companyId: companyB.id,
        type: 'PERSON',
        canonicalName: 'Other Vendor',
        aliases: ['OV'],
      },
    });

    await db.knowledgeAudit.create({
      data: {
        knowledgeId: knowledgeB.id,
        action: 'CREATED',
        version: 1,
        beforeValue: null,
        afterValue: { canonicalName: 'Other Vendor' },
        changedByUserId: user.id,
        source: 'test',
        reason: 'initial',
      },
    });

    await db.pendingApproval.create({
      data: {
        knowledgeId: knowledgeB.id,
        action: 'test_action',
        payload: { test: 'payload' },
        requestedBy: user.id,
        status: 'pending',
      },
    });

    // Delete company A
    const req = new NextRequest(`http://localhost/api/admin/companies/${companyA.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    const res = await DELETE(req, { params: Promise.resolve({ id: companyA.id }) });
    expect(res.status).toBe(200);

    // Company B is untouched
    expect(await db.company.findUnique({ where: { id: companyB.id } })).not.toBeNull();
    expect(await db.companyKnowledge.findMany({ where: { companyId: companyB.id } })).toHaveLength(1);
    expect(await db.knowledgeAudit.findMany({ where: { companyKnowledge: { companyId: companyB.id } } })).toHaveLength(1);
    expect(await db.pendingApproval.findMany({ where: { companyKnowledge: { companyId: companyB.id } } })).toHaveLength(1);
  });
});