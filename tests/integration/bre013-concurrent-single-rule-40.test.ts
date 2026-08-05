import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { executeSingleRuleClassificationApply } from '@/lib/services/single-rule-apply.service';
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
import { orchestrateConcurrentRace } from '../helpers/concurrency';

async function seedDisputedSingleRule() {
  const user = await createTestUser('concurrent-b@example.com');
  const company = await createTestCompany('Concurrent B');
  await createTestCompanyMember(user.id, company.id);

  const gl = await createTestGlAccount({
    companyId: company.id,
    code: '6200',
    name: 'Office Expense',
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

  const transaction = await createTestBankTransaction(company.id, statement.id, {
    date: '2025-06-15',
    amount: -150, // debit/withdrawal (expense)
    description: 'OFFICE SUPPLIES',
  });

  const rule = await db.bankRule.create({
    data: {
      companyId: company.id,
      name: 'Office Supplies Rule',
      conditionType: 'contains',
      conditionValue: 'OFFICE',
      transactionDirection: 'any',
      glAccountId: gl.id,
      priority: 15,
      isActive: true,
    },
  });

  return { user, company, gl, bankGl, transaction, rule };
}

describe('BRE-013 5.0 - Deterministic concurrent single-rule apply — single disputed BankTransaction', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('two concurrent executeSingleRuleClassificationApply calls produce exactly ONE legit apply record, and no spurious record', async () => {
    const { user, company, gl, transaction, rule } = await seedDisputedSingleRule();

    // Since it is a single-rule apply, we assume candidates are already determined by route.
    // In our case, the transaction amount is negative (< 0) so it's a debit candidate.
    const debitIds = [transaction.id];
    const creditIds: string[] = [];

    const input = {
      companyId: company.id,
      userId: user.id,
      rule: {
        id: rule.id,
        name: rule.name,
        glAccountId: rule.glAccountId,
        debitGlAccountId: rule.debitGlAccountId,
        creditGlAccountId: rule.creditGlAccountId,
      },
      debitIds,
      creditIds,
    };

    const { resultA, resultB } = await orchestrateConcurrentRace(
      (tx) => executeSingleRuleClassificationApply(tx, input),
      (tx) => executeSingleRuleClassificationApply(tx, input),
      { transactionId: transaction.id, timeoutMs: 4000 },
    );

    // Cast results to SingleRuleApplyResult
    const resA = resultA as { actualMatched: number; acquiredIds: string[]; applyRecordId: string };
    const resB = resultB as { actualMatched: number; acquiredIds: string[]; applyRecordId: string };

    // ── Invariants ──────────────────────────────────────────────
    // 1. Exactly ONE durable apply record (no spurious/empty loser record).
    const records = await db.ruleApplyRecord.findMany({ where: { companyId: company.id } });
    expect(records).toHaveLength(1);

    const record = records[0];

    // 2. Single effective classification on the disputed row.
    const row = await db.bankTransaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(row.glAccountId).toBe(gl.id);
    expect(row.matchedRuleId).toBe(rule.id);

    // 3. ruleApplyRecordId points to the single legit record (loser did not overwrite).
    // The winning record must be the one whose actualMatched was 1.
    const winningRecordId = resA.actualMatched === 1 ? resA.applyRecordId : resB.applyRecordId;
    expect(row.ruleApplyRecordId).toBe(winningRecordId);
    expect(row.ruleApplyRecordId).toBe(record.id);
  }, 60000);
});