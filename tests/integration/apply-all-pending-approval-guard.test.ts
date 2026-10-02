import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { executeApplyAll, matchTransactions } from '@/lib/services/apply-all-engine';
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

/**
 * E2E Decision-Learning Loop §2 — Apply-All pending-human-decision guard.
 *
 * ROOT_CONFLICT=APPLY_ALL_BYPASSES_PENDING_HUMAN_DECISION
 *
 * A BankTransaction governed by an ACTIVE human decision
 * (PendingApproval action='ai_classification_proposal', status='pending',
 * payload.transactionId = BankTransaction.importHash) must never be
 * classified by Apply-All — neither at match time nor at write time.
 */

const RULE_MARKER = 'PENDING GUARD';

// Unique per execution so residues from earlier runs can never collide with
// this test's own rows (the guard exclusion keys on importHash).
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Local ledger: only PendingApproval rows created by THIS test are tracked
// and removed in cleanup — never a global purge of other tests' rows.
const createdPendingIds: string[] = [];

async function seedApplyScene(userEmail: string, companyName: string, importHash: string | null) {
  const user = await createTestUser(userEmail);
  const company = await createTestCompany(companyName);
  await createTestCompanyMember(user.id, company.id);

  const expenseGl = await createTestGlAccount({
    companyId: company.id,
    code: '6001',
    name: 'Guard Expense',
    accountType: 'expense',
    normalBalance: 'debit',
  });
  const bankGl = await createTestGlAccount({
    companyId: company.id,
    code: '1001',
    name: 'Guard Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bankAccount = await createTestBankAccount(company.id, bankGl.id);
  const statement = await createTestBankStatement(company.id, bankAccount.id);

  const transaction = await createTestBankTransaction(company.id, statement.id, {
    date: '2025-06-15',
    amount: 100,
    description: `${RULE_MARKER} EXPENSE`,
  });

  if (importHash) {
    await db.bankTransaction.update({
      where: { id: transaction.id },
      data: { importHash },
    });
  }

  const rule = await db.bankRule.create({
    data: {
      companyId: company.id,
      name: `${RULE_MARKER} Rule`,
      conditionType: 'contains',
      conditionValue: RULE_MARKER,
      transactionDirection: 'any',
      glAccountId: expenseGl.id,
      priority: 10,
      isActive: true,
    },
  });

  return { user, company, expenseGl, transaction, rule, bankAccount, statement };
}

async function createPendingAiProposal(companyId: string, transactionImportHash: string, requestedBy: string) {
  const row = await db.pendingApproval.create({
    data: {
      companyId,
      action: 'ai_classification_proposal',
      payload: {
        transactionId: transactionImportHash,
        deterministicResult: { matchedRuleId: null, glAccountId: null },
        aiProposal: { glAccountId: 'mock-gl', confidence: 0.7 },
      },
      requestedBy,
      status: 'pending',
    },
  });
  createdPendingIds.push(row.id);
  return row;
}

async function readRow(transactionId: string) {
  return db.bankTransaction.findUniqueOrThrow({ where: { id: transactionId } });
}

function expectUntouched(row: {
  glAccountId: string | null;
  matchedRuleId: string | null;
  journalEntryId: string | null;
}) {
  expect(row.glAccountId).toBeNull();
  expect(row.matchedRuleId).toBeNull();
  expect(row.journalEntryId).toBeNull();
}

describe('E2E Decision-Learning Loop §2 — Apply-All pending human-decision guard', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    // Targeted cleanup: only rows THIS test created (PendingApproval has no
    // company FK, so clearDatabase() cannot reach them).
    if (createdPendingIds.length > 0) {
      await db.pendingApproval.deleteMany({
        where: { id: { in: createdPendingIds } },
      });
      createdPendingIds.length = 0;
    }
    await clearDatabase();
  });

  it('A causal: a transaction with a pending human decision is excluded from matching and never classified', async () => {
    const { user, company, transaction } = await seedApplyScene(
      'pending-guard-causal@example.com',
      'Pending Guard Causal',
      `pending-guard-causal-${RUN}`,
    );
    await createPendingAiProposal(company.id, `pending-guard-causal-${RUN}`, user.id);

    // D: Apply-All runs.
    const matchResult = await matchTransactions(company.id);

    // E: T is not even proposed as a candidate.
    expect(matchResult.totalCount).toBe(0);
    expect(matchResult.matchedRules).toHaveLength(0);
    expect(matchResult.transactions.map((t) => t.id)).not.toContain(transaction.id);

    const applied = await db.$transaction((tx) =>
      executeApplyAll(company.id, tx, matchResult, { userId: user.id, origin: 'batch' }),
    );

    // E: nothing applied, row untouched, decision intact.
    expect(applied.appliedCount).toBe(0);
    expect(applied.journalEntryCount).toBe(0);

    const row = await readRow(transaction.id);
    expectUntouched(row);

    const approval = await db.pendingApproval.findUniqueOrThrow({
      where: { id: createdPendingIds[0]! },
    });
    expect(approval.status).toBe('pending');

    expect(await db.ruleApplyRecord.count({ where: { companyId: company.id } })).toBe(0);
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(0);
  }, 60000);

  it('TOCTOU: write-time guard blocks a stale MatchResult when a PendingApproval appears after matching', async () => {
    const { user, company, transaction, rule, expenseGl } = await seedApplyScene(
      'pending-guard-toctou@example.com',
      'Pending Guard TOCTOU',
      `pending-guard-toctou-${RUN}`,
    );

    // 1: T matches while it has NO PendingApproval.
    const staleMatchResult = await matchTransactions(company.id);
    expect(staleMatchResult.totalCount).toBe(1);
    expect(staleMatchResult.matchedRules[0].txIds).toContain(transaction.id);

    // 2: human decision appears BEFORE executeApplyAll.
    await createPendingAiProposal(company.id, `pending-guard-toctou-${RUN}`, user.id);

    // 3: executeApplyAll receives the OLD MatchResult.
    const applied = await db.$transaction((tx) =>
      executeApplyAll(company.id, tx, staleMatchResult, {
        userId: user.id,
        origin: 'batch',
      }),
    );

    // 4: write-time validation prevents classification.
    expect(applied.appliedCount).toBe(0);
    expect(applied.journalEntryCount).toBe(0);

    const row = await readRow(transaction.id);
    expectUntouched(row);

    const approval = await db.pendingApproval.findUniqueOrThrow({
      where: { id: createdPendingIds[0]! },
    });
    expect(approval.status).toBe('pending');

    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(0);

    // The rule and GL exist — proof the block is the guard, not missing config.
    expect(rule.id).toBeTruthy();
    expect(expenseGl.id).toBeTruthy();
  }, 60000);

  it('positive regression: an equivalent transaction WITHOUT a pending approval is still classified normally', async () => {
    const { user, company, transaction, rule, expenseGl } = await seedApplyScene(
      'pending-guard-positive@example.com',
      'Pending Guard Positive',
      `pending-guard-positive-${RUN}`,
    );

    const matchResult = await matchTransactions(company.id);
    expect(matchResult.totalCount).toBe(1);
    expect(matchResult.matchedRules[0].txIds).toContain(transaction.id);

    const applied = await db.$transaction((tx) =>
      executeApplyAll(company.id, tx, matchResult, { userId: user.id, origin: 'batch' }),
    );

    expect(applied.appliedCount).toBe(1);

    const row = await readRow(transaction.id);
    expect(row.glAccountId).toBe(expenseGl.id);
    expect(row.matchedRuleId).toBe(rule.id);
    expect(row.journalEntryId).not.toBeNull();

    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(1);
    expect(await db.ruleApplyRecord.count({ where: { companyId: company.id } })).toBe(1);
  }, 60000);
});
