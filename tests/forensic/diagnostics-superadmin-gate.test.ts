import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { GET as diagnosticsGET } from '@/app/api/diagnostics/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  createTestJournalEntry,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE-DSA]', ...args);

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

function noAuthHeaders(): Headers {
  return new Headers();
}

/**
 * Spies covering every global-surface query of GET /api/diagnostics:
 * pg_database_size (db.$queryRawUnsafe) + the six global free counters.
 */
type DiagSpies = {
  queryRawUnsafe: ReturnType<typeof vi.spyOn>;
  glAccountCount: ReturnType<typeof vi.spyOn>;
  journalEntryCount: ReturnType<typeof vi.spyOn>;
  bankAccountCount: ReturnType<typeof vi.spyOn>;
  bankRuleCount: ReturnType<typeof vi.spyOn>;
  bankTransactionCount: ReturnType<typeof vi.spyOn>;
};

function installDiagSpies(): DiagSpies {
  return {
    queryRawUnsafe: vi.spyOn(db, '$queryRawUnsafe'),
    glAccountCount: vi.spyOn(db.glAccount, 'count'),
    journalEntryCount: vi.spyOn(db.journalEntry, 'count'),
    bankAccountCount: vi.spyOn(db.bankAccount, 'count'),
    bankRuleCount: vi.spyOn(db.bankRule, 'count'),
    bankTransactionCount: vi.spyOn(db.bankTransaction, 'count'),
  };
}

function assertZeroGlobalQueries(spies: DiagSpies) {
  expect(spies.queryRawUnsafe).not.toHaveBeenCalled();
  expect(spies.glAccountCount).not.toHaveBeenCalled();
  expect(spies.journalEntryCount).not.toHaveBeenCalled();
  expect(spies.bankAccountCount).not.toHaveBeenCalled();
  expect(spies.bankRuleCount).not.toHaveBeenCalled();
  expect(spies.bankTransactionCount).not.toHaveBeenCalled();
}

describe('DIAGNOSTICS SUPER_ADMIN GATE — /api/diagnostics is INSTANCE_GLOBAL, super_admin only', () => {
  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDatabase();
  });

  function expectDiagnosticsStructure(body: Record<string, unknown>) {
    expect((body.database as { status?: string }).status).toBe('connected');
    expect(body.database).toHaveProperty('size');
    expect(body.database).toHaveProperty('tables');
    expect(body.accounts).toHaveProperty('total');
    expect(body.accounts).toHaveProperty('active');
    expect(body.journalEntries).toHaveProperty('total');
    expect(body.journalEntries).toHaveProperty('posted');
    expect(body.journalEntries).toHaveProperty('draft');
    expect(body.bankAccounts).toHaveProperty('total');
    expect(body.bankRules).toHaveProperty('total');
    expect(body.bankRules).toHaveProperty('active');
    expect(body.transactions).toHaveProperty('total');
    expect(body.transactions).toHaveProperty('reconciled');
    expect(body.transactions).toHaveProperty('unreconciled');
    expect(body.system).toHaveProperty('uptime');
    expect(body.system).toHaveProperty('version');
  }

  // Seeds a second, non-member tenant with real data so global counters
  // would definitely be non-zero if the handler were ever reached.
  async function seedVictimTenant(): Promise<string> {
    const victim = await createTestCompany('DSA Victim Tenant');
    const victimGl = await createTestGlAccount({ companyId: victim.id, code: '1000', name: 'Victim Cash' });
    const victimBank = await createTestBankAccount(victim.id, victimGl.id, 'Victim Bank');
    const victimStatement = await createTestBankStatement(victim.id, victimBank.id);
    await createTestBankTransaction(victim.id, victimStatement.id, {
      date: '2025-04-01',
      amount: 500,
      description: 'Victim txn',
    });
    await createTestJournalEntry(victim.id, {
      date: '2025-04-01',
      description: 'Victim JE',
      lines: [{ glAccountId: victimGl.id, debit: 500, credit: 0 }],
    });
    await db.bankRule.create({
      data: { companyId: victim.id, name: 'Victim Rule', conditionType: 'keyword', conditionValue: 'loan' },
    });
    return victim.id;
  }

  it('A. super_admin WITHOUT membership → 200, full Diagnostics structure', async () => {
    await seedVictimTenant();
    const superUser = await db.user.create({
      data: {
        email: 'super-dsa@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Super',
        lastName: 'Admin',
        role: 'super_admin',
      },
    });
    expect(await db.companyMember.count({ where: { userId: superUser.id } })).toBe(0);

    const token = await createSession(superUser.id);
    const res = await diagnosticsGET(
      new NextRequest('http://localhost/api/diagnostics', {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('A super_admin no membership:', res.status, '| body:', JSON.stringify(body));
    expect(res.status).toBe(200);
    expectDiagnosticsStructure(body);
  });

  it('B. company_admin → 403, zero global queries', async () => {
    await seedVictimTenant();
    const admin = await createTestUser('admin-dsa@example.com');
    const ownCompany = await createTestCompany('DSA Own Tenant');
    await createTestCompanyMember(admin.id, ownCompany.id);

    const spies = installDiagSpies();
    const token = await createSession(admin.id);
    const res = await diagnosticsGET(
      new NextRequest('http://localhost/api/diagnostics', {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('B company_admin:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    assertZeroGlobalQueries(spies);
  });

  it('C. User.role=company_admin + Member.role=employee → 403, zero global queries', async () => {
    await seedVictimTenant();
    const user = await createTestUser('employee-dsa@example.com');
    const ownCompany = await createTestCompany('DSA Emp Tenant');
    await db.companyMember.create({
      data: { userId: user.id, companyId: ownCompany.id, role: 'employee' },
    });

    const spies = installDiagSpies();
    const token = await createSession(user.id);
    const res = await diagnosticsGET(
      new NextRequest('http://localhost/api/diagnostics', {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('C employee member:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    assertZeroGlobalQueries(spies);
  });

  it('D. User.role=company_admin + Member.role=viewer → 403, zero global queries', async () => {
    await seedVictimTenant();
    const user = await createTestUser('viewer-dsa@example.com');
    const ownCompany = await createTestCompany('DSA Viewer Tenant');
    await db.companyMember.create({
      data: { userId: user.id, companyId: ownCompany.id, role: 'viewer' },
    });

    const spies = installDiagSpies();
    const token = await createSession(user.id);
    const res = await diagnosticsGET(
      new NextRequest('http://localhost/api/diagnostics', {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('D viewer member:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    assertZeroGlobalQueries(spies);
  });

  it('E. User.role=company_admin WITHOUT membership → 403, zero global queries', async () => {
    await seedVictimTenant();
    const user = await createTestUser('nomember-dsa@example.com');
    expect(await db.companyMember.count({ where: { userId: user.id } })).toBe(0);

    const spies = installDiagSpies();
    const token = await createSession(user.id);
    const res = await diagnosticsGET(
      new NextRequest('http://localhost/api/diagnostics', {
        method: 'GET',
        headers: authHeaders(token),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('E company_admin no membership:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    assertZeroGlobalQueries(spies);
  });

  it('F. anonymous / invalid session → 401, zero global queries', async () => {
    await seedVictimTenant();
    const spies = installDiagSpies();

    const res = await diagnosticsGET(
      new NextRequest('http://localhost/api/diagnostics', {
        method: 'GET',
        headers: noAuthHeaders(),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('F anonymous:', res.status, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(401);
    assertZeroGlobalQueries(spies);
  });

  it('G. control: rejected member, real victim data exists under victim tenant', async () => {
    const victimId = await seedVictimTenant();
    const victimGl = await db.glAccount.count({ where: { companyId: victimId } });
    const victimJe = await db.journalEntry.count({ where: { companyId: victimId } });
    const victimBank = await db.bankAccount.count({ where: { companyId: victimId } });
    const victimRule = await db.bankRule.count({ where: { companyId: victimId } });
    const victimTxn = await db.bankTransaction.count({
      where: { statement: { companyId: victimId } },
    });
    log('G victim tenant data: gl=', victimGl, 'je=', victimJe, 'bank=', victimBank, 'rule=', victimRule, 'txn=', victimTxn);
    expect(victimGl).toBeGreaterThan(0);
    expect(victimJe).toBeGreaterThan(0);
    expect(victimBank).toBeGreaterThan(0);
    expect(victimRule).toBeGreaterThan(0);
    expect(victimTxn).toBeGreaterThan(0);
  });
});