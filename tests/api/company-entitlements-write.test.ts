// GAP #11E-A - PATCH /api/company/entitlements/[moduleKey] write contract.
//
// E1  company_admin enables AVAILABLE           => 200, commercial+effective true
// E2  company_admin disables a module           => 200, commercial+effective false
// E3  viewer PATCH                              => 403 FORBIDDEN, no mutation
// E4  foreign tenant (no membership)            => 403, no mutation
// E5  inventory enable=true                     => service rejects UNAVAILABLE (400), no bypass
// E6  PARTIAL enable with effective accounting  => 200, PARTIAL + effective true
// E7  dependent enable with accounting missing  => row persists enabled=true, engine says
//                                                  MISSING_DEPENDENCY ['accounting']
// E8  invalid moduleKey                         => 400, no mutation
// E9  invalid body / enabled not boolean        => 400, no mutation
// E10 exact active tenant used for enable/resolve
//
// The endpoint is exercised for real: apiHandler, requireCompanyContext,
// requireCompanyRole, the 11A service and the 11B engine are NOT mocked
// (PASO 9). Fixtures use the real service with controlled companies.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PATCH } from '../../src/app/api/company/entitlements/[moduleKey]/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { enableCompanyModule } from '@/lib/services/module-entitlements.service';
import { db } from '@/lib/db';

function patchRequest(
  token: string,
  companyId: string,
  moduleKey: string,
  body: string,
): Promise<Response> {
  return PATCH(
    new NextRequest(
      `http://localhost/api/company/entitlements/${moduleKey}?companyId=${companyId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      },
    ),
    { params: Promise.resolve({ moduleKey }) },
  );
}

async function makeTenant(email: string, name: string, options: { seedEntitlements?: boolean } = {}) {
  const user = await createTestUser(email);
  const company = await createTestCompany(name, 'BUSINESS', options);
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  return { user, company, token };
}

/** Real AuditLog rows for module-entitlement mutations of one tenant (no global ordering). */
async function entitlementAudits(companyId: string, entityId?: string) {
  return db.auditLog.findMany({
    where: {
      companyId,
      entity: 'CompanyModuleEntitlement',
      action: { in: ['MODULE_ENTITLEMENT_ENABLED', 'MODULE_ENTITLEMENT_DISABLED'] },
      ...(entityId ? { entityId } : {}),
    },
  });
}

describe('GAP #11E-A - PATCH /api/company/entitlements/[moduleKey]', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('E1: company_admin enables an AVAILABLE module => 200 effective', async () => {
    const { user, company, token } = await makeTenant('11e-a-e1@example.com', 'E1 Company');
    const res = await patchRequest(token, company.id, 'accounting', JSON.stringify({ enabled: true }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companyId).toBe(company.id);
    expect(body.entitlement.moduleKey).toBe('accounting');
    expect(body.entitlement.implementationStatus).toBe('AVAILABLE');
    expect(body.entitlement.commercialEnabled).toBe(true);
    expect(body.entitlement.effectiveEnabled).toBe(true);
    expect(body.entitlement.reason).toBe('EFFECTIVE_ENABLED');

    const row = await db.companyModuleEntitlement.findUnique({
      where: { companyId_moduleKey: { companyId: company.id, moduleKey: 'accounting' } },
    });
    expect(row?.enabled).toBe(true);

    // Audit written after the successful mutation (exact tenant/user/action/entity).
    const audits = await entitlementAudits(company.id, 'accounting');
    expect(audits).toHaveLength(1);
    const [enableAudit] = audits;
    expect(enableAudit.action).toBe('MODULE_ENTITLEMENT_ENABLED');
    expect(enableAudit.companyId).toBe(company.id);
    expect(enableAudit.userId).toBe(user.id);
    expect(enableAudit.entity).toBe('CompanyModuleEntitlement');
    expect(enableAudit.entityId).toBe('accounting');
    expect(JSON.parse(enableAudit.details ?? '{}')).toMatchObject({
      moduleKey: 'accounting',
      enabled: true,
      effectiveEnabled: true,
      reason: 'EFFECTIVE_ENABLED',
    });
  });

  it('E2: company_admin disables a module => 200 not effective', async () => {
    const { user, company, token } = await makeTenant('11e-a-e2@example.com', 'E2 Company');
    await enableCompanyModule(company.id, 'accounting');

    const res = await patchRequest(token, company.id, 'accounting', JSON.stringify({ enabled: false }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entitlement.commercialEnabled).toBe(false);
    expect(body.entitlement.effectiveEnabled).toBe(false);
    expect(body.entitlement.reason).toBe('COMMERCIALLY_DISABLED');

    const row = await db.companyModuleEntitlement.findUnique({
      where: { companyId_moduleKey: { companyId: company.id, moduleKey: 'accounting' } },
    });
    expect(row?.enabled).toBe(false);
    expect(row?.deactivatedAt).not.toBeNull();

    // Audit written after the successful disable (fixture service enable writes no audit).
    const audits = await entitlementAudits(company.id, 'accounting');
    expect(audits).toHaveLength(1);
    const [disableAudit] = audits;
    expect(disableAudit.action).toBe('MODULE_ENTITLEMENT_DISABLED');
    expect(disableAudit.companyId).toBe(company.id);
    expect(disableAudit.userId).toBe(user.id);
    expect(disableAudit.entityId).toBe('accounting');
    expect(JSON.parse(disableAudit.details ?? '{}')).toMatchObject({
      moduleKey: 'accounting',
      enabled: false,
      effectiveEnabled: false,
      reason: 'COMMERCIALLY_DISABLED',
    });
  });

  it('E3: viewer PATCH => 403 FORBIDDEN, mutation not executed', async () => {
    const user = await createTestUser('11e-a-e3@example.com');
    const company = await createTestCompany('E3 Company', 'BUSINESS', { seedEntitlements: false });
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    const token = await createSession(user.id);

    const res = await patchRequest(token, company.id, 'accounting', JSON.stringify({ enabled: true }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');

    const count = await db.companyModuleEntitlement.count({ where: { companyId: company.id } });
    expect(count).toBe(0);
    // Denied by RBAC before the mutation: no entitlement audit may exist.
    expect(await entitlementAudits(company.id)).toHaveLength(0);
  });

  it('E4: foreign tenant without membership => 403, mutation not executed', async () => {
    const { company: companyA } = await makeTenant('11e-a-e4a@example.com', 'E4 Company A', { seedEntitlements: false });
    const { token: tokenB } = await makeTenant('11e-a-e4b@example.com', 'E4 Company B');

    const res = await patchRequest(tokenB, companyA.id, 'accounting', JSON.stringify({ enabled: true }));

    expect(res.status).toBe(403);
    const count = await db.companyModuleEntitlement.count({ where: { companyId: companyA.id } });
    expect(count).toBe(0);
    // Denied by tenant gate before the mutation: no entitlement audit may exist.
    expect(await entitlementAudits(companyA.id)).toHaveLength(0);
  });

  it('E5: inventory enable=true => service rejects UNAVAILABLE, no bypass', async () => {
    const { company, token } = await makeTenant('11e-a-e5@example.com', 'E5 Company', { seedEntitlements: false });
    const res = await patchRequest(token, company.id, 'inventory', JSON.stringify({ enabled: true }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(String(body.error)).toContain('UNAVAILABLE');

    const count = await db.companyModuleEntitlement.count({
      where: { companyId: company.id, moduleKey: 'inventory' },
    });
    expect(count).toBe(0);
    // Rejected by the service before any persistence: no entitlement audit may exist.
    expect(await entitlementAudits(company.id)).toHaveLength(0);
  });

  it('E6: PARTIAL (purchases) enable with effective accounting => allowed', async () => {
    const { company, token } = await makeTenant('11e-a-e6@example.com', 'E6 Company');
    await enableCompanyModule(company.id, 'accounting');

    const res = await patchRequest(token, company.id, 'purchases', JSON.stringify({ enabled: true }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entitlement.moduleKey).toBe('purchases');
    expect(body.entitlement.implementationStatus).toBe('PARTIAL');
    expect(body.entitlement.effectiveEnabled).toBe(true);
    expect(body.entitlement.reason).toBe('EFFECTIVE_ENABLED');
    expect(body.entitlement.missingDependencies).toEqual([]);
  });

  it('E7: dependent enable with accounting missing => persists enabled, engine denies', async () => {
    const { company, token } = await makeTenant('11e-a-e7@example.com', 'E7 Company', { seedEntitlements: false });

    const res = await patchRequest(token, company.id, 'banking', JSON.stringify({ enabled: true }));

    // The mutation persists even though the dependency is missing (11B policy).
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entitlement.commercialEnabled).toBe(true);
    expect(body.entitlement.effectiveEnabled).toBe(false);
    expect(body.entitlement.reason).toBe('MISSING_DEPENDENCY');
    expect(body.entitlement.missingDependencies).toEqual(['accounting']);

    const row = await db.companyModuleEntitlement.findUnique({
      where: { companyId_moduleKey: { companyId: company.id, moduleKey: 'banking' } },
    });
    expect(row?.enabled).toBe(true);
  });

  it('E8: invalid moduleKey => 400, no mutation', async () => {
    const { company, token } = await makeTenant('11e-a-e8@example.com', 'E8 Company', { seedEntitlements: false });
    const res = await patchRequest(token, company.id, 'not-a-module', JSON.stringify({ enabled: true }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');

    const count = await db.companyModuleEntitlement.count({ where: { companyId: company.id } });
    expect(count).toBe(0);
    // Rejected on moduleKey validation before any mutation: no audit may exist.
    expect(await entitlementAudits(company.id)).toHaveLength(0);
  });

  it('E9: invalid body / enabled not boolean => 400, no mutation', async () => {
    const { company, token } = await makeTenant('11e-a-e9@example.com', 'E9 Company', { seedEntitlements: false });

    const badBoolean = await patchRequest(token, company.id, 'accounting', JSON.stringify({ enabled: 'yes' }));
    expect(badBoolean.status).toBe(400);
    expect((await badBoolean.json()).code).toBe('VALIDATION_ERROR');

    const badJson = await patchRequest(token, company.id, 'accounting', '{"enabled":');
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).code).toBe('VALIDATION_ERROR');

    const count = await db.companyModuleEntitlement.count({ where: { companyId: company.id } });
    expect(count).toBe(0);
    // Rejected on body validation before any mutation: no audit may exist.
    expect(await entitlementAudits(company.id)).toHaveLength(0);
  });

  it('E10: exact active tenant is used for enable and resolve', async () => {
    const { company: companyA, token } = await makeTenant('11e-a-e10a@example.com', 'E10 Company A', { seedEntitlements: false });
    const { company: companyB } = await makeTenant('11e-a-e10b@example.com', 'E10 Company B', { seedEntitlements: false });
    // Company B has its own distinct pre-state that must remain untouched.
    await enableCompanyModule(companyB.id, 'banking');

    const res = await patchRequest(token, companyA.id, 'accounting', JSON.stringify({ enabled: true }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companyId).toBe(companyA.id);
    // resolve() reported the state of company A, not company B.
    expect(body.entitlement.moduleKey).toBe('accounting');
    expect(body.entitlement.effectiveEnabled).toBe(true);

    const rowsA = await db.companyModuleEntitlement.findMany({ where: { companyId: companyA.id } });
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].moduleKey).toBe('accounting');
    expect(rowsA[0].enabled).toBe(true);

    const rowsB = await db.companyModuleEntitlement.findMany({ where: { companyId: companyB.id } });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].moduleKey).toBe('banking');
    expect(rowsB[0].enabled).toBe(true);
  });
});
