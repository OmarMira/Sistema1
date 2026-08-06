import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
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
const BOOTSTRAP_SECRET = 'f9-operator-known-secret-value';

const q4CompanyIds = new Set<string>();

const isBootstrapDb = (process.env.DATABASE_URL ?? '').includes('accountexpress_bootstraptest');

function buildBootstrapRequest(base64Data: string, token: string | null): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers['x-bootstrap-token'] = token;
  return new NextRequest('http://localhost/api/bootstrap/restore', {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: base64Data }),
  });
}

async function buildForgedBackupBase64(passwordHash: string, includeSystemBootstrap = true): Promise<string> {
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

// A body that WOULD be rejected with 400 ("Datos inválidos") if the route parsed
// it. These cases prove the guards (409/503/403) fire BEFORE any body processing.
function buildInvalidBodyRequest(token: string | null): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers['x-bootstrap-token'] = token;
  return new NextRequest('http://localhost/api/bootstrap/restore', {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: '%%%not-valid-base64%%%' }),
  });
}

describe.skipIf(!isBootstrapDb)('F-9 — bootstrap/restore requires a server-side setup token (RED policy)', () => {
  beforeEach(async () => {
    delete process.env.BOOTSTRAP_SETUP_TOKEN;
    authRateLimiter.clear();
    await clearDatabase();
  });

  afterEach(async () => {
    delete process.env.BOOTSTRAP_SETUP_TOKEN;
    vi.restoreAllMocks();
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

  it('REQUIRED (RED today): empty DB + server token NOT configured -> 503 (fail-closed)', async () => {
    const hash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(hash);
    const before = await db.company.count();
    log('S1-SEEDED: companies =', before, '| BOOTSTRAP_SETUP_TOKEN configured =', Boolean(process.env.BOOTSTRAP_SETUP_TOKEN));
    const res = await bootstrapPOST(buildBootstrapRequest(base64, BOOTSTRAP_SECRET), { params: Promise.resolve({}) });
    log('S1: empty DB, token in env ABSENT -> status =', res.status);
    expect(res.status).toBe(503);
  });

  it('REQUIRED (RED today): empty DB + header absent -> 403', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const hash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(hash);
    const res = await bootstrapPOST(buildBootstrapRequest(base64, null), { params: Promise.resolve({}) });
    log('S2: empty DB, token configured, NO header -> status =', res.status);
    expect(res.status).toBe(403);
  });

  it('REQUIRED (RED today): empty DB + wrong token -> 403', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const hash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(hash);
    const res = await bootstrapPOST(buildBootstrapRequest(base64, 'wrong-token-value'), { params: Promise.resolve({}) });
    log('S3: empty DB, WRONG token in header -> status =', res.status);
    expect(res.status).toBe(403);
  });

  it('REQUIRED: empty DB + correct token + valid backup -> 200 and a session is issued', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const hash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(hash);
    const res = await bootstrapPOST(buildBootstrapRequest(base64, BOOTSTRAP_SECRET), { params: Promise.resolve({}) });
    const token = res.cookies.get('session')?.value;
    const body = await res.json();
    log('S4: correct token + valid backup -> status =', res.status, '| session =', Boolean(token), '| user =', body.user?.email);
    expect(res.status).toBe(200);
    expect(token).toBeDefined();
  });

  it('REQUIRED: DB already initialized + correct token -> 409 (guard checked before token)', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const existing = await createTestCompany('Existing Co');
    q4CompanyIds.add(existing.id);
    const hash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(hash);
    const res = await bootstrapPOST(buildBootstrapRequest(base64, BOOTSTRAP_SECRET), { params: Promise.resolve({}) });
    const body = await res.json();
    log('S5: initialized DB + correct token -> status =', res.status, '| code =', body.code);
    expect(res.status).toBe(409);
    expect(body.code).toBe('DB_NOT_EMPTY');
  });

  it('REQUIRED: correct token + invalid backup -> 400 with NO mutation', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const invalidBackup = Buffer.from(JSON.stringify({ manifest: {}, data: {} })).toString('base64');
    const before = await db.company.count();
    const res = await bootstrapPOST(buildBootstrapRequest(invalidBackup, BOOTSTRAP_SECRET), { params: Promise.resolve({}) });
    const after = await db.company.count();
    log('S6: invalid backup + correct token -> status =', res.status, '| companies before=', before, 'after=', after);
    expect(res.status).toBe(400);
    expect(after).toBe(before);
  });

  it('REQUIRED: the token never appears in the response or any audit payload', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const hash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(hash);
    const res = await bootstrapPOST(buildBootstrapRequest(base64, BOOTSTRAP_SECRET), { params: Promise.resolve({}) });
    const responseText = await res.text();
    const audits = await db.auditLog.findMany({ take: 50 });
    const leakedInResponse = responseText.includes(BOOTSTRAP_SECRET);
    const leakedInAudit = JSON.stringify(audits).includes(BOOTSTRAP_SECRET);
    log('S7: token leaked in response text =', leakedInResponse, '| leaked in audit payload =', leakedInAudit);
    expect(leakedInResponse).toBe(false);
    expect(leakedInAudit).toBe(false);
  });

  it('A1: DB initialized + invalid body -> 409 (guard fires before body is parsed)', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const existing = await createTestCompany('Order Co');
    q4CompanyIds.add(existing.id);
    const res = await bootstrapPOST(buildInvalidBodyRequest(BOOTSTRAP_SECRET), { params: Promise.resolve({}) });
    log('A1: initialized DB + invalid body -> status =', res.status);
    expect(res.status).toBe(409);
  });

  it('A2: server token absent + invalid body -> 503 (body never parsed)', async () => {
    delete process.env.BOOTSTRAP_SETUP_TOKEN;
    const res = await bootstrapPOST(buildInvalidBodyRequest(BOOTSTRAP_SECRET), { params: Promise.resolve({}) });
    log('A2: token absent + invalid body -> status =', res.status);
    expect(res.status).toBe(503);
  });

  it('A3: header absent + invalid body -> 403 (body never parsed)', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const res = await bootstrapPOST(buildInvalidBodyRequest(null), { params: Promise.resolve({}) });
    log('A3: header absent + invalid body -> status =', res.status);
    expect(res.status).toBe(403);
  });

  it('A4: wrong token + invalid body -> 403 (body never parsed)', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const res = await bootstrapPOST(buildInvalidBodyRequest('wrong-token-value'), { params: Promise.resolve({}) });
    log('A4: wrong token + invalid body -> status =', res.status);
    expect(res.status).toBe(403);
  });

  it('B1: the token never appears in any application logger call', async () => {
    process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
    const infoSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');
    // Sentinel: proves the spies actually intercept real logger calls.
    infoSpy('SENTINEL-9-UNIQUE-MARKER', {});

    const hash = await hashPassword(ATTACKER_PASSWORD);
    const base64 = await buildForgedBackupBase64(hash);
    await bootstrapPOST(buildBootstrapRequest(base64, BOOTSTRAP_SECRET), { params: Promise.resolve({}) });
    await bootstrapPOST(buildBootstrapRequest(base64, 'wrong-token-value'), { params: Promise.resolve({}) });
    await bootstrapPOST(buildInvalidBodyRequest(null), { params: Promise.resolve({}) });

    const calls = [
      ...infoSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...warnSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...errorSpy.mock.calls.map((c) => JSON.stringify(c)),
    ];
    const spyWorks = calls.some((c) => c.includes('SENTINEL-9-UNIQUE-MARKER'));
    const leaked = calls.some((c) => c.includes(BOOTSTRAP_SECRET));
    log('B1: logger calls =', calls.length, '| spy attached =', spyWorks, '| token leaked in any logger call =', leaked);
    expect(spyWorks).toBe(true);
    expect(leaked).toBe(false);
  });
});