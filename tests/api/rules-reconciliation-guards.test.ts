import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
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
import { db } from '@/lib/db';

// ─── S22 — Rules and reconciliation guards ─────────────────────────────────
//
// (a) A policy evaluation failure on a CONFIRM flow must fail CLOSED (BLOCKED).
// (b) When the apply policy requires confirmation, apply-all must not silently
//     post: the generated journal entries stay 'draft' (reviewable/postable via
//     POST /api/journal/[id] { action: 'post' }). Without a review requirement
//     entries keep posting exactly as today.
// (c) Reconciliation 'complete' requires difference == 0 AND zero unmatched
//     (unreconciled, non-ignored) transactions for the bank account.
// (d) Unreconcile is refused for transactions belonging to a COMPLETED period.
// (e) Batch RuleApplyRecord rows carry ruleId provenance.
// (f) Deleting a rule records RULE_DELETED provenance in the audit trail and
//     stops issuing an explicit "clear matchedRuleId" write.

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-placeholder'));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

// The only mocked collaborator: the operational-policy decision source. Every
// other collaborator (rule matching, apply engine, journal writer, hash chain)
// runs for real against the fixture database.
const mockEvaluateOperationalPolicy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/operational-policy/policy-service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/operational-policy/policy-service')>();
  return { ...mod, evaluateOperationalPolicy: mockEvaluateOperationalPolicy };
});

import { executeApplyAllUseCase } from '@/lib/services/apply-all-use-case';

// ─── Policy decision factory ───────────────────────────────────────────────

function makeDecision(action: 'ALLOW' | 'WARN' | 'CONFIRM' | 'BLOCK') {
  return {
    action,
    context: 'APPLY_ALL' as const,
    profileId: 'standard-enforcement-v1',
    profileVersion: '1.0.0',
    readiness: {
      status: action === 'ALLOW' ? ('READY' as const) : ('NOT_READY' as const),
      metrics: {},
      failedChecks: [],
      checks: [],
    },
    rules: [],
    reasons: {
      reasonCode: action === 'ALLOW' ? 'DEFAULT_ACTION' : 'READINESS_NOT_MET',
      summary: `decision ${action}`,
    },
  };
}

// ─── Seed helpers ─────────────────────────────────────────────────────────

type Seed = Awaited<ReturnType<typeof seedCompany>>;

async function seedCompany(tag: string) {
  const user = await createTestUser(`s22-${tag}@example.com`);
  const company = await createTestCompany(`S22 ${tag}`);
  await createTestCompanyMember(user.id, company.id);
  mockGetSessionUserId.mockResolvedValue(user.id);

  const cashGl = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: `Cash ${tag}`,
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const expenseGl = await createTestGlAccount({
    companyId: company.id,
    code: '6000',
    name: `Expense ${tag}`,
    accountType: 'expense',
    normalBalance: 'debit',
  });
  const bankAccount = await createTestBankAccount(company.id, cashGl.id);
  const statement = await createTestBankStatement(company.id, bankAccount.id);

  return { user, company, cashGl, expenseGl, bankAccount, statement };
}

async function createRule(
  seed: Seed,
  data: { name: string; conditionValue: string; priority?: number; glAccountId?: string },
) {
  return db.bankRule.create({
    data: {
      companyId: seed.company.id,
      name: data.name,
      conditionType: 'contains',
      conditionValue: data.conditionValue,
      transactionDirection: 'any',
      glAccountId: data.glAccountId ?? seed.expenseGl.id,
      priority: data.priority ?? 10,
      isActive: true,
    },
  });
}

async function createTransaction(seed: Seed, description: string, amount = 100) {
  return createTestBankTransaction(seed.company.id, seed.statement.id, {
    date: '2025-03-15',
    amount,
    description,
  });
}

// ──────────────────────────────────────────────────────────────────────────

describe('S22 — rules and reconciliation guards', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('ALLOW'));
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  // ── (a) policy failure on the CONFIRM flow ──────────────────────────────
  describe('(a) apply-all policy failure', () => {
    it('returns BLOCKED (not EXECUTED) when the confirmed flow cannot re-evaluate the policy', async () => {
      const seed = await seedCompany('a1');
      await createRule(seed, { name: 'Match TEST', conditionValue: 'TEST' });
      const tx = await createTransaction(seed, 'TEST EXPENSE');

      mockEvaluateOperationalPolicy.mockRejectedValue(new Error('policy service unreachable'));

      const result = await executeApplyAllUseCase(seed.company.id, {
        confirmed: true,
        userId: seed.user.id,
      });

      expect(result.enforcement?.status).toBe('BLOCKED');
      expect(result.enforcement?.block?.reasonCode).toBe('POLICY_UNAVAILABLE');
      expect(result.enforcement?.policyUnavailable).toEqual({
        errorCode: 'POLICY_INTERNAL_ERROR',
      });

      // Nothing applied, nothing posted, nothing recorded.
      expect(result.applyResult.appliedCount).toBe(0);
      expect(result.applyResult.journalEntryCount).toBe(0);

      const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      expect(txAfter.glAccountId).toBeNull();
      expect(txAfter.matchedRuleId).toBeNull();
      expect(txAfter.journalEntryId).toBeNull();

      expect(await db.journalEntry.count({ where: { companyId: seed.company.id } })).toBe(0);
      expect(await db.ruleApplyRecord.count({ where: { companyId: seed.company.id } })).toBe(0);
    });

    it('keeps the legacy fail-open path for the unconfirmed call (policy unavailable → EXECUTED)', async () => {
      const seed = await seedCompany('a2');
      await createRule(seed, { name: 'Match TEST', conditionValue: 'TEST' });
      const tx = await createTransaction(seed, 'TEST EXPENSE');

      mockEvaluateOperationalPolicy.mockRejectedValue(new Error('policy service unreachable'));

      const result = await executeApplyAllUseCase(seed.company.id, { userId: seed.user.id });

      expect(result.enforcement?.status).toBe('EXECUTED');
      expect(result.enforcement?.policyUnavailable).toEqual({
        errorCode: 'POLICY_INTERNAL_ERROR',
      });
      expect(result.applyResult.journalEntryCount).toBe(1);

      const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: txAfter.journalEntryId! } });
      expect(entry.status).toBe('posted');
    });
  });

  // ── (b) policy-driven review instead of silent posting ──────────────────
  describe('(b) policy-driven review of auto-generated entries', () => {
    it('creates non-posted (draft) entries when the policy requires confirmation', async () => {
      const seed = await seedCompany('b1');
      await createRule(seed, { name: 'Match TEST', conditionValue: 'TEST' });
      const tx = await createTransaction(seed, 'TEST EXPENSE');

      mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('CONFIRM'));

      const result = await executeApplyAllUseCase(seed.company.id, {
        confirmed: true,
        userId: seed.user.id,
      });

      // The classification IS applied — the user consented — but nothing is posted.
      expect(result.enforcement?.status).toBe('EXECUTED');
      expect(result.applyResult.appliedCount).toBe(1);

      const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      expect(txAfter.glAccountId).toBe(seed.expenseGl.id);
      expect(txAfter.journalEntryId).toBeTruthy();

      const entry = await db.journalEntry.findUniqueOrThrow({
        where: { id: txAfter.journalEntryId! },
        include: { lines: true },
      });
      expect(entry.status).toBe('draft');
      expect(entry.hash).toBeNull();
      expect(entry.lines).toHaveLength(2);

      // Draft entries never move balances.
      const cashGl = await db.glAccount.findUniqueOrThrow({ where: { id: seed.cashGl.id } });
      const expenseGl = await db.glAccount.findUniqueOrThrow({ where: { id: seed.expenseGl.id } });
      expect(Number(cashGl.balance)).toBe(0);
      expect(Number(expenseGl.balance)).toBe(0);
    });

    it('still posts entries when no policy requires review (default behaviour)', async () => {
      const seed = await seedCompany('b2');
      await createRule(seed, { name: 'Match TEST', conditionValue: 'TEST' });
      const tx = await createTransaction(seed, 'TEST EXPENSE');

      mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('ALLOW'));

      const result = await executeApplyAllUseCase(seed.company.id, { userId: seed.user.id });

      expect(result.enforcement?.status).toBe('EXECUTED');
      expect(result.applyResult.journalEntryCount).toBe(1);

      const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      const entry = await db.journalEntry.findUniqueOrThrow({
        where: { id: txAfter.journalEntryId! },
      });
      expect(entry.status).toBe('posted');
      expect(entry.hash).not.toBeNull();
    });
  });

  // ── (c) reconciliation complete guards ─────────────────────────────────
  describe('(c) POST /api/reconciliation/periods (action=complete)', () => {
    async function postComplete(companyId: string, bankAccountId: string, periodId: string) {
      const { POST } = await import('@/app/api/reconciliation/periods/route');
      return POST(
        new NextRequest(`http://localhost/api/reconciliation/periods?companyId=${companyId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyId,
            bankAccountId,
            action: 'complete',
            periodId,
          }),
        }),
        { params: Promise.resolve({}) },
      );
    }

    async function seedBalancedPeriod(tag: string) {
      const seed = await seedCompany(tag);
      const counterGl = await createTestGlAccount({
        companyId: seed.company.id,
        code: '4010',
        name: `Revenue ${tag}`,
        accountType: 'revenue',
        normalBalance: 'credit',
      });
      // Book balance must equal the statement closing balance (2000) so that
      // the ONLY blocker left is the unmatched-transaction count.
      await createTestJournalEntry(seed.company.id, {
        date: '2025-03-31',
        description: 'Book balance seed',
        lines: [
          { glAccountId: seed.cashGl.id, debit: 2000, credit: 0 },
          { glAccountId: counterGl.id, debit: 0, credit: 2000 },
        ],
      });
      const period = await db.reconciliationPeriod.create({
        data: {
          companyId: seed.company.id,
          bankAccountId: seed.bankAccount.id,
          userId: seed.user.id,
          statementBalance: 2000,
          bookBalance: 2000,
          difference: 0,
          status: 'open',
        },
      });
      return { ...seed, counterGl, period };
    }

    it('rejects completion with 400 and lists the blockers when unmatched transactions remain', async () => {
      const seed = await seedBalancedPeriod('c1');
      const tx = await createTransaction(seed, 'UNMATCHED PAYMENT');

      const res = await postComplete(seed.company.id, seed.bankAccount.id, seed.period.id);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.blockers.unmatchedCount).toBe(1);
      expect(body.blockers.unmatchedTransactionIds).toContain(tx.id);
      expect(body.blockers.difference).toBe(0);
      expect(String(body.error)).toMatch(/unmatched|no conciliad/i);

      const periodAfter = await db.reconciliationPeriod.findUniqueOrThrow({
        where: { id: seed.period.id },
      });
      expect(periodAfter.status).toBe('open');
    });

    it('rejects completion with 400 when the difference is not zero', async () => {
      const seed = await seedBalancedPeriod('c2');
      // Break the balance: book balance 2000 vs statement 2500.
      await db.bankStatement.update({
        where: { id: seed.statement.id },
        data: { closingBalance: 2500 },
      });

      const res = await postComplete(seed.company.id, seed.bankAccount.id, seed.period.id);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.blockers.difference).toBe(500);
      expect(body.blockers.unmatchedCount).toBe(0);
      expect(String(body.error)).toMatch(/difference|diferencia/i);

      const periodAfter = await db.reconciliationPeriod.findUniqueOrThrow({
        where: { id: seed.period.id },
      });
      expect(periodAfter.status).toBe('open');
    });

    it('completes the period when difference == 0 and nothing is unmatched', async () => {
      const seed = await seedBalancedPeriod('c3');
      // A reconciled transaction is NOT an unmatched blocker.
      const tx = await createTransaction(seed, 'CLEARED PAYMENT');
      await db.bankTransaction.update({
        where: { id: tx.id },
        data: { isReconciled: true, reconciledAt: new Date(), reconciliationPeriodId: seed.period.id },
      });

      const res = await postComplete(seed.company.id, seed.bankAccount.id, seed.period.id);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.period.status).toBe('completed');
      expect(Number(body.period.difference)).toBe(0);
    });
  });

  // ── (d) unreconcile refused on completed periods ───────────────────────
  describe('(d) POST /api/reconciliation/unreconcile', () => {
    async function postUnreconcile(companyId: string, bankAccountId: string, transactionIds: string[]) {
      const { POST } = await import('@/app/api/reconciliation/unreconcile/route');
      return POST(
        new NextRequest(`http://localhost/api/reconciliation/unreconcile?companyId=${companyId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyId, bankAccountId, transactionIds }),
        }),
        { params: Promise.resolve({}) },
      );
    }

    async function seedReconciledTx(tag: string, periodStatus: 'open' | 'completed') {
      const seed = await seedCompany(tag);
      const period = await db.reconciliationPeriod.create({
        data: {
          companyId: seed.company.id,
          bankAccountId: seed.bankAccount.id,
          userId: seed.user.id,
          statementBalance: 0,
          bookBalance: 0,
          difference: 0,
          status: periodStatus,
          completedAt: periodStatus === 'completed' ? new Date() : null,
        },
      });
      const tx = await createTransaction(seed, 'CLEARED PAYMENT');
      await db.bankTransaction.update({
        where: { id: tx.id },
        data: { isReconciled: true, reconciledAt: new Date(), reconciliationPeriodId: period.id },
      });
      return { ...seed, period, tx };
    }

    it('refuses with 400 when the transaction belongs to a COMPLETED period', async () => {
      const seed = await seedReconciledTx('d1', 'completed');

      const res = await postUnreconcile(seed.company.id, seed.bankAccount.id, [seed.tx.id]);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.periodIds).toContain(seed.period.id);
      expect(String(body.error)).toMatch(/complet/i);

      const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: seed.tx.id } });
      expect(txAfter.isReconciled).toBe(true);
      expect(txAfter.reconciliationPeriodId).toBe(seed.period.id);

      const audits = await db.auditLog.count({
        where: { companyId: seed.company.id, action: 'unreconcile_transactions' },
      });
      expect(audits).toBe(0);
    });

    it('keeps working for an OPEN period', async () => {
      const seed = await seedReconciledTx('d2', 'open');

      const res = await postUnreconcile(seed.company.id, seed.bankAccount.id, [seed.tx.id]);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.unreconciled).toBe(1);

      const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: seed.tx.id } });
      expect(txAfter.isReconciled).toBe(false);
      expect(txAfter.reconciliationPeriodId).toBeNull();
    });
  });

  // ── (e) RuleApplyRecord provenance ─────────────────────────────────────
  describe('(e) batch RuleApplyRecord provenance', () => {
    it('stores the winning rule id on the batch apply record', async () => {
      const seed = await seedCompany('e1');
      const primaryRule = await createRule(seed, {
        name: 'Match TEST',
        conditionValue: 'TEST',
        priority: 10,
      });
      const secondaryRule = await createRule(seed, {
        name: 'Match OTHER',
        conditionValue: 'OTHER',
        priority: 20,
      });

      const txA = await createTransaction(seed, 'TEST ONE');
      const txB = await createTransaction(seed, 'TEST TWO');
      const txC = await createTransaction(seed, 'OTHER CHARGE');

      mockEvaluateOperationalPolicy.mockResolvedValue(makeDecision('ALLOW'));

      const result = await executeApplyAllUseCase(seed.company.id, { userId: seed.user.id });
      expect(result.applyResult.appliedCount).toBe(3);

      const records = await db.ruleApplyRecord.findMany({
        where: { companyId: seed.company.id },
        include: { transactions: { select: { id: true } } },
      });
      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.origin).toBe('batch');
      expect(record.ruleId).toBe(primaryRule.id);
      expect(record.ruleId).toBeTruthy();

      // Rollback granularity is unchanged: the record still covers the batch.
      const coveredIds = record.transactions.map((t) => t.id).sort();
      expect(coveredIds).toEqual([txA.id, txB.id, txC.id].sort());

      const applied = await db.bankTransaction.findMany({
        where: { id: { in: [txA.id, txB.id, txC.id] } },
        select: { id: true, matchedRuleId: true },
      });
      const byId = Object.fromEntries(applied.map((t) => [t.id, t.matchedRuleId]));
      expect(byId[txA.id]).toBe(primaryRule.id);
      expect(byId[txB.id]).toBe(primaryRule.id);
      expect(byId[txC.id]).toBe(secondaryRule.id);
    });
  });

  // ── (f) rule deletion provenance ───────────────────────────────────────
  describe('(f) DELETE /api/bank-rules/[id]', () => {
    it('records RULE_DELETED provenance and stops issuing the explicit clearing write', async () => {
      const seed = await seedCompany('f1');
      const rule = await createRule(seed, { name: 'Deletable Rule', conditionValue: 'TEST' });
      const tx = await createTransaction(seed, 'TEST EXPENSE');

      await db.bankTransaction.update({
        where: { id: tx.id },
        data: { matchedRuleId: rule.id, glAccountId: seed.expenseGl.id },
      });

      const { DELETE } = await import('@/app/api/bank-rules/[id]/route');
      const res = await DELETE(
        new NextRequest(
          `http://localhost/api/bank-rules/${rule.id}?companyId=${seed.company.id}`,
          { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        ),
        { params: Promise.resolve({ id: rule.id }) },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      // The rule row is gone.
      expect(await db.bankRule.findUnique({ where: { id: rule.id } })).toBeNull();

      // Provenance is recorded with the rule name/id and the affected rows.
      const audits = await db.auditLog.findMany({
        where: { companyId: seed.company.id, action: 'RULE_DELETED' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].entity).toBe('BankRule');
      expect(audits[0].entityId).toBe(rule.id);
      const details = JSON.parse(audits[0].details ?? '{}');
      expect(details.ruleId).toBe(rule.id);
      expect(details.ruleName).toBe('Deletable Rule');
      expect(details.matchedTransactionCount).toBe(1);
      expect(details.transactionIds).toContain(tx.id);

      // The classification itself survives; the FK (ON DELETE SET NULL) is the
      // only thing that nulls matchedRuleId — the route no longer writes it.
      const txAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      expect(txAfter.glAccountId).toBe(seed.expenseGl.id);
      expect(txAfter.matchedRuleId).toBeNull();
    });
  });
});
