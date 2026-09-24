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
import type { Prisma } from '@prisma/client';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { resolveEntity } from '@/memory/entity-resolution';

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

// S10 1B.2B.1: observe KE entry (resolveEntity) without changing behavior —
// passthrough keeps the certified learning semantics intact.
vi.mock('@/memory/entity-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/memory/entity-resolution')>();
  return { ...actual, resolveEntity: vi.fn(actual.resolveEntity) };
});

const resolveEntitySpy = vi.mocked(resolveEntity);

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

// ─── S10 1B.2B.1 — transactional authority extension ─────────────────────
// Two modes: autonomous (db.$transaction; KE runs before return — the
// certified 1B.2A behavior) and external-tx (accounting joins the caller's
// open transaction; KE is deferred to runPostCommitLearning, which latches
// so it executes exactly once and never rejects).

function buildFakeCallerTx(opts: {
  row: Record<string, unknown>;
  companyId: string;
  glAccountId: string;
}) {
  const bankTransactionFindFirst = vi.fn().mockResolvedValue(opts.row);
  const bankTransactionUpdate = vi.fn().mockResolvedValue({
    id: opts.row.id,
    date: opts.row.date,
    amount: 100,
    description: opts.row.description,
    glAccountId: opts.glAccountId,
    journalEntryId: null,
  });
  const glAccountFindFirst = vi.fn().mockResolvedValue({
    id: opts.glAccountId,
    companyId: opts.companyId,
    isActive: true,
  });
  const fiscalPeriodFindFirst = vi.fn().mockResolvedValue(null);

  const fake = {
    bankTransaction: { findFirst: bankTransactionFindFirst, update: bankTransactionUpdate },
    glAccount: { findFirst: glAccountFindFirst },
    fiscalPeriod: { findFirst: fiscalPeriodFindFirst },
  } as unknown as Prisma.TransactionClient;

  return {
    fake,
    bankTransactionFindFirst,
    bankTransactionUpdate,
    glAccountFindFirst,
    fiscalPeriodFindFirst,
  };
}

describe('S10 1B.2B.1 — autonomous mode (no options.tx) preserves certified behavior', () => {
  beforeEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
  });

  afterEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
  });

  it('TEST A: commits books on the real client, runs KE before returning, hook replays are no-ops', async () => {
    const { company, counterpartyGl, tx } = await setupCompanyWithTransaction({
      companyEmail: 'step1b2b1-autonomous@example.com',
      companyName: 'Step1B2B1 Autonomous Co',
      glCode: '1700',
    });

    const outcome = await reclassifyTransaction({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
    });

    expect(outcome.status).toBe('OK');
    // KE ran inside the call (certified autonomous order: commit → learn)
    expect(resolveEntitySpy).toHaveBeenCalledTimes(1);

    const realRow = await db.bankTransaction.findUnique({
      where: { id: tx.id },
      select: { glAccountId: true, journalEntryId: true },
    });
    expect(realRow?.glAccountId).toBe(counterpartyGl.id);
    expect(realRow?.journalEntryId).not.toBeNull();

    if (outcome.status !== 'OK') return;
    // once-guard: replaying the hook must not re-run KE
    await outcome.runPostCommitLearning();
    expect(resolveEntitySpy).toHaveBeenCalledTimes(1);
  });
});

describe('S10 1B.2B.1 — external-tx mode (options.tx joins caller transaction)', () => {
  beforeEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
  });

  afterEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
  });

  it('TEST B: accounting joins caller tx; real books untouched; KE not run yet', async () => {
    const { company, counterpartyGl, tx, bankAccount } = await setupCompanyWithTransaction({
      companyEmail: 'ext-tx-b@example.com',
      companyName: 'External Tx B Co',
      glCode: '1500',
    });
    const row = {
      ...tx,
      statement: { bankAccount: { id: bankAccount.id, glAccountId: null } },
    };
    const { fake, bankTransactionUpdate } = buildFakeCallerTx({
      row,
      companyId: company.id,
      glAccountId: counterpartyGl.id,
    });

    const outcome = await reclassifyTransaction(
      { companyId: company.id, transactionId: tx.id, glAccountId: counterpartyGl.id },
      { tx: fake },
    );

    expect(outcome.status).toBe('OK');
    // Accounting ran on the caller-provided tx — not on the real client
    expect(bankTransactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { glAccountId: counterpartyGl.id } }),
    );
    const realRow = await db.bankTransaction.findUnique({
      where: { id: tx.id },
      select: { glAccountId: true, journalEntryId: true },
    });
    expect(realRow?.glAccountId).toBeNull();
    expect(realRow?.journalEntryId).toBeNull();
    // KE must NOT run inside the still-open caller transaction
    expect(resolveEntitySpy).not.toHaveBeenCalled();
  });

  it('TEST C: KE deferred — runs only when caller awaits runPostCommitLearning after commit', async () => {
    const { company, counterpartyGl, tx, bankAccount } = await setupCompanyWithTransaction({
      companyEmail: 'ext-tx-c@example.com',
      companyName: 'External Tx C Co',
      glCode: '1510',
    });
    const row = {
      ...tx,
      statement: { bankAccount: { id: bankAccount.id, glAccountId: null } },
    };
    const { fake } = buildFakeCallerTx({
      row,
      companyId: company.id,
      glAccountId: counterpartyGl.id,
    });

    const outcome = await reclassifyTransaction(
      { companyId: company.id, transactionId: tx.id, glAccountId: counterpartyGl.id },
      { tx: fake },
    );
    if (outcome.status !== 'OK') throw new Error(`expected OK, got ${outcome.status}`);

    expect(resolveEntitySpy).not.toHaveBeenCalled();
    await outcome.runPostCommitLearning();
    expect(resolveEntitySpy).toHaveBeenCalledTimes(1);
  });

  it('TEST D: once-guard — awaiting runPostCommitLearning twice runs KE exactly once', async () => {
    const { company, counterpartyGl, tx, bankAccount } = await setupCompanyWithTransaction({
      companyEmail: 'ext-tx-d@example.com',
      companyName: 'External Tx D Co',
      glCode: '1520',
    });
    const row = {
      ...tx,
      statement: { bankAccount: { id: bankAccount.id, glAccountId: null } },
    };
    const { fake } = buildFakeCallerTx({
      row,
      companyId: company.id,
      glAccountId: counterpartyGl.id,
    });

    const outcome = await reclassifyTransaction(
      { companyId: company.id, transactionId: tx.id, glAccountId: counterpartyGl.id },
      { tx: fake },
    );
    if (outcome.status !== 'OK') throw new Error(`expected OK, got ${outcome.status}`);

    await outcome.runPostCommitLearning();
    await outcome.runPostCommitLearning();
    expect(resolveEntitySpy).toHaveBeenCalledTimes(1);
  });

  it('TEST E: reads, fiscal guard and journal creation all receive the caller tx', async () => {
    const { company, counterpartyGl, tx, glAccount, bankAccount } =
      await setupCompanyWithTransaction({
        companyEmail: 'ext-tx-e@example.com',
        companyName: 'External Tx E Co',
        glCode: '1530',
      });
    const row = {
      ...tx,
      statement: { bankAccount: { id: bankAccount.id, glAccountId: glAccount.id } },
    };
    const parts = buildFakeCallerTx({
      row,
      companyId: company.id,
      glAccountId: counterpartyGl.id,
    });
    const journalSpy = vi
      .spyOn(JournalEntryService, 'createFromBankTransaction')
      .mockResolvedValue('je-fake-entry');

    try {
      const outcome = await reclassifyTransaction(
        { companyId: company.id, transactionId: tx.id, glAccountId: counterpartyGl.id },
        { tx: parts.fake },
      );

      expect(outcome.status).toBe('OK');
      if (outcome.status !== 'OK') return;

      expect(outcome.transaction.journalEntryId).toBe('je-fake-entry');
      // Tenant read, fiscal guard, GL update — all on the caller's tx
      expect(parts.bankTransactionFindFirst).toHaveBeenCalledTimes(1);
      expect(parts.fiscalPeriodFindFirst).toHaveBeenCalledTimes(1);
      expect(parts.bankTransactionUpdate).toHaveBeenCalledTimes(1);
      expect(journalSpy).toHaveBeenCalledWith(
        parts.fake,
        expect.objectContaining({
          companyId: company.id,
          bankGlAccountId: glAccount.id,
          counterpartyGlAccountId: counterpartyGl.id,
        }),
      );

      const realRow = await db.bankTransaction.findUnique({
        where: { id: tx.id },
        select: { glAccountId: true, journalEntryId: true },
      });
      expect(realRow?.glAccountId).toBeNull();
      expect(realRow?.journalEntryId).toBeNull();
      // Still deferred: KE has no business inside the open transaction
      expect(resolveEntitySpy).not.toHaveBeenCalled();
    } finally {
      journalSpy.mockRestore();
    }
  });

  it('TEST F: KE phase failure never rejects the post-commit hook (books stand)', async () => {
    const { company, counterpartyGl, tx, bankAccount } = await setupCompanyWithTransaction({
      companyEmail: 'ext-tx-f@example.com',
      companyName: 'External Tx F Co',
      glCode: '1540',
    });
    const row = {
      ...tx,
      statement: { bankAccount: { id: bankAccount.id, glAccountId: null } },
    };
    const { fake } = buildFakeCallerTx({
      row,
      companyId: company.id,
      glAccountId: counterpartyGl.id,
    });

    resolveEntitySpy.mockRejectedValueOnce(new Error('KE phase exploded'));

    const outcome = await reclassifyTransaction(
      { companyId: company.id, transactionId: tx.id, glAccountId: counterpartyGl.id },
      { tx: fake },
    );
    if (outcome.status !== 'OK') throw new Error(`expected OK, got ${outcome.status}`);

    await expect(outcome.runPostCommitLearning()).resolves.toBeUndefined();
    // Latch already consumed — replay returns the same settled promise
    await expect(outcome.runPostCommitLearning()).resolves.toBeUndefined();
    expect(resolveEntitySpy).toHaveBeenCalledTimes(1);
  });
});
