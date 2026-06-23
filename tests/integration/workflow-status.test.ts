import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET } from '@/app/api/dashboard/workflow-status/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('Workflow Status API Integration Tests', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('allows access to a user who is a member of the company', async () => {
    const user = await createTestUser('member@example.com');
    const company = await createTestCompany('Member Corp');
    await createTestCompanyMember(user.id, company.id);

    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/dashboard/workflow-status?companyId=${company.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await GET(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('accounts');
    expect(body.accounts).toEqual({ completed: false, count: 0 });
  });

  it('allows access to a user who is a super_admin even if they are NOT a member of the company', async () => {
    const user = await createTestUser('superadmin@example.com');
    await db.user.update({
      where: { id: user.id },
      data: { role: 'super_admin' },
    });

    const company = await createTestCompany('Non Member Corp');
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/dashboard/workflow-status?companyId=${company.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await GET(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('accounts');
  });

  it('denies access (returns 403) to a user who is NOT a member and is NOT a super admin', async () => {
    const user = await createTestUser('nonmember@example.com');
    const company = await createTestCompany('Other Corp');
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/dashboard/workflow-status?companyId=${company.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await GET(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toContain('Forbidden');
  });

  it('verifies count accuracy and status completion for GL Accounts', async () => {
    const user = await createTestUser('member2@example.com');
    const company = await createTestCompany('Count Corp');
    await createTestCompanyMember(user.id, company.id);

    // Setup one GL Account in the DB
    await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
    });

    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/dashboard/workflow-status?companyId=${company.id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await GET(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);

    const body = await response.json();

    // Check that accounts status is completed: true with count: 1
    expect(body.accounts).toEqual({ completed: true, count: 1 });

    // Check that other steps are completed: false with count: 0
    expect(body.banks).toEqual({ completed: false, count: 0 });
    expect(body.import).toEqual({ completed: false, count: 0 });
    expect(body.rules).toEqual({ completed: false, count: 0 });
    expect(body.reconciliation).toEqual({ completed: false, count: 0 });
    expect(body.journal).toEqual({ completed: false, count: 0 });
    expect(body.reports).toEqual({ completed: false, count: 0 });
  });
});
