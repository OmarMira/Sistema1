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

// §GAP8-2A: observe the learning writes (source propagation) without
// changing behavior — passthrough keeps the certified KE semantics intact.
vi.mock('@/memory/classification-knowledge', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/memory/classification-knowledge')>();
  return {
    ...actual,
    learnEntityTreatment: vi.fn(actual.learnEntityTreatment),
    recordClassificationObservation: vi.fn(actual.recordClassificationObservation),
    evolveClassificationConfidence: vi.fn(actual.evolveClassificationConfidence),
  };
});

import {
  learnEntityTreatment,
  recordClassificationObservation,
  evolveClassificationConfidence,
  getRuleExecutionEvidence,
  createAdapter,
  RULE_EVIDENCE_TYPE,
} from '@/memory/classification-knowledge';

const learnSpy = vi.mocked(learnEntityTreatment);
const observationSpy = vi.mocked(recordClassificationObservation);
const evolveSpy = vi.mocked(evolveClassificationConfidence);

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
    // §GAP8-2E — the accounting phase writes the FINAL_DECISION_SOURCE
    // trace through the caller's tx; the fake must expose auditLog.
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-fake' }),
    },
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

// ─── §GAP8-2A — correction provenance in the KE circuit ───────────────────
// A correction's `source` is pure provenance: it must reach
// learnEntityTreatment + recordClassificationObservation unchanged, keep
// post-commit ordering, stay company-scoped, and never introduce a
// repetition-driven confidence change (C11 policy untouched).

describe('§GAP8-2A — correction provenance reaches the KE circuit', () => {
  beforeEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
    learnSpy.mockClear();
    observationSpy.mockClear();
    evolveSpy.mockClear();
  });

  afterEach(async () => {
    await clearDatabase();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
    learnSpy.mockClear();
    observationSpy.mockClear();
    evolveSpy.mockClear();
  });

  // Seed an active identity whose canonicalName normalizes to the factory
  // transaction description ('Authority extraction test') so resolveEntity
  // returns KNOWN and the KE phase learns without any session-dependent
  // identity confirmation.
  async function seedKnownEntity(companyId: string) {
    return db.companyKnowledge.create({
      data: {
        companyId,
        type: 'COMPANY',
        canonicalName: 'Authority Extraction Test',
        aliases: [],
        metadata: {},
        source: 'company_knowledge',
        status: 'active',
      },
    });
  }

  it('T1: a normal correction records user_correction by default', async () => {
    const { company, counterpartyGl, tx } = await setupCompanyWithTransaction({
      companyEmail: 'gap82a-default-source@example.com',
      companyName: 'Gap82A Default Source Co',
      glCode: '2100',
    });
    await seedKnownEntity(company.id);

    const outcome = await reclassifyTransaction({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
    });
    expect(outcome.status).toBe('OK');

    // learnEntityTreatment(adapter, companyId, entityId, glAccountId, direction, source, …)
    expect(learnSpy).toHaveBeenCalledTimes(1);
    expect(learnSpy.mock.calls[0][5]).toBe('user_correction');
    // recordClassificationObservation(adapter, companyId, { …source… })
    expect(observationSpy).toHaveBeenCalledTimes(1);
    expect(observationSpy.mock.calls[0][2].source).toBe('user_correction');
  });

  it('T3+T4: source import_correction reaches learnEntityTreatment and the observation', async () => {
    const { company, counterpartyGl, tx } = await setupCompanyWithTransaction({
      companyEmail: 'gap82a-import-source@example.com',
      companyName: 'Gap82A Import Source Co',
      glCode: '2200',
    });
    await seedKnownEntity(company.id);

    const outcome = await reclassifyTransaction({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
      source: 'import_correction',
    });
    expect(outcome.status).toBe('OK');

    expect(learnSpy).toHaveBeenCalledTimes(1);
    expect(learnSpy.mock.calls[0][5]).toBe('import_correction');
    expect(observationSpy).toHaveBeenCalledTimes(1);
    expect(observationSpy.mock.calls[0][2].source).toBe('import_correction');
    // T6: both writes stay scoped to the caller's company
    expect(learnSpy.mock.calls[0][1]).toBe(company.id);
    expect(observationSpy.mock.calls[0][1]).toBe(company.id);
  });

  it('T5: import_correction learning still runs post-commit (external mode defers KE)', async () => {
    const { company, counterpartyGl, tx, bankAccount } = await setupCompanyWithTransaction({
      companyEmail: 'gap82a-post-commit@example.com',
      companyName: 'Gap82A Post Commit Co',
      glCode: '2300',
    });
    await seedKnownEntity(company.id);
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
      {
        companyId: company.id,
        transactionId: tx.id,
        glAccountId: counterpartyGl.id,
        source: 'import_correction',
      },
      { tx: fake },
    );
    if (outcome.status !== 'OK') throw new Error(`expected OK, got ${outcome.status}`);

    // KE (and its import_correction writes) must not run inside the open tx
    expect(learnSpy).not.toHaveBeenCalled();
    expect(observationSpy).not.toHaveBeenCalled();

    await outcome.runPostCommitLearning();
    expect(learnSpy).toHaveBeenCalledTimes(1);
    expect(learnSpy.mock.calls[0][5]).toBe('import_correction');
    expect(observationSpy.mock.calls[0][2].source).toBe('import_correction');
  });

  it('T7: repetition never changes confidence — only human_confirmation evolves it', async () => {
    const { company, counterpartyGl, tx } = await setupCompanyWithTransaction({
      companyEmail: 'gap82a-no-repetition@example.com',
      companyName: 'Gap82A No Repetition Co',
      glCode: '2400',
    });
    await seedKnownEntity(company.id);
    const input = {
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
      source: 'import_correction' as const,
    };

    const first = await reclassifyTransaction(input);
    expect(first.status).toBe('OK');
    const second = await reclassifyTransaction(input);
    expect(second.status).toBe('OK');

    // Observations accumulated on both runs, yet confidence evolved ONLY
    // through the explicit human-confirmation path — no repetition reason.
    expect(observationSpy).toHaveBeenCalledTimes(2);
    expect(evolveSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of evolveSpy.mock.calls) {
      expect(call[3]).toBe('certain');
      expect(call[4]).toBe('human_confirmation');
    }
  });

  it('T2(server): PATCH forwards a typed source and rejects unknown values', async () => {
    const { company, token, counterpartyGl, tx } = await setupCompanyWithTransaction({
      companyEmail: 'gap82a-route-source@example.com',
      companyName: 'Gap82A Route Source Co',
      glCode: '2500',
    });

    // Valid propagation → authority receives the typed source unchanged
    const okReq = new NextRequest(
      `http://localhost/api/transactions/${tx.id}?companyId=${company.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          glAccountId: counterpartyGl.id,
          source: 'import_correction',
        }),
      },
    );
    const okRes = await PATCH(okReq, { params: Promise.resolve({ id: tx.id }) });
    expect(okRes.status).toBe(200);
    expect(reclassifySpy).toHaveBeenCalledTimes(1);
    expect(reclassifySpy).toHaveBeenCalledWith({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
      confirmedEntity: undefined,
      source: 'import_correction',
    });

    // Unknown provenance → 400, authority never invoked
    reclassifySpy.mockClear();
    const badReq = new NextRequest(
      `http://localhost/api/transactions/${tx.id}?companyId=${company.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          glAccountId: counterpartyGl.id,
          source: 'banana',
        }),
      },
    );
    const badRes = await PATCH(badReq, { params: Promise.resolve({ id: tx.id }) });
    expect(badRes.status).toBe(400);
    expect(reclassifySpy).not.toHaveBeenCalled();
  });
});

// ─── §GAP8-2B — human override of a rule-attributed classification ───────
// Rule history stays as evidence; the human correction goes through the
// normal reclassify authority and wins. The override itself is recorded
// as advisory statistical evidence (never as authority, never promoted).
describe('§GAP8-2B — rule override feeds statistical memory', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    learnSpy.mockClear();
    observationSpy.mockClear();
    evolveSpy.mockClear();
    reclassifySpy.mockClear();
    resolveEntitySpy.mockClear();
  });

  async function setupRuleAttributedTransaction(tag: string) {
    const { company, counterpartyGl, tx } = await setupCompanyWithTransaction({
      companyEmail: `gap82b-${tag}@example.com`,
      companyName: `Gap82B ${tag} Co`,
      glCode: '2500',
    });
    const priorGl = await db.glAccount.create({
      data: {
        companyId: company.id,
        code: '7300',
        name: `Rule Prior ${tag}`,
        accountType: 'expense',
        normalBalance: 'debit',
        isActive: true,
      },
    });
    const rule = await db.bankRule.create({
      data: {
        companyId: company.id,
        name: `${tag} rule`,
        conditionType: 'contains',
        conditionValue: 'AUTHORITY EXTRACTION',
        transactionDirection: 'any',
        glAccountId: priorGl.id,
        priority: 10,
        isActive: true,
      },
    });
    // The transaction carries the prior rule attribution (rule-classified).
    await db.bankTransaction.update({
      where: { id: tx.id },
      data: { glAccountId: priorGl.id, matchedRuleId: rule.id },
    });
    return { company, counterpartyGl, tx, priorGl, rule };
  }

  it('T5: a human override reaches the normal correction authority and records override evidence', async () => {
    const { company, counterpartyGl, tx, priorGl, rule } =
      await setupRuleAttributedTransaction('override');

    const outcome = await reclassifyTransaction({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
    });
    expect(outcome.status).toBe('OK');

    // Normal correction authority applied: accounting posted the human target.
    const updated = await db.bankTransaction.findUnique({ where: { id: tx.id } });
    expect(updated?.glAccountId).toBe(counterpartyGl.id);
    expect(updated?.journalEntryId).toBeTruthy();

    // The override is represented as advisory evidence with full provenance.
    const a = createAdapter(db, (fn) => db.$transaction(fn));
    const evidence = await getRuleExecutionEvidence(a, company.id, { kind: 'RULE_OVERRIDDEN' });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence).toMatchObject({
      kind: 'RULE_OVERRIDDEN',
      ruleId: rule.id,
      previousGlAccountId: priorGl.id,
      glAccountId: counterpartyGl.id,
      transactionId: tx.id,
      direction: 'any',
    });

    // Advisory: evidence itself stays tentative — no confidence evolution.
    const item = await db.memoryItem.findUnique({ where: { id: evidence[0]!.itemId } });
    expect(item?.confidence).toBe('tentative');
    const logs = await db.confidenceLog.count({ where: { itemId: evidence[0]!.itemId } });
    expect(logs).toBe(0);
  });

  it('T6: the prior rule execution audit survives — evidence coexists, nothing is erased', async () => {
    const { company, counterpartyGl, tx, rule } = await setupRuleAttributedTransaction('audit');

    // Prior rule execution history for this exact decision.
    await db.ruleExecutionAudit.create({
      data: {
        engineVersion: 'test-engine-v1',
        transactionId: tx.id,
        companyId: company.id,
        result: 'MATCHED',
        winnerRuleId: rule.id,
        candidateCount: 1,
        candidateList: '[]',
        trace: '{}',
      },
    });

    const outcome = await reclassifyTransaction({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
    });
    expect(outcome.status).toBe('OK');

    // RULE_OVERRIDE_DOES_NOT_ERASE_PRIOR_AUDIT — the audit row still stands.
    expect(
      await db.ruleExecutionAudit.count({ where: { companyId: company.id, winnerRuleId: rule.id } }),
    ).toBe(1);

    // Both records coexist: prior audit + new override evidence.
    const a = createAdapter(db, (fn) => db.$transaction(fn));
    const evidence = await getRuleExecutionEvidence(a, company.id, { ruleId: rule.id });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.evidence.kind).toBe('RULE_OVERRIDDEN');
  });

  it('T7b: evidence never leaks across tenants on override', async () => {
    const { company, counterpartyGl, tx } = await setupRuleAttributedTransaction('tenant');
    const otherCompany = await createTestCompany('Gap82B Other Co');

    const outcome = await reclassifyTransaction({
      companyId: company.id,
      transactionId: tx.id,
      glAccountId: counterpartyGl.id,
    });
    expect(outcome.status).toBe('OK');

    const a = createAdapter(db, (fn) => db.$transaction(fn));
    const seenByOther = await getRuleExecutionEvidence(a, otherCompany.id, {
      kind: 'RULE_OVERRIDDEN',
    });
    expect(seenByOther).toHaveLength(0);

    const scoped = await db.memoryItem.findMany({
      where: { type: RULE_EVIDENCE_TYPE, companyId: otherCompany.id },
    });
    expect(scoped).toHaveLength(0);
  });
});
