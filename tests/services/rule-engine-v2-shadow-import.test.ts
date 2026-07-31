import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestCompany, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

vi.mock('@/lib/services/rule-engine-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/rule-engine-adapter')>();
  return {
    ...actual,
    runRuleEngineV2Shadow: vi.fn(actual.runRuleEngineV2Shadow),
  };
});

vi.mock('@/lib/rule-engine/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rule-engine/audit')>();
  return {
    persistRuleExecutionAudit: vi.fn(actual.persistRuleExecutionAudit),
  };
});

const { ImportService } = await import('@/lib/services/import.service');
const { runRuleEngineV2Shadow } = await import('@/lib/services/rule-engine-adapter');
const { persistRuleExecutionAudit } = await import('@/lib/rule-engine/audit');

const fixturesPath = join(__dirname, '../fixtures/boa-statements');

const ENV_KEYS = [
  'RULE_PRECEDENCE_SHADOW_ENABLED',
  'BANK_RULE_ENGINE',
  'RULE_ENGINE_ADAPTER_ENABLED',
  'RULE_ENGINE_V2_ENABLED',
] as const;

const NEVER_MATCH_KEYWORD = 'ZZZ_NONEXISTENT_KEYWORD_2026';

async function setupImport() {
  const company = await createTestCompany('LQ&OM LLC');
  const glAccount = await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });

  const bankAccount = await db.bankAccount.create({
    data: {
      companyId: company.id,
      accountName: 'BOA Checking',
      bankName: 'Bank of America',
      accountNo: 'XXXX-1234',
      glAccountId: glAccount.id,
      balance: 0,
      currency: 'USD',
      isActive: true,
    },
  });

  const conditions = [{ field: 'description', operator: 'contains', value: NEVER_MATCH_KEYWORD }];
  await db.bankRule.createMany({
    data: [
      { companyId: company.id, name: 'nope-1', conditionType: 'contains', conditionValue: NEVER_MATCH_KEYWORD, conditions, glAccountId: glAccount.id, priority: 10 },
      { companyId: company.id, name: 'nope-2', conditionType: 'contains', conditionValue: NEVER_MATCH_KEYWORD, conditions, glAccountId: glAccount.id, priority: 20 },
    ],
  });

  return { company, bankAccount };
}

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('BRE-001 — Rule Engine v2 divergence events in shadow mode', () => {
  let _companyId: string | null = null;

  beforeEach(async () => {
    _companyId = null;
    await clearDatabase();
    vi.clearAllMocks();
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true';
    vi.mocked(runRuleEngineV2Shadow).mockRestore();
    vi.mocked(persistRuleExecutionAudit).mockRestore();
  });

  afterEach(async () => {
    if (_companyId) {
      await db.ruleExecutionAudit.deleteMany({ where: { companyId: _companyId } });
      await db.bankRule.deleteMany({ where: { companyId: _companyId } });
    }
    await clearDatabase();
    clearEnv();
  });

  it('shadow with V2 NOT productive writes zero RuleExecutionAudit rows', async () => {
    process.env.RULE_ENGINE_ADAPTER_ENABLED = '1';
    const { company, bankAccount } = await setupImport();
    _companyId = company.id;

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    });

    expect(result.statementId).toBeTruthy();
    expect(result.transactionCount).toBeGreaterThan(0);
    expect(vi.mocked(runRuleEngineV2Shadow)).toHaveBeenCalled();

    // Persistence call vs committed row: shadow V2 is pure, so persistRuleExecutionAudit
    // must never be called, and no row may ever land for this company.
    expect(vi.mocked(persistRuleExecutionAudit)).not.toHaveBeenCalled();
    const auditCount = await db.ruleExecutionAudit.count({ where: { companyId: company.id } });
    expect(auditCount).toBe(0);
  });

  it('shadow with V2 productive: exactly one execution and one persist per transaction', async () => {
    process.env.BANK_RULE_ENGINE = 'v2';
    process.env.RULE_ENGINE_V2_ENABLED = '1';
    const { company, bankAccount } = await setupImport();
    _companyId = company.id;

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    });

    expect(result.statementId).toBeTruthy();
    expect(result.transactionCount).toBeGreaterThan(0);

    // Shadow must reuse the productive V2 result — no second V2 execution.
    expect(vi.mocked(runRuleEngineV2Shadow)).not.toHaveBeenCalled();

    // One persistence CALL per productive V2 evaluation (deterministic — the call is
    // synchronous inside evaluateRules, before the fire-and-forget .catch()).
    expect(vi.mocked(persistRuleExecutionAudit)).toHaveBeenCalledTimes(result.transactionCount);

    // COMMITTED ROW check is separate: the write is fire-and-forget, so poll briefly
    // until the count reaches transactionCount.
    await vi.waitFor(
      async () => {
        const auditCount = await db.ruleExecutionAudit.count({ where: { companyId: company.id } });
        expect(auditCount).toBe(result.transactionCount);
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('logs a divergence event when shadow V2 disagrees with precedence', async () => {
    process.env.BANK_RULE_ENGINE = 'legacy';
    const { company, bankAccount } = await setupImport();
    _companyId = company.id;

    const warnSpy = vi.spyOn(logger, 'warn');

    vi.mocked(runRuleEngineV2Shadow).mockReturnValue({
      outcome: 'matched',
      matchedRuleId: 'rule-ghost',
      classification: { glAccountId: 'gl-ghost' },
    });

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    });

    expect(result.statementId).toBeTruthy();

    expect(warnSpy).toHaveBeenCalledWith(
      '[RULE ENGINE V2 DIVERGENCE]',
      expect.objectContaining({
        event: expect.objectContaining({
          transactionId: expect.any(String),
          companyId: company.id,
          v2Result: expect.objectContaining({ matchedRuleId: 'rule-ghost' }),
        }),
      }),
    );
    warnSpy.mockRestore();
  });

  it('does NOT log a divergence event when engines agree', async () => {
    process.env.BANK_RULE_ENGINE = 'legacy';
    const { company, bankAccount } = await setupImport();
    _companyId = company.id;

    const warnSpy = vi.spyOn(logger, 'warn');

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    });

    expect(result.statementId).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalledWith('[RULE ENGINE V2 DIVERGENCE]', expect.anything());
    warnSpy.mockRestore();
  });

  it('continues the import when the shadow V2 evaluation throws', async () => {
    process.env.BANK_RULE_ENGINE = 'legacy';
    const { company, bankAccount } = await setupImport();
    _companyId = company.id;

    const errorSpy = vi.spyOn(logger, 'error');

    vi.mocked(runRuleEngineV2Shadow).mockImplementation(() => {
      throw new Error('simulated shadow failure');
    });

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    });

    expect(result.statementId).toBeTruthy();
    expect(result.transactionCount).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalledWith(
      '[RULE ENGINE V2 SHADOW ERROR]',
      expect.objectContaining({ companyId: company.id }),
    );
    errorSpy.mockRestore();
  });
});
