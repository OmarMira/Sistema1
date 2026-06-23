import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as lockPOST } from '../../src/app/api/fiscal-periods/[id]/lock/route';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('POST /api/fiscal-periods/[id]/lock', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe bloquear un periodo fiscal existente que pertenece a la empresa', async () => {
    const user = await createTestUser('lock-admin@example.com');
    const company = await createTestCompany('Lock Company');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const period = await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'June 2026',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        endDate: new Date('2026-06-30T23:59:59.999Z'),
        isLocked: false,
      },
    });

    const req = new NextRequest(`http://localhost/api/fiscal-periods/${period.id}/lock?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await lockPOST(req, { params: Promise.resolve({ id: period.id }) });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.period.isLocked).toBe(true);

    // Verify it is actually updated in DB
    const dbPeriod = await db.fiscalPeriod.findUnique({ where: { id: period.id } });
    expect(dbPeriod?.isLocked).toBe(true);

    // Verify Audit Log was created
    const auditLogs = await db.auditLog.findMany({
      where: { companyId: company.id, action: 'PERIOD_LOCKED' },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].entityId).toBe(period.id);
  });

  it('debe devolver 400 si el periodo ya esta bloqueado', async () => {
    const user = await createTestUser('lock-admin2@example.com');
    const company = await createTestCompany('Lock Company 2');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const period = await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'June 2026',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        endDate: new Date('2026-06-30T23:59:59.999Z'),
        isLocked: true,
      },
    });

    const req = new NextRequest(`http://localhost/api/fiscal-periods/${period.id}/lock?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await lockPOST(req, { params: Promise.resolve({ id: period.id }) });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain('already locked');
  });

  it('debe devolver 404 si el periodo no existe', async () => {
    const user = await createTestUser('lock-admin3@example.com');
    const company = await createTestCompany('Lock Company 3');
    await createTestCompanyMember(user.id, company.id);
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/fiscal-periods/non-existent-id/lock?companyId=${company.id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const response = await lockPOST(req, { params: Promise.resolve({ id: 'non-existent-id' }) });
    expect(response.status).toBe(404);
  });
});
