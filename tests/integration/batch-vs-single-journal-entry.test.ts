import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as applyAll } from '@/app/api/bank-rules/apply-all/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  clearDatabase,
} from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

describe('Batch vs Single — same Journal Entry', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  async function setupIdenticalScenario(companyId: string, glAccountId: string) {
    const bankAccount = await createTestBankAccount(companyId, glAccountId, 'Test Bank');
    const statement = await createTestBankStatement(companyId, bankAccount.id);

    await db.bankRule.create({
      data: {
        companyId,
        name: 'Office Supplies',
        conditionType: 'contains',
        conditionValue: 'OFFICE',
        transactionDirection: 'any',
        glAccountId,
        priority: 10,
      },
    });

    const tx = await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2025-06-15'),
        amount: -150.0,
        description: 'OFFICE DEPOT PURCHASE',
        isReconciled: false,
      },
    });

    return {
      bankAccount,
      statement,
      transaction: tx,
      ruleName: 'Office Supplies',
    };
  }

  async function fetchJournalEntryData(companyId: string) {
    const entries = await db.journalEntry.findMany({
      where: { companyId },
      include: {
        lines: true,
        transactions: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return entries;
  }

  it('batch y single producen exactamente el mismo Journal Entry para la misma transacción y regla', async () => {
    // ── Batch ──────────────────────────────────────────────
    const userBatch = await createTestUser('batch@example.com');
    const companyBatch = await createTestCompany('Batch Co');
    await createTestCompanyMember(userBatch.id, companyBatch.id);
    const tokenBatch = await createSession(userBatch.id);
    const glBatch = await createTestGlAccount({ companyId: companyBatch.id, code: '5000', name: 'Office Supplies' });

    const { transaction: txBatch } = await setupIdenticalScenario(companyBatch.id, glBatch.id);

    const reqBatch = new NextRequest('http://localhost/api/bank-rules/apply-all', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenBatch}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ companyId: companyBatch.id, confirmed: true }),
    });
    const resBatch = await applyAll(reqBatch, { params: Promise.resolve({}) });
    expect(resBatch.status).toBe(200);

    const batchEntries = await fetchJournalEntryData(companyBatch.id);
    expect(batchEntries).toHaveLength(1);
    const batchEntry = batchEntries[0];

    // ── Single ─────────────────────────────────────────────
    await clearDatabase();

    const userSingle = await createTestUser('single@example.com');
    const companySingle = await createTestCompany('Single Co');
    await createTestCompanyMember(userSingle.id, companySingle.id);
    const tokenSingle = await createSession(userSingle.id);
    const glSingle = await createTestGlAccount({ companyId: companySingle.id, code: '5000', name: 'Office Supplies' });

    const { transaction: txSingle } = await setupIdenticalScenario(companySingle.id, glSingle.id);

    // Find the rule id for single mode
    const rule = await db.bankRule.findFirstOrThrow({
      where: { companyId: companySingle.id, name: 'Office Supplies' },
    });

    const reqSingle = new NextRequest('http://localhost/api/bank-rules/apply-all', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenSingle}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyId: companySingle.id,
        confirmed: true,
        mode: 'single',
        transactionId: txSingle.id,
        forcedRuleId: rule.id,
      }),
    });
    const resSingle = await applyAll(reqSingle, { params: Promise.resolve({}) });
    expect(resSingle.status).toBe(200);

    const singleEntries = await fetchJournalEntryData(companySingle.id);
    expect(singleEntries).toHaveLength(1);
    const singleEntry = singleEntries[0];

    // ── Assert ────────────────────────────────────────────
    // Both have 1 transaction linked
    expect(batchEntry.transactions).toHaveLength(1);
    expect(singleEntry.transactions).toHaveLength(1);

    // Both have 2 lines (double entry)
    expect(batchEntry.lines).toHaveLength(2);
    expect(singleEntry.lines).toHaveLength(2);

    // Same total line amount
    const batchLineTotal = batchEntry.lines.reduce((sum, l) => sum + Number(l.amount), 0);
    const singleLineTotal = singleEntry.lines.reduce((sum, l) => sum + Number(l.amount), 0);
    expect(batchLineTotal).toBe(singleLineTotal);

    // Same line count per side
    const batchDebitLines = batchEntry.lines.filter((l) => l.type === 'debit');
    const batchCreditLines = batchEntry.lines.filter((l) => l.type === 'credit');
    const singleDebitLines = singleEntry.lines.filter((l) => l.type === 'debit');
    const singleCreditLines = singleEntry.lines.filter((l) => l.type === 'credit');
    expect(batchDebitLines).toHaveLength(singleDebitLines.length);
    expect(batchCreditLines).toHaveLength(singleCreditLines.length);

    // Same debit total
    const batchDebitTotal = batchDebitLines.reduce((s, l) => s + Number(l.amount), 0);
    const singleDebitTotal = singleDebitLines.reduce((s, l) => s + Number(l.amount), 0);
    expect(batchDebitTotal).toBe(singleDebitTotal);

    // Same credit total
    const batchCreditTotal = batchCreditLines.reduce((s, l) => s + Number(l.amount), 0);
    const singleCreditTotal = singleCreditLines.reduce((s, l) => s + Number(l.amount), 0);
    expect(batchCreditTotal).toBe(singleCreditTotal);

    // Both balance (debits === credits)
    expect(batchDebitTotal).toBe(batchCreditTotal);
    expect(singleDebitTotal).toBe(singleCreditTotal);
  });
});
