import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { executeApplyAll, matchTransactions } from '@/lib/services/apply-all-engine';
import { revertApplyRecord, type RevertApplyResult } from '@/lib/services/rollback-apply.service';
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

// Convenient but tight concurrency window: two interactive transactions over a
// real PostgreSQL connection with no artificial sleeps or synchronization.
const CONCURRENCY_TIMEOUT_MS = 15000;

async function seedJournaledScenario() {
  const user = await createTestUser('concurrent48@example.com');
  const company = await createTestCompany('Concurrent 4.8');
  await createTestCompanyMember(user.id, company.id);

  const expenseGl = await createTestGlAccount({
    companyId: company.id,
    code: '6000',
    name: 'Expense',
    accountType: 'expense',
    normalBalance: 'debit',
  });
  const bankGl = await createTestGlAccount({
    companyId: company.id,
    code: '1000',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bankAccount = await createTestBankAccount(company.id, bankGl.id);
  const statement = await createTestBankStatement(company.id, bankAccount.id);
  const tx = await createTestBankTransaction(company.id, statement.id, {
    date: '2025-06-15',
    amount: 100,
    description: 'TEST EXPENSE',
  });
  const rule = await db.bankRule.create({
    data: {
      companyId: company.id,
      name: 'Concurrent Rule',
      conditionType: 'contains',
      conditionValue: 'TEST',
      transactionDirection: 'any',
      glAccountId: expenseGl.id,
      priority: 10,
      isActive: true,
    },
  });

  return { user, company, expenseGl, bankGl, transaction: tx, rule };
}

describe('4.8 - Concurrent reverts on a real RuleApplyRecord (integration, accountexpress_test)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('fire two concurrent reverts: exactly one persists reverted, loser is already-reverted OR loses the CAS', async () => {
    const { user, company, expenseGl, bankGl, transaction, rule } = await seedJournaledScenario();

    // ── Setup: a REAL applied, journaled state ──
    // Snapshot 1: true initial (before apply) — balances are 0.
    const initialExpense = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const initialBank = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(initialExpense.balance)).toBe(0);
    expect(Number(initialBank.balance)).toBe(0);

    const matchResult = await matchTransactions(company.id);
    expect(matchResult.totalCount).toBe(1);

    const applied = await db.$transaction(async (tx) =>
      executeApplyAll(company.id, tx, matchResult, { userId: user.id, origin: 'batch' }),
    );
    expect(applied.applyRecordId).toBeTruthy();
    expect(applied.journalEntryCount).toBe(1);
    const recordId = applied.applyRecordId!;

    const journalPre = await db.journalEntry.findFirstOrThrow({ where: { ruleApplyRecordId: recordId } });
    const journalId = journalPre.id;
    expect(journalPre.status).toBe('posted');
    expect(await db.journalLine.count({ where: { entryId: journalId } })).toBe(2);

    const txPre = await db.bankTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(txPre.glAccountId).toBe(expenseGl.id);
    expect(txPre.matchedRuleId).toBe(rule.id);
    expect(txPre.journalEntryId).toBe(journalId);
    expect(txPre.ruleApplyRecordId).toBe(recordId);

    // Snapshot 2: applied — balances must differ from initial.
    const appliedExpense = await db.glAccount.findUniqueOrThrow({ where: { id: expenseGl.id } });
    const appliedBank = await db.glAccount.findUniqueOrThrow({ where: { id: bankGl.id } });
    expect(Number(appliedExpense.balance)).not.toBe(Number(initialExpense.balance));
    expect(Number(appliedBank.balance)).not.toBe(Number(initialBank.balance));

    // ── Concurrent dispatch (no sleeps, no synchronization) ──
    const results = await Promise.allSettled([
      revertApplyRecord(company.id, recordId, user.id),
      revertApplyRecord(company.id, recordId, user.id),
    ]);

    // ── Strict classification of per-attempt outcomes ──
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Any deadlock, timeout, unknown Prisma error, or FK failure must fail the
    // test — never silently accepted.
    // Exactly one must resolve 'reverted'.
    const winners = fulfilled.filter(
      (r) => r.status === 'fulfilled' && (r.value as RevertApplyResult).status === 'reverted',
    );
    expect(winners.length).toBe(1);

    // The loser must be, exclusively:
    //   - fulfilled with status 'already-reverted', OR
    //   - rejected with message containing 'Concurrent revert won'.
    const nonWinners = results.filter((r) =>
      !(r.status === 'fulfilled' && (r.value as RevertApplyResult).status === 'reverted'),
    );
    expect(nonWinners.length).toBe(1);
    const loser = nonWinners[0];
    if (loser.status === 'fulfilled') {
      expect((loser.value as RevertApplyResult).status).toBe('already-reverted');
    } else {
      expect((loser.reason as Error).message).toContain('Concurrent revert won');
    }

    // ── Final invariants on the persisted state ──
    const recordPost = await db.ruleApplyRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(recordPost.state).toBe('reverted');

    const auditCount = await db.auditLog.count({
      where: {
        companyId: company.id,
        action: 'RULE_REVERTED',
        entity: 'RuleApplyRecord',
        entityId: recordId,
        userId: user.id,
      },
    });
    expect(auditCount).toBe(1);

    const journalPost = await db.journalEntry.findUniqueOrThrow({ where: { id: journalId } });
    expect(journalPost.status).toBe('void');

    const txPost = await db.bankTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(txPost.journalEntryId).toBeNull();
    // journalLineId is a contract consistency check only (not set by apply-all).
    expect(txPost.journalLineId).toBeNull();
    expect(txPost.glAccountId).toBeNull();
    expect(txPost.matchedRuleId).toBeNull();
    // Design decision: FK preserved to the reverted record until a new apply.
    expect(txPost.ruleApplyRecordId).toBe(recordId);

    // Single pair of lines preserved, journal not hard-deleted, no duplicates.
    expect(await db.journalEntry.count({ where: { companyId: company.id } })).toBe(1);
    const lines = await db.journalLine.findMany({
      where: { entryId: journalId },
      orderBy: { id: 'asc' },
    });
    expect(lines.length).toBe(2);

    // Balances: equal to the initial snapshot AND to the aggregate of POSTED
    // journal lines only; no duplicate accounting effect persisted.
    for (const glId of [expenseGl.id, bankGl.id]) {
      const posted = await db.journalLine.aggregate({
        where: { glAccountId: glId, entry: { status: 'posted' } },
        _sum: { debit: true, credit: true },
      });
      const gl = await db.glAccount.findUniqueOrThrow({ where: { id: glId } });
      const recomputed =
        gl.normalBalance === 'debit'
          ? Number(posted._sum.debit || 0) - Number(posted._sum.credit || 0)
          : Number(posted._sum.credit || 0) - Number(posted._sum.debit || 0);
      expect(Number(gl.balance)).toBe(recomputed);
      // Initial snapshot was 0; with the journal void the posted aggregate is 0.
      expect(Number(gl.balance)).toBe(0);
    }
  }, CONCURRENCY_TIMEOUT_MS);
});