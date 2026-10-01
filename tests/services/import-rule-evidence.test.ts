// §GAP8-2B — productive rule feedback channel (ROADMAP GAP #8)
// The REAL rule path in importFile must feed statistical memory as
// advisory evidence: matched outcomes carry rule identity + provenance,
// no-match outcomes never invent a rule, and the KE-first hierarchy is
// unchanged (when a KNOWN treatment decides, the rules never run and no
// evidence is recorded).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ImportService } from '@/lib/services/import.service';
import {
  createAdapter,
  learnEntityTreatment,
  RULE_EVIDENCE_TYPE,
} from '@/memory/classification-knowledge';
import { db } from '@/lib/db';
import { createTestCompany, createTestGlAccount, clearDatabase } from '../helpers/factories';

const ENV_KEYS = ['BANK_RULE_ENGINE', 'RULE_ENGINE_ADAPTER_ENABLED', 'RULE_ENGINE_V2_ENABLED'] as const;

async function setupImport() {
  const company = await createTestCompany('Rule Feedback Co');
  const cashGl = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const revenueGl = await createTestGlAccount({
    companyId: company.id,
    code: '4010',
    name: 'Revenue',
    accountType: 'revenue',
    normalBalance: 'credit',
  });

  const bankAccount = await db.bankAccount.create({
    data: {
      companyId: company.id,
      accountName: 'Checking',
      bankName: 'Test Bank',
      accountNo: 'XXX-1',
      glAccountId: cashGl.id,
      balance: 0,
      currency: 'USD',
      isActive: true,
    },
  });

  const rule = await db.bankRule.create({
    data: {
      companyId: company.id,
      name: 'Vendor payments',
      conditionType: 'contains',
      conditionValue: 'VENDOR',
      transactionDirection: 'any',
      glAccountId: revenueGl.id,
      priority: 10,
      isActive: true,
    },
  });

  return { company, cashGl, revenueGl, bankAccount, rule };
}

const CSV_TWO_ROWS =
  'date,description,amount\n' +
  '2025-03-15,ACME SUPPLY,100.00\n' +
  '2025-03-16,ACME SUPPLY VENDOR PAYMENT,50.00\n';

function importCsv(companyId: string, bankAccountId: string, content: string) {
  return ImportService.importFile({
    companyId,
    bankAccountId,
    fileName: 'feedback.csv',
    extension: 'csv',
    buffer: Buffer.from(content),
    content,
  });
}

describe('§GAP8-2B — import rule execution feeds statistical memory', () => {
  beforeEach(async () => {
    await clearDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.BANK_RULE_ENGINE = 'legacy';
  });

  afterEach(async () => {
    await clearDatabase();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('T1+T8: a productive rule match records evidence; uncovered rows record no-match — rule behavior unchanged', async () => {
    const { company, revenueGl, bankAccount, rule } = await setupImport();

    const result = await importCsv(company.id, bankAccount.id, CSV_TWO_ROWS);

    // T8 — rule behavior itself is unchanged: exactly one row classified.
    expect(result.transactionCount).toBe(2);
    expect(result.autoCategorizedCount).toBe(1);

    const classified = await db.bankTransaction.findFirst({
      where: { statement: { bankAccountId: bankAccount.id }, glAccountId: revenueGl.id },
    });
    expect(classified).not.toBeNull();

    // Productive MATCHED evidence with full provenance.
    const matched = await db.memoryItem.findMany({
      where: { type: RULE_EVIDENCE_TYPE, companyId: company.id },
    });
    const parsed = matched.map((m) => JSON.parse(m.content));
    const matchEvidence = parsed.filter((p) => p.kind === 'RULE_MATCHED');
    expect(matchEvidence).toHaveLength(1);
    expect(matchEvidence[0]).toMatchObject({
      kind: 'RULE_MATCHED',
      ruleId: rule.id,
      glAccountId: revenueGl.id,
      originalDescription: 'ACME SUPPLY VENDOR PAYMENT',
      direction: 'credit',
    });
    // Traceability anchor equals the persisted row's import hash.
    expect(matchEvidence[0].transactionId).toBe(classified!.importHash);

    // The uncovered row produces NOT_MATCHED evidence without a rule identity.
    const noMatch = parsed.filter((p) => p.kind === 'RULE_NOT_MATCHED');
    expect(noMatch).toHaveLength(1);
    expect(noMatch[0]).toMatchObject({
      kind: 'RULE_NOT_MATCHED',
      originalDescription: 'ACME SUPPLY',
      direction: 'credit',
    });
    expect(noMatch[0].ruleId).toBeUndefined();

    // Advisory: everything stays tentative; no confidence evolution at all.
    expect(matched.every((m) => m.confidence === 'tentative')).toBe(true);
    const confidenceLogs = await db.confidenceLog.count({
      where: { itemId: { in: matched.map((m) => m.id) } },
    });
    expect(confidenceLogs).toBe(0);
  });

  it('T9: KNOWN treatment stays authoritative — rules never run, so no evidence is recorded', async () => {
    const { company, cashGl, revenueGl, bankAccount } = await setupImport();

    // Identity known with an authoritative treatment for BOTH descriptions
    // (the rule would have matched the VENDOR one had it been consulted).
    const entity = await db.companyKnowledge.create({
      data: {
        companyId: company.id,
        type: 'COMPANY',
        canonicalName: 'ACME SUPPLY',
        aliases: ['ACME SUPPLY VENDOR PAYMENT'],
        metadata: {},
        source: 'company_knowledge',
        status: 'active',
      },
    });
    const keAdapter = createAdapter(db, (fn) => db.$transaction(fn));
    const learned = await learnEntityTreatment(
      keAdapter,
      company.id,
      entity.id,
      cashGl.id,
      'any',
      'user_correction',
    );
    expect(learned.status).not.toBe('ERROR');

    const result = await importCsv(company.id, bankAccount.id, CSV_TWO_ROWS);

    // KE decides: both rows classified by treatment, rules never consulted.
    expect(result.transactionCount).toBe(2);
    expect(result.autoCategorizedCount).toBe(0);

    const treated = await db.bankTransaction.findMany({
      where: { statement: { bankAccountId: bankAccount.id }, glAccountId: cashGl.id },
    });
    expect(treated).toHaveLength(2);

    // No rule ran → zero rule evidence (and the rule target is untouched).
    const evidenceRows = await db.memoryItem.findMany({
      where: { type: RULE_EVIDENCE_TYPE, companyId: company.id },
    });
    expect(evidenceRows).toHaveLength(0);

    const ruleClassified = await db.bankTransaction.count({
      where: { statement: { bankAccountId: bankAccount.id }, glAccountId: revenueGl.id },
    });
    expect(ruleClassified).toBe(0);
  });
});
