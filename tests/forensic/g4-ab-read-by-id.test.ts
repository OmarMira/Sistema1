import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { clearDatabase, createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, createTestBankAccount, createTestBankStatement, createTestBankTransaction } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE-G4-AB-READ]', ...args);

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-placeholder'));
const mockCreateAuditLog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/audit', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/audit')>();
  mockCreateAuditLog.mockImplementation(mod.createAuditLogWithRetry);
  return {
    ...mod,
    createAuditLogWithRetry: mockCreateAuditLog,
  };
});

const createdCompanyIds = new Set<string>();
const createdKnowledgeIds = new Set<string>();

async function createKnowledgeEntity(companyId: string, canonicalName: string) {
  const entity = await db.companyKnowledge.create({
    data: {
      companyId,
      canonicalName,
      type: 'COMPANY',
      aliases: [],
      source: 'company_knowledge',
      status: 'active',
      version: 1,
      metadata: {},
    },
  });
  createdKnowledgeIds.add(entity.id);
  await db.knowledgeAudit.create({
    data: {
      knowledgeId: entity.id,
      action: 'create',
      version: 1,
      changedByUserId: 'test-user',
      source: 'company_knowledge',
      reason: 'Entity created',
    },
  });
  return entity;
}

async function cleanup() {
  if (createdKnowledgeIds.size > 0) {
    await db.knowledgeAudit.deleteMany({ where: { knowledgeId: { in: [...createdKnowledgeIds] } } }).catch(() => {});
    await db.companyKnowledge.deleteMany({ where: { id: { in: [...createdKnowledgeIds] } } }).catch(() => {});
    createdKnowledgeIds.clear();
  }
  if (createdCompanyIds.size > 0) {
    await db.bankRule.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.reconciliationPeriod.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.companyKnowledge.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.companyMember.deleteMany({ where: { companyId: { in: [...createdCompanyIds] } } }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: [...createdCompanyIds] } } }).catch(() => {});
    createdCompanyIds.clear();
  }
  await clearDatabase();
}

describe('G4-AB-READ-BY-ID — Cross-tenant read + single-resource PATCH matrix (A/B)', () => {
  beforeEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    mockGetSessionUserId.mockResolvedValue('user-placeholder');
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function seedTenants() {
    const tenantA = await createTestCompany('G4 AB Tenant A');
    createdCompanyIds.add(tenantA.id);
    const tenantB = await createTestCompany('G4 AB Tenant B');
    createdCompanyIds.add(tenantB.id);
    const attacker = await createTestUser('attacker-g4ab@example.com');
    await createTestCompanyMember(attacker.id, tenantA.id);
    const ownerB = await createTestUser('owner-g4ab@example.com');
    await createTestCompanyMember(ownerB.id, tenantB.id);
    return { tenantA, tenantB, attacker, ownerB };
  }

  it('A-id: GET /api/accounts/[id] — member of A cannot read account of B (404 neutral)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const victimGl = await createTestGlAccount({
      companyId: tenantB.id,
      code: '1111',
      name: 'Victim Account B',
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/accounts/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/accounts/${victimGl.id}?companyId=${tenantA.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: victimGl.id }) },
    );
    log('A-id accounts GET status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Account not found');
    expect(body).not.toHaveProperty('account');
  });

  it('A-spoof: GET /api/accounts/[id]?companyId=B returns 403 to non-member', async () => {
    const { tenantB, attacker } = await seedTenants();
    const victimGl = await createTestGlAccount({
      companyId: tenantB.id,
      code: '1111',
      name: 'Victim Account B',
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/accounts/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/accounts/${victimGl.id}?companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: victimGl.id }) },
    );
    log('A-spoof accounts GET status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/accounts/[id] — owner obtains own account (200)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const ownGl = await createTestGlAccount({
      companyId: tenantB.id,
      code: '2222',
      name: 'Own Account B',
    });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/accounts/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/accounts/${ownGl.id}?companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: ownGl.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account.id).toBe(ownGl.id);
    expect(body.account.name).toBe('Own Account B');
  });

  it('A-id: GET /api/banks/[id] — member of A cannot read bank account of B (404 neutral)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const victimBank = await createTestBankAccount(tenantB.id, bankGl.id, 'Victim Bank B');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/banks/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/banks/${victimBank.id}?companyId=${tenantA.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: victimBank.id }) },
    );
    log('A-id banks GET status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Bank account not found');
  });

  it('A-spoof: GET /api/banks/[id]?companyId=B returns 403 to non-member', async () => {
    const { tenantB, attacker } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const victimBank = await createTestBankAccount(tenantB.id, bankGl.id, 'Victim Bank B');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/banks/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/banks/${victimBank.id}?companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: victimBank.id }) },
    );
    log('A-spoof banks GET status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/banks/[id] — owner reads own bank account with recentTransactions (200)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Own Bank B');
    const statement = await createTestBankStatement(tenantB.id, bank.id);
    await createTestBankTransaction(tenantB.id, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'OWN DEPOSIT',
    });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/banks/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/banks/${bank.id}?companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: bank.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account.id).toBe(bank.id);
    expect(body.account.recentTransactions).toBeDefined();
    expect(body.account.recentTransactions[0].description).toBe('OWN DEPOSIT');
  });

  it('A-id: GET /api/bank-rules/[id] — member of A cannot read rule of B (404 neutral)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const gl = await createTestGlAccount({ companyId: tenantB.id, code: '6000', name: 'Expense B' });
    const rule = await db.bankRule.create({
      data: {
        companyId: tenantB.id,
        name: 'Victim Rule B',
        conditionType: 'contains',
        conditionValue: 'SECRET',
        transactionDirection: 'any',
        glAccountId: gl.id,
        priority: 10,
        isActive: true,
      },
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/bank-rules/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/bank-rules/${rule.id}?companyId=${tenantA.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    log('A-id bank-rules GET status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Rule not found');
  });

  it('A-spoof: GET /api/bank-rules/[id]?companyId=B returns 403 to non-member', async () => {
    const { tenantB, attacker } = await seedTenants();
    const gl = await createTestGlAccount({ companyId: tenantB.id, code: '6000', name: 'Expense B' });
    const rule = await db.bankRule.create({
      data: {
        companyId: tenantB.id,
        name: 'Victim Rule B',
        conditionType: 'contains',
        conditionValue: 'SECRET',
        transactionDirection: 'any',
        glAccountId: gl.id,
        priority: 10,
        isActive: true,
      },
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { GET } = await import('@/app/api/bank-rules/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/bank-rules/${rule.id}?companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    log('A-spoof bank-rules GET status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: GET /api/bank-rules/[id] — owner reads own rule (200)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const gl = await createTestGlAccount({ companyId: tenantB.id, code: '6000', name: 'Expense B' });
    const rule = await db.bankRule.create({
      data: {
        companyId: tenantB.id,
        name: 'Own Rule B',
        conditionType: 'contains',
        conditionValue: 'OWN',
        transactionDirection: 'any',
        glAccountId: gl.id,
        priority: 10,
        isActive: true,
      },
    });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { GET } = await import('@/app/api/bank-rules/[id]/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/bank-rules/${rule.id}?companyId=${tenantB.id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(rule.id);
    expect(body.name).toBe('Own Rule B');
  });

  it('A-id: PATCH /api/fiscal-periods/[id] — member of A cannot lock period of B (404 neutral, no mutation)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const victimPeriod = await db.fiscalPeriod.create({
      data: {
        companyId: tenantB.id,
        name: '2025-06',
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-06-30'),
        isLocked: false,
      },
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { PATCH } = await import('@/app/api/fiscal-periods/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${victimPeriod.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantA.id, isLocked: true }),
      }),
      { params: Promise.resolve({ id: victimPeriod.id }) },
    );
    log('A-id fiscal-period PATCH status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Period not found');

    const stored = await db.fiscalPeriod.findUnique({ where: { id: victimPeriod.id } });
    expect(stored?.isLocked).toBe(false);
  });

  it('A-spoof: PATCH /api/fiscal-periods/[id] body companyId=B returns 403 to non-member', async () => {
    const { tenantB, attacker } = await seedTenants();
    const victimPeriod = await db.fiscalPeriod.create({
      data: {
        companyId: tenantB.id,
        name: '2025-06',
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-06-30'),
        isLocked: false,
      },
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { PATCH } = await import('@/app/api/fiscal-periods/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${victimPeriod.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, isLocked: true }),
      }),
      { params: Promise.resolve({ id: victimPeriod.id }) },
    );
    log('A-spoof fiscal-period PATCH status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: PATCH /api/fiscal-periods/[id] — owner locks own period (200 + audit)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const ownPeriod = await db.fiscalPeriod.create({
      data: {
        companyId: tenantB.id,
        name: '2025-07',
        startDate: new Date('2025-07-01'),
        endDate: new Date('2025-07-31'),
        isLocked: false,
      },
    });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { PATCH } = await import('@/app/api/fiscal-periods/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/fiscal-periods/${ownPeriod.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, isLocked: true }),
      }),
      { params: Promise.resolve({ id: ownPeriod.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period.id).toBe(ownPeriod.id);
    expect(body.period.isLocked).toBe(true);

    const stored = await db.fiscalPeriod.findUnique({ where: { id: ownPeriod.id } });
    expect(stored?.isLocked).toBe(true);
    const audit = await db.auditLog.findFirst({
      where: { companyId: tenantB.id, entity: 'FiscalPeriod', entityId: ownPeriod.id },
    });
    expect(audit?.action).toBe('PERIOD_LOCKED');
  });

  it('A-id: PATCH /api/entity-context/[id] — member of A cannot modify entity context of B (404 neutral)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const ctxB = await db.entityContext.create({
      data: {
        companyId: tenantB.id,
        pattern: 'VICTIM CONTEXT',
        role: 'VENDOR',
        source: 'user',
      },
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { PATCH } = await import('@/app/api/entity-context/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/entity-context/${ctxB.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantA.id, role: 'customer' }),
      }),
      { params: Promise.resolve({ id: ctxB.id }) },
    );
    log('A-id entity-context PATCH status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Entity not found');

    const stored = await db.entityContext.findUnique({ where: { id: ctxB.id } });
    expect(stored?.role).toBe('VENDOR');
  });

  it('A-spoof: PATCH /api/entity-context/[id] body companyId=B returns 403 to non-member', async () => {
    const { tenantB, attacker } = await seedTenants();
    const ctxB = await db.entityContext.create({
      data: {
        companyId: tenantB.id,
        pattern: 'VICTIM CONTEXT 2',
        role: 'VENDOR',
        source: 'user',
      },
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { PATCH } = await import('@/app/api/entity-context/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/entity-context/${ctxB.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, role: 'customer' }),
      }),
      { params: Promise.resolve({ id: ctxB.id }) },
    );
    log('A-spoof entity-context PATCH status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: PATCH /api/entity-context/[id] — owner updates own entity context (200)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const ctxB = await db.entityContext.create({
      data: {
        companyId: tenantB.id,
        pattern: 'OWN CONTEXT',
        role: 'VENDOR',
        source: 'user',
      },
    });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { PATCH } = await import('@/app/api/entity-context/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/entity-context/${ctxB.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, role: 'customer' }),
      }),
      { params: Promise.resolve({ id: ctxB.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.role).toBe('CUSTOMER');
  });

  it('A-id: PATCH /api/transactions/[id] — member of A cannot assign GL to transaction of B (404 neutral)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const attackerGl = await createTestGlAccount({ companyId: tenantA.id, code: '7000', name: 'Attacker GL' });
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Victim Bank B');
    const statement = await createTestBankStatement(tenantB.id, bank.id);
    const txB = await createTestBankTransaction(tenantB.id, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'VICTIM PAYMENT',
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { PATCH } = await import('@/app/api/transactions/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/transactions/${txB.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantA.id, glAccountId: attackerGl.id }),
      }),
      { params: Promise.resolve({ id: txB.id }) },
    );
    log('A-id transactions PATCH status:', res.status);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Transaction not found');

    const stored = await db.bankTransaction.findUnique({ where: { id: txB.id } });
    expect(stored?.glAccountId).toBeNull();
    expect(stored?.journalEntryId).toBeNull();
  });

  it('A-spoof: PATCH /api/transactions/[id] body companyId=B returns 403 to non-member', async () => {
    const { tenantB, attacker } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Victim Bank B');
    const statement = await createTestBankStatement(tenantB.id, bank.id);
    const txB = await createTestBankTransaction(tenantB.id, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'VICTIM PAYMENT',
    });
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { PATCH } = await import('@/app/api/transactions/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/transactions/${txB.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, glAccountId: bankGl.id }),
      }),
      { params: Promise.resolve({ id: txB.id }) },
    );
    log('A-spoof transactions PATCH status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: PATCH /api/transactions/[id] — owner assigns GL to own transaction and gets journal entry (200)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const bankGl = await createTestGlAccount({ companyId: tenantB.id, code: '1000', name: 'Cash B' });
    const counterpartGl = await createTestGlAccount({ companyId: tenantB.id, code: '6000', name: 'Expense B' });
    const bank = await createTestBankAccount(tenantB.id, bankGl.id, 'Own Bank B');
    const statement = await createTestBankStatement(tenantB.id, bank.id);
    const tx = await createTestBankTransaction(tenantB.id, statement.id, {
      date: '2025-06-15',
      amount: 500,
      description: 'OWN EXPENSE',
    });
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { PATCH } = await import('@/app/api/transactions/[id]/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/transactions/${tx.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, glAccountId: counterpartGl.id }),
      }),
      { params: Promise.resolve({ id: tx.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transaction.id).toBe(tx.id);
    expect(body.transaction.glAccountId).toBe(counterpartGl.id);
    expect(body.transaction.journalEntryId).toBeTruthy();

    const stored = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(stored?.glAccountId).toBe(counterpartGl.id);
    expect(stored?.journalEntryId).toBeTruthy();
  });

  it('A-id: POST /api/company-knowledge/[id]/archive — member of A cannot archive knowledge of B (400 isolation, no mutation)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const knowledgeB = await createKnowledgeEntity(tenantB.id, 'Victim Knowledge B');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/company-knowledge/[id]/archive/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/company-knowledge/${knowledgeB.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantA.id }),
      }),
      { params: Promise.resolve({ id: knowledgeB.id }) },
    );
    log('A-id archive status:', res.status);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Company isolation violation');

    const stored = await db.companyKnowledge.findUnique({ where: { id: knowledgeB.id } });
    expect(stored?.status).toBe('active');
    expect(stored?.version).toBe(1);
  });

  it('A-spoof: POST /api/company-knowledge/[id]/archive body companyId=B returns 403 to non-member', async () => {
    const { tenantB, attacker } = await seedTenants();
    const knowledgeB = await createKnowledgeEntity(tenantB.id, 'Victim Knowledge B 2');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/company-knowledge/[id]/archive/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/company-knowledge/${knowledgeB.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id }),
      }),
      { params: Promise.resolve({ id: knowledgeB.id }) },
    );
    log('A-spoof archive status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: POST /api/company-knowledge/[id]/archive — owner archives own knowledge (200 + version bump)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const knowledgeB = await createKnowledgeEntity(tenantB.id, 'Own Knowledge B');
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { POST } = await import('@/app/api/company-knowledge/[id]/archive/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/company-knowledge/${knowledgeB.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, reason: 'archive test' }),
      }),
      { params: Promise.resolve({ id: knowledgeB.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.knowledgeId).toBe(knowledgeB.id);
    expect(body.status).toBe('archived');
    expect(body.version).toBe(2);

    const stored = await db.companyKnowledge.findUnique({ where: { id: knowledgeB.id } });
    expect(stored?.status).toBe('archived');
    expect(stored?.version).toBe(2);
  });

  it('A-id: POST /api/company-knowledge/[id]/merge — member of A cannot merge knowledge of B (400 isolation, no mutation)', async () => {
    const { tenantA, tenantB, attacker } = await seedTenants();
    const sourceB = await createKnowledgeEntity(tenantB.id, 'Source B');
    const targetB = await createKnowledgeEntity(tenantB.id, 'Target B');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/company-knowledge/[id]/merge/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/company-knowledge/${targetB.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantA.id, sourceKnowledgeId: sourceB.id, fieldResolutions: {} }),
      }),
      { params: Promise.resolve({ id: targetB.id }) },
    );
    log('A-id merge status:', res.status);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Company isolation violation');

    const storedSource = await db.companyKnowledge.findUnique({ where: { id: sourceB.id } });
    expect(storedSource?.status).toBe('active');
    expect(storedSource?.mergedIntoId).toBeNull();
  });

  it('A-spoof: POST /api/company-knowledge/[id]/merge body companyId=B returns 403 to non-member', async () => {
    const { tenantB, attacker } = await seedTenants();
    const sourceB = await createKnowledgeEntity(tenantB.id, 'Source B 2');
    const targetB = await createKnowledgeEntity(tenantB.id, 'Target B 2');
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const { POST } = await import('@/app/api/company-knowledge/[id]/merge/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/company-knowledge/${targetB.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, sourceKnowledgeId: sourceB.id, fieldResolutions: {} }),
      }),
      { params: Promise.resolve({ id: targetB.id }) },
    );
    log('A-spoof merge status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('B: POST /api/company-knowledge/[id]/merge — owner merges own source into own target (200)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    const sourceB = await createKnowledgeEntity(tenantB.id, 'Source B 3');
    const targetB = await createKnowledgeEntity(tenantB.id, 'Target B 3');
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const { POST } = await import('@/app/api/company-knowledge/[id]/merge/route');
    const res = await POST(
      new NextRequest(`http://localhost/api/company-knowledge/${targetB.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: tenantB.id, sourceKnowledgeId: sourceB.id, fieldResolutions: {} }),
      }),
      { params: Promise.resolve({ id: targetB.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.knowledgeId).toBe(targetB.id);
    expect(body.version).toBe(2);

    const storedSource = await db.companyKnowledge.findUnique({ where: { id: sourceB.id } });
    expect(storedSource?.status).toBe('merged');
    expect(storedSource?.mergedIntoId).toBe(targetB.id);
    const storedTarget = await db.companyKnowledge.findUnique({ where: { id: targetB.id } });
    expect(storedTarget?.version).toBe(2);
  });

  it('A-spoof: PATCH /api/company/profile?companyId=B — non-member cannot update profile of B (403)', async () => {
    const { tenantB, attacker } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(attacker.id);

    const formData = new FormData();
    formData.append(
      'address',
      JSON.stringify({ streetLine1: '1 Attacker St', city: 'Metropolis', state: 'NY', zipCode: '10001' }),
    );

    const { PATCH } = await import('@/app/api/company/profile/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/company/profile?companyId=${tenantB.id}`, {
        method: 'PATCH',
        headers: {},
        body: formData,
      }),
    );
    log('A-spoof profile status:', res.status);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');

    const stored = await db.company.findUnique({ where: { id: tenantB.id } });
    expect(stored?.streetLine1).toBe('');
  });

  it('B: PATCH /api/company/profile?companyId=B — owner (company_admin) updates own profile (200)', async () => {
    const { tenantB, ownerB } = await seedTenants();
    mockGetSessionUserId.mockResolvedValue(ownerB.id);

    const formData = new FormData();
    formData.append(
      'address',
      JSON.stringify({ streetLine1: '1 Owner Ave', city: 'Austin', state: 'TX', zipCode: '78701' }),
    );

    const { PATCH } = await import('@/app/api/company/profile/route');
    const res = await PATCH(
      new NextRequest(`http://localhost/api/company/profile?companyId=${tenantB.id}`, {
        method: 'PATCH',
        headers: {},
        body: formData,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const stored = await db.company.findUnique({ where: { id: tenantB.id } });
    expect(stored?.streetLine1).toBe('1 Owner Ave');
    expect(stored?.city).toBe('Austin');
    expect(stored?.state).toBe('TX');
    expect(stored?.zipCode).toBe('78701');
  });
});