// S10 1B.2A — extracted reclassification authority.
// Demonstrates that PATCH /api/transactions/[id] and any future consumer
// share ONE server authority: the route delegates to `reclassifyTransaction`
// (no second implementation of the domain sequence remains in the route),
// and the authority itself enforces tenant semantics without HTTP.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { PATCH } from '../../src/app/api/transactions/[id]/route';
import { reclassifyTransaction } from '../../src/lib/services/transaction-reclassification.service';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';

vi.mock('../../src/lib/services/transaction-reclassification.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/lib/services/transaction-reclassification.service')>();
  return {
    ...actual,
    reclassifyTransaction: vi.fn(actual.reclassifyTransaction),
  };
});

import * as authorityModule from '../../src/lib/services/transaction-reclassification.service';

const reclassifySpy = vi.mocked(authorityModule.reclassifyTransaction);

async function setupCompanyWithTransaction(overrides?: {
  companyEmail?: string;
  companyName?: string;
  glCode?: string;
}) {
  const user = await createTestUser(overrides?.companyEmail ?? 'reclass-authority@example.com');
  const company = await createTestCompany(overrides?.companyName ?? 'Reclass Authority Co');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);

  const glAccount = await createTestGlAccount({
    companyId: company.id,
    code: overrides?.glCode ?? '1000',
    name: 'Bank Account',
  });
  const counterpartyGl = await createTestGlAccount({
    companyId: company.id,
    code: '2000',
    name: 'Counterparty',
    normalBalance: 'credit',
  });
  const bankAccount = await createTestBankAccount(company.id, glAccount.id);
  const statement = await createTestBankStatement(company.id, bankAccount.id);
  const tx = await createTestBankTransaction(company.id, statement.id, {
    date: '2025-05-15',
    amount: 100.0,
    description: 'Authority extraction test',
  });

  return { user, company, token, glAccount, counterpartyGl, bankAccount, statement, tx };
}

describe('S10 1B.2A — route delegates to the single reclassification authority', () => {
  beforeEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
  });

  afterEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
  });

  it('PATCH /api/transactions/[id] invokes reclassifyTransaction exactly once with the domain inputs', async () => {
    const { company, token, counterpartyGl, tx } = await setupCompanyWithTransaction();

    const req = new NextRequest(
      `http://localhost/api/transactions/${tx.id}?companyId=${company.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ glAccountId: counterpartyGl.id }),
      },
    );

    const res = await PATCH(req, { params: Promise.resolve({ id: tx.id }) });
    expect(res.status).toBe(200);

    // The route must not re-implement the sequence: every request crosses
    // the authority exactly once with companyId/transactionId/glAccountId.
    expect(reclassifySpy).toHaveBeenCalledTimes(1);
    expect(reclassifySpy).toHaveBeenCalledWith({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
      confirmedEntity: undefined,
    });

    const body = await res.json();
    expect(body.transaction.glAccountId).toBe(counterpartyGl.id);
    expect(body.transaction.journalEntryId).not.toBeNull();
  });

  it('PATCH forwards confirmedEntity to the authority unchanged', async () => {
    const { company, token, counterpartyGl, tx } = await setupCompanyWithTransaction({
      companyEmail: 'reclass-authority-ce@example.com',
      companyName: 'Reclass Authority CE Co',
      glCode: '1100',
    });

    const req = new NextRequest(
      `http://localhost/api/transactions/${tx.id}?companyId=${company.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          glAccountId: counterpartyGl.id,
          confirmedEntity: { canonicalName: 'ACME SRL', entityType: 'company' },
        }),
      },
    );

    const res = await PATCH(req, { params: Promise.resolve({ id: tx.id }) });
    expect(res.status).toBe(200);

    expect(reclassifySpy).toHaveBeenCalledTimes(1);
    expect(reclassifySpy).toHaveBeenCalledWith({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
      confirmedEntity: { canonicalName: 'ACME SRL', entityType: 'company' },
    });
  });
});

describe('S10 1B.2A — authority enforces tenant semantics without HTTP', () => {
  beforeEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
  });

  afterEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
  });

  it('transaction of another company → TRANSACTION_NOT_FOUND (no mutation)', async () => {
    const a = await setupCompanyWithTransaction({
      companyEmail: 'tenant-a@example.com',
      companyName: 'Tenant A Co',
      glCode: '1200',
    });
    const bUser = await createTestUser('tenant-b@example.com');
    const bCompany = await createTestCompany('Tenant B Co');
    await createTestCompanyMember(bUser.id, bCompany.id);

    const outcome = await reclassifyTransaction({
      companyId: bCompany.id,
      transactionId: a.tx.id,
      glAccountId: a.counterpartyGl.id,
    });
    expect(outcome.status).toBe('TRANSACTION_NOT_FOUND');

    const unchanged = await db.bankTransaction.findUnique({
      where: { id: a.tx.id },
      select: { glAccountId: true, journalEntryId: true },
    });
    expect(unchanged?.glAccountId).toBeNull();
    expect(unchanged?.journalEntryId).toBeNull();
  });

  it('GL account of another company → GL_ACCOUNT_NOT_FOUND (no mutation)', async () => {
    const a = await setupCompanyWithTransaction({
      companyEmail: 'tenant-a-gl@example.com',
      companyName: 'Tenant A GL Co',
      glCode: '1300',
    });
    const bUser = await createTestUser('tenant-b-gl@example.com');
    const bCompany = await createTestCompany('Tenant B GL Co');
    await createTestCompanyMember(bUser.id, bCompany.id);
    const foreignGl = await createTestGlAccount({
      companyId: bCompany.id,
      code: '7000',
      name: 'Foreign GL',
    });

    const outcome = await reclassifyTransaction({
      companyId: a.company.id,
      transactionId: a.tx.id,
      glAccountId: foreignGl.id,
    });
    expect(outcome.status).toBe('GL_ACCOUNT_NOT_FOUND');

    const unchanged = await db.bankTransaction.findUnique({
      where: { id: a.tx.id },
      select: { glAccountId: true, journalEntryId: true },
    });
    expect(unchanged?.glAccountId).toBeNull();
    expect(unchanged?.journalEntryId).toBeNull();
  });

  it('same-scope call performs accounting + journal directly (reusable authority, no HTTP)', async () => {
    const { company, counterpartyGl, tx, glAccount } = await setupCompanyWithTransaction({
      companyEmail: 'authority-direct@example.com',
      companyName: 'Authority Direct Co',
      glCode: '1400',
    });

    const outcome = await reclassifyTransaction({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
    });

    expect(outcome.status).toBe('OK');
    if (outcome.status !== 'OK') return;
    expect(outcome.transaction.glAccountId).toBe(counterpartyGl.id);
    expect(outcome.transaction.journalEntryId).not.toBeNull();

    const bankGl = await db.glAccount.findUnique({ where: { id: glAccount.id } });
    const counterparty = await db.glAccount.findUnique({ where: { id: counterpartyGl.id } });
    expect(Number(bankGl?.balance)).toBe(100);
    expect(Number(counterparty?.balance)).toBe(100);
  });
});
