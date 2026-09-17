import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { verifyPassword } from '@/lib/auth';
import { POST as bootstrapPOST } from '@/app/api/bootstrap/restore/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { createTestCompany, clearDatabase } from '../helpers/factories';

// B3.4 — bootstrap disaster restore must establish a KNOWN recovery password
// for the first restored user, protected by the setup token, without touching
// createBackup (backups keep excluding passwordHash).
//
// The production backup shape is used on purpose: NO passwordHash in users.
// Disaster recovery must not require knowing any original password.

const isBootstrapDb = (process.env.DATABASE_URL ?? '').includes('accountexpress_bootstraptest');

const B3_COMPANY_ID = 'b3-4-company';
const B3_USER_ID = 'b3-4-user';
const B3_EMAIL = 'b3-4-first@example.com';
const RECOVERY_PASSWORD = 'KnownRecovery1!';
const GENERIC_OLD_PASSWORD = 'OldPassword42!';
const BOOTSTRAP_SECRET = 'b3-4-operator-known-secret-value';

function buildBootstrapRequest(base64Data: string, token: string | null): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers['x-bootstrap-token'] = token;
  return new NextRequest('http://localhost/api/bootstrap/restore', {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: base64Data }),
  });
}

// Production-shaped backup: no passwordHash anywhere (createBackup excludes it).
async function buildBackupBase64(): Promise<string> {
  const backupData = {
    manifest: {
      version: '1.0.0',
      companyId: B3_COMPANY_ID,
      companyInfo: { id: B3_COMPANY_ID, legalName: 'B3.4 Co', taxId: null },
      createdAt: new Date().toISOString(),
      recordCounts: {
        company: 1,
        glAccounts: 0,
        bankAccounts: 0,
        bankStatements: 0,
        bankTransactions: 0,
        bankRules: 0,
        journalEntries: 0,
        journalLines: 0,
        fiscalPeriods: 0,
        companyMembers: 1,
        users: 1,
        systemConfig: 0,
        companyConfig: false,
      },
    },
    data: {
      company: [
        {
          id: B3_COMPANY_ID,
          legalName: 'B3.4 Co',
          entityType: 'BUSINESS',
          taxId: null,
          isActive: true,
        },
      ],
      users: [
        {
          id: B3_USER_ID,
          email: B3_EMAIL,
          firstName: 'B3',
          lastName: 'First',
          role: 'company_admin',
          isActive: true,
        },
      ],
      companyMembers: [
        { id: 'b3-4-member', userId: B3_USER_ID, companyId: B3_COMPANY_ID, role: 'company_admin' },
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

async function withToken(): Promise<void> {
  process.env.BOOTSTRAP_SETUP_TOKEN = BOOTSTRAP_SECRET;
}

async function companyCount(): Promise<number> {
  return db.company.count();
}

describe.skipIf(!isBootstrapDb)('B3.4 — bootstrap recovery password contract', () => {
  beforeEach(async () => {
    delete process.env.BOOTSTRAP_SETUP_TOKEN;
    await clearDatabase();
  });

  afterEach(async () => {
    delete process.env.BOOTSTRAP_SETUP_TOKEN;
    await clearDatabase();
  });

  it('CONTRACT 1: bootstrap restore without recoveryPassword is rejected (no mutation)', async () => {
    await withToken();
    const base64 = await buildBackupBase64();
    const before = await companyCount();
    // recoveryPassword deliberately omitted: token valid, backup valid.
    const headers = { 'Content-Type': 'application/json', 'x-bootstrap-token': BOOTSTRAP_SECRET };
    const req = new NextRequest('http://localhost/api/bootstrap/restore', {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: base64 }),
    });
    const res = await bootstrapPOST(req, { params: Promise.resolve({}) });
    const after = await companyCount();
    expect(res.status).toBe(400);
    expect(after).toBe(before);
    expect(Boolean(res.cookies.get('session'))).toBe(false);
  });

  it('CONTRACT 2: weak recoveryPassword is rejected (product policy: min 8 chars)', async () => {
    await withToken();
    const base64 = await buildBackupBase64();
    const before = await companyCount();
    const headers = { 'Content-Type': 'application/json', 'x-bootstrap-token': BOOTSTRAP_SECRET };
    const req = new NextRequest('http://localhost/api/bootstrap/restore', {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: base64, recoveryPassword: 'short' }),
    });
    const res = await bootstrapPOST(req, { params: Promise.resolve({}) });
    const after = await companyCount();
    expect(res.status).toBe(400);
    expect(after).toBe(before);
    const bodyText = await res.text();
    expect(bodyText).not.toContain('short');
  });

  it('CONTRACT 3: invalid setup token + valid recoveryPassword is rejected, no recovery', async () => {
    await withToken();
    const base64 = await buildBackupBase64();
    const before = await companyCount();
    const res = await bootstrapPOST(buildBootstrapRequest(base64, 'wrong-token-value'), {
      params: Promise.resolve({}),
    });
    const after = await companyCount();
    expect(res.status).toBe(403);
    expect(after).toBe(before);
    expect(Boolean(res.cookies.get('session'))).toBe(false);
  });

  it('CONTRACTS 4-6: valid bootstrap restore establishes the recovery password without any original password', async () => {
    await withToken();
    const base64 = await buildBackupBase64();
    const headers = { 'Content-Type': 'application/json', 'x-bootstrap-token': BOOTSTRAP_SECRET };
    const req = new NextRequest('http://localhost/api/bootstrap/restore', {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: base64, recoveryPassword: RECOVERY_PASSWORD }),
    });
    const res = await bootstrapPOST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    // CONTRACT 5: the recovery password verifies against the persisted hash.
    const firstUser = await db.user.findUnique({
      where: { id: B3_USER_ID },
      select: { id: true, email: true, passwordHash: true },
    });
    expect(firstUser?.email).toBe(B3_EMAIL);
    expect(firstUser?.passwordHash).toBeDefined();
    const recoveryWorks = await verifyPassword(RECOVERY_PASSWORD, firstUser!.passwordHash);
    // CONTRACT 6/9: no original/default password is assumed or required.
    const adminDefault = await verifyPassword('Admin123!', firstUser!.passwordHash);
    const anyOldPassword = await verifyPassword(GENERIC_OLD_PASSWORD, firstUser!.passwordHash);
    expect(recoveryWorks).toBe(true);
    expect(adminDefault).toBe(false);
    expect(anyOldPassword).toBe(false);
  });

  it('CONTRACT 7: the bootstrap session belongs to the restored first user (login works with the recovery password only)', async () => {
    await withToken();
    const base64 = await buildBackupBase64();
    const headers = { 'Content-Type': 'application/json', 'x-bootstrap-token': BOOTSTRAP_SECRET };
    const req = new NextRequest('http://localhost/api/bootstrap/restore', {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: base64, recoveryPassword: RECOVERY_PASSWORD }),
    });
    const res = await bootstrapPOST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    // Session cookie issued by the bootstrap route itself.
    expect(res.cookies.get('session')).toBeDefined();

    // Only the recovery password authenticates the restored first user.
    const loginRes = await loginPOST(
      new NextRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: B3_EMAIL, password: RECOVERY_PASSWORD }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(loginRes.status).toBe(200);

    const wrongLogin = await loginPOST(
      new NextRequest('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: B3_EMAIL, password: 'Admin123!' }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(wrongLogin.status).not.toBe(200);
  });
});
