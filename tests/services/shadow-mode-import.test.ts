import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createTestCompany, createTestGlAccount, clearDatabase } from '../helpers/factories'
import { db } from '@/lib/db'
import type { OperationalPolicyDecision } from '@/lib/operational-policy/types'
import type { ShadowMetricsReport } from '@/lib/services/shadow-metrics-reader'

vi.mock('@/lib/services/rule-precedence-shadow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/rule-precedence-shadow')>()
  return {
    ...actual,
    toRulePrecedenceRule: vi.fn(actual.toRulePrecedenceRule),
  }
})

vi.mock('@/lib/audit', async (importOriginal) => {
  const audit = await importOriginal<typeof import('@/lib/audit')>()
  return {
    createAuditLogWithRetry: vi.fn((...args: any[]) => audit.createAuditLogWithRetry(...args)),
  }
})

vi.mock('@/lib/operational-policy/policy-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operational-policy/policy-service')>()
  return {
    ...actual,
    evaluateOperationalPolicy: vi.fn(),
  }
})

const { ImportService } = await import('@/lib/services/import.service')
const { toRulePrecedenceRule } = await import('@/lib/services/rule-precedence-shadow')
const { createAuditLogWithRetry } = await import('@/lib/audit')
const { evaluateOperationalPolicy } = await import('@/lib/operational-policy/policy-service')

const fixturesPath = join(__dirname, '../fixtures/boa-statements')

describe('S7-02 Shadow Mode — mapping una vez por lote', () => {
  let _companyId: string | null = null

  beforeEach(async () => {
    _companyId = null
    await clearDatabase()
    vi.clearAllMocks()
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true'
  })

  afterEach(async () => {
    if (_companyId) {
      await db.bankRule.deleteMany({ where: { companyId: _companyId } })
    }
    await db.auditLog.deleteMany({ where: { action: 'RULE_PRECEDENCE_SHADOW_SUMMARY' } })
    await clearDatabase()
    delete process.env.RULE_PRECEDENCE_SHADOW_ENABLED
  })

  it('toRulePrecedenceRule se ejecuta N veces (N reglas), no N×M (M transacciones)', async () => {
    const company = await createTestCompany('LQ&OM LLC')
    _companyId = company.id

    const glAccount = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    })

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
    })

    await db.bankRule.createMany({
      data: [
        { companyId: company.id, name: 'apple', conditionType: 'contains', conditionValue: 'APPLE', glAccountId: glAccount.id, priority: 10 },
        { companyId: company.id, name: 'google', conditionType: 'contains', conditionValue: 'GOOG', glAccountId: glAccount.id, priority: 10 },
        { companyId: company.id, name: 'amazon', conditionType: 'contains', conditionValue: 'AMZN', glAccountId: glAccount.id, priority: 10 },
      ],
    })

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result.transactionCount).toBeGreaterThan(1)
    expect(vi.mocked(toRulePrecedenceRule)).toHaveBeenCalledTimes(3)
  })
})

describe('S7-03 Shadow Mode — acumulación y persistencia de resumen', () => {
  let _companyId: string | null = null
  let _bankAccountId: string | null = null

  async function setupImport(companyName = 'LQ&OM LLC') {
    const company = await createTestCompany(companyName)
    _companyId = company.id

    const glAccount = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    })

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
    })
    _bankAccountId = bankAccount.id

    await db.bankRule.createMany({
      data: [
        { companyId: company.id, name: 'apple', conditionType: 'contains', conditionValue: 'APPLE', glAccountId: glAccount.id, priority: 10 },
        { companyId: company.id, name: 'google', conditionType: 'contains', conditionValue: 'GOOG', glAccountId: glAccount.id, priority: 10 },
        { companyId: company.id, name: 'amazon', conditionType: 'contains', conditionValue: 'AMZN', glAccountId: glAccount.id, priority: 10 },
      ],
    })

    return { company, bankAccount }
  }

  beforeEach(async () => {
    _companyId = null
    _bankAccountId = null
    await clearDatabase()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    if (_companyId) {
      await db.bankRule.deleteMany({ where: { companyId: _companyId } })
    }
    await db.auditLog.deleteMany({ where: { action: 'RULE_PRECEDENCE_SHADOW_SUMMARY' } })
    await clearDatabase()
    delete process.env.RULE_PRECEDENCE_SHADOW_ENABLED
  })

  it('5. shadow apagado no crea resumen ni AuditLog', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'false'
    const { company, bankAccount } = await setupImport()

    await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    const logs = await db.auditLog.findMany({
      where: { action: 'RULE_PRECEDENCE_SHADOW_SUMMARY' },
    })
    expect(logs).toHaveLength(0)
  })

  it('6. shadow activo crea exactamente un AuditLog', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true'
    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    const logs = await db.auditLog.findMany({
      where: { action: 'RULE_PRECEDENCE_SHADOW_SUMMARY' },
      orderBy: { createdAt: 'asc' },
    })
    expect(logs).toHaveLength(1)
    expect(result.transactionCount).toBeGreaterThan(0)
  })

  it('7. entityId coincide con statementId', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true'
    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    const log = await db.auditLog.findFirst({
      where: { action: 'RULE_PRECEDENCE_SHADOW_SUMMARY' },
    })
    expect(log).not.toBeNull()
    expect(log!.entityId).toBe(result.statementId)
    expect(log!.entity).toBe('BankStatement')
  })

  it('8. details no contiene descripción, monto ni número bancario', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true'
    const { company, bankAccount } = await setupImport()

    await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    const log = await db.auditLog.findFirst({
      where: { action: 'RULE_PRECEDENCE_SHADOW_SUMMARY' },
    })
    expect(log).not.toBeNull()
    const details = log!.details ? JSON.parse(log!.details) : {}
    expect(details).not.toHaveProperty('description')
    expect(details).not.toHaveProperty('amount')
    expect(details).not.toHaveProperty('bankAccount')
    expect(details).not.toHaveProperty('accountNo')
    expect(details).not.toHaveProperty('conditionText')
    expect(details).toHaveProperty('totalEvaluated')
    expect(details).toHaveProperty('sameWinner')
    expect(details).toHaveProperty('shadowErrors')
  })

  it('9. error de persistencia no rompe la importación', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true'
    const { company, bankAccount } = await setupImport()

    vi.mocked(createAuditLogWithRetry).mockRejectedValueOnce(new Error('Simulated failure'))

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result.statementId).toBeTruthy()
    expect(result.transactionCount).toBeGreaterThan(0)
  })

  it('10. ImportResult permanece sin shadowSummary', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true'
    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).not.toHaveProperty('shadowSummary')
    expect(Object.keys(result)).toEqual([
      'statementId',
      'transactionCount',
      'autoCategorizedCount',
      'duplicatesSkipped',
      'newAccountCreated',
      'bankAccountName',
    ])
  })
})

describe('S7-09 Operational Policy Observation in Import', () => {
  let _companyId: string | null = null
  let _bankAccountId: string | null = null

  beforeEach(async () => {
    _companyId = null
    _bankAccountId = null
    await clearDatabase()
    vi.clearAllMocks()
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true'
    process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '1'
  })

  afterEach(async () => {
    if (_companyId) {
      await db.bankRule.deleteMany({ where: { companyId: _companyId } })
    }
    await db.auditLog.deleteMany({ where: { action: 'RULE_PRECEDENCE_SHADOW_SUMMARY' } })
    await db.auditLog.deleteMany({ where: { action: 'OPERATIONAL_POLICY_OBSERVATION' } })
    await clearDatabase()
    delete process.env.RULE_PRECEDENCE_SHADOW_ENABLED
    delete process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED
  })

  async function setupImport() {
    const company = await createTestCompany('LQ&OM LLC')
    _companyId = company.id

    const glAccount = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
      accountType: 'asset',
      normalBalance: 'debit',
    })

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
    })
    _bankAccountId = bankAccount.id

    await db.bankRule.createMany({
      data: [
        { companyId: company.id, name: 'apple', conditionType: 'contains', conditionValue: 'APPLE', glAccountId: glAccount.id, priority: 10 },
        { companyId: company.id, name: 'google', conditionType: 'contains', conditionValue: 'GOOG', glAccountId: glAccount.id, priority: 10 },
        { companyId: company.id, name: 'amazon', conditionType: 'contains', conditionValue: 'AMZN', glAccountId: glAccount.id, priority: 10 },
      ],
    })

    return { company, bankAccount }
  }

  function makeBaseMetrics(overrides?: Partial<ShadowMetricsReport>): ShadowMetricsReport {
    return {
      batches: 5, trustedBatches: 3, legacyBatches: 2, legacyUntrustedBatches: 0,
      invalidRecords: 0,
      totalEvaluated: 150, validComparisons: 148,
      sameDecision: 145, divergentDecision: 3, ambiguous: 0, errors: 0,
      agreementRate: 0.98, divergenceRate: 0.02, ambiguityRate: 0, errorRate: 0,
      reasons: { NO_MATCH: 2, AMBIGUOUS: 0, UNDETERMINED: 1, OTHER: 0 },
      ...overrides,
    }
  }

  function makeMockDecision(overrides?: Partial<OperationalPolicyDecision>): OperationalPolicyDecision {
    return {
      action: 'ALLOW',
      context: 'IMPORT',
      profileId: 'obs-pol-profile-v1',
      profileVersion: '1.0',
      readiness: { status: 'READY', metrics: makeBaseMetrics(), checks: [] },
      rules: [],
      reasons: { reasonCode: 'POLICY_ADHERED', summary: 'All checks passed' },
      ...overrides,
    }
  }

  // ─── T1: Flag OFF ────────────────────────────────────────

  it('T1: does not include policyObservation when flag is OFF', async () => {
    process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '0'
    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).not.toHaveProperty('policyObservation')
    expect(Object.keys(result)).toEqual([
      'statementId',
      'transactionCount',
      'autoCategorizedCount',
      'duplicatesSkipped',
      'newAccountCreated',
      'bankAccountName',
    ])
  })

  // ─── T2: Flag OFF + early return ─────────────────────────

  it('T2: flag OFF and early return — no policyObservation, no policy call', async () => {
    process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '0'
    const { company, bankAccount } = await setupImport()

    // First import: lands transactions (creates hashes in DB)
    const first = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })
    expect(first.transactionCount).toBeGreaterThan(0)

    // Second import: same file → all hashes exist → early return
    const second = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(second.statementId).toBe('')
    expect(second.transactionCount).toBe(0)
    expect(second.duplicatesSkipped).toBeGreaterThan(0)
    expect(second).not.toHaveProperty('policyObservation')
    expect(vi.mocked(evaluateOperationalPolicy)).not.toHaveBeenCalled()
  })

  // ─── T3: Flag ON, READY ───────────────────────────────────

  it('T3: includes AVAILABLE when evaluateOperationalPolicy returns READY', async () => {
    const mockDecision = makeMockDecision()
    vi.mocked(evaluateOperationalPolicy).mockResolvedValue(mockDecision)

    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({
      status: 'AVAILABLE',
      decision: {
        action: 'ALLOW',
        context: 'IMPORT',
        readiness: { status: 'READY' },
        reasons: { reasonCode: 'POLICY_ADHERED' },
      },
    })
  })

  // ─── T4: Flag ON, NOT_READY ───────────────────────────────

  it('T4: returns AVAILABLE with NOT_READY readiness', async () => {
    const mockDecision = makeMockDecision({
      action: 'WARN',
      readiness: {
        status: 'NOT_READY',
        metrics: makeBaseMetrics({ agreementRate: 0.85, divergenceRate: 0.15 }),
        checks: [],
        failedChecks: [{
          criterionId: 'agreementRate',
          threshold: 0.95,
          passed: false,
          actual: 0.85,
          expected: 0.95,
        }],
      },
      reasons: { reasonCode: 'DIVERGENCE_HIGH', summary: 'Divergence rate 15% exceeds 5% threshold' },
    })
    vi.mocked(evaluateOperationalPolicy).mockResolvedValue(mockDecision)

    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({
      status: 'AVAILABLE',
      decision: {
        action: 'WARN',
        context: 'IMPORT',
        readiness: { status: 'NOT_READY' },
        reasons: { reasonCode: 'DIVERGENCE_HIGH' },
      },
    })
  })

  // ─── T5: Flag ON, INSUFFICIENT_DATA ───────────────────────

  it('T5: returns AVAILABLE with INSUFFICIENT_DATA readiness', async () => {
    const mockDecision = makeMockDecision({
      action: 'ALLOW',
      readiness: {
        status: 'INSUFFICIENT_DATA',
        metrics: makeBaseMetrics({ totalEvaluated: 10, batches: 1 }),
        checks: [],
        reasons: ['Insufficient sample: only 10 transactions evaluated, minimum 100 required'],
      },
      reasons: { reasonCode: 'INSUFFICIENT_SAMPLE', summary: 'Minimum transaction threshold not met' },
    })
    vi.mocked(evaluateOperationalPolicy).mockResolvedValue(mockDecision)

    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({
      status: 'AVAILABLE',
      decision: {
        action: 'ALLOW',
        context: 'IMPORT',
        readiness: { status: 'INSUFFICIENT_DATA' },
        reasons: { reasonCode: 'INSUFFICIENT_SAMPLE' },
      },
    })
  })

  // ─── T6: Flag ON, no shadow ───────────────────────────────

  it('T6: does not include policyObservation when shadow is disabled', async () => {
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'false'
    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).not.toHaveProperty('policyObservation')
    expect(Object.keys(result)).toEqual([
      'statementId',
      'transactionCount',
      'autoCategorizedCount',
      'duplicatesSkipped',
      'newAccountCreated',
      'bankAccountName',
    ])
    expect(vi.mocked(evaluateOperationalPolicy)).not.toHaveBeenCalled()
  })

  // ─── T7: Flag ON + early return ──────────────────────────

  it('T7: flag ON and early return — no policyObservation, no audit log, no policy call', async () => {
    process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '1'
    const { company, bankAccount } = await setupImport()

    // Reset implementation so mock returns undefined by default
    // (vi.clearAllMocks() resets calls but NOT implementations from previous tests)
    vi.mocked(evaluateOperationalPolicy).mockReset()

    // First import: lands transactions
    const first = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })
    expect(first.transactionCount).toBeGreaterThan(0)

    // Reset mock so second import assertion is clean
    vi.mocked(evaluateOperationalPolicy).mockClear()

    // Second import: all hashes exist → early return before S7-09 block
    const second = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(second.statementId).toBe('')
    expect(second.transactionCount).toBe(0)
    expect(second.duplicatesSkipped).toBeGreaterThan(0)
    expect(second).not.toHaveProperty('policyObservation')
    expect(vi.mocked(evaluateOperationalPolicy)).not.toHaveBeenCalled()

    const policyLogs = await db.auditLog.findMany({
      where: { action: 'OPERATIONAL_POLICY_OBSERVATION' },
    })
    expect(policyLogs).toHaveLength(0)
  })

  // ─── T8: Provider throws → UNAVAILABLE ────────────────────

  it('T8: returns UNAVAILABLE when evaluateOperationalPolicy throws', async () => {
    vi.mocked(evaluateOperationalPolicy).mockRejectedValue(new Error('DB connection failed'))

    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({
      status: 'UNAVAILABLE',
      errorCode: 'POLICY_INTERNAL_ERROR',
    })
  })

  it('T8b: ValidationError maps to POLICY_VALIDATION_ERROR', async () => {
    const { ValidationError } = await import('@/lib/api-error')
    vi.mocked(evaluateOperationalPolicy).mockRejectedValue(new ValidationError('Invalid criteria'))

    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({
      status: 'UNAVAILABLE',
      errorCode: 'POLICY_VALIDATION_ERROR',
    })
  })

  it('T8c: AppError maps to POLICY_PROVIDER_ERROR', async () => {
    const { AppError } = await import('@/lib/api-error')
    vi.mocked(evaluateOperationalPolicy).mockRejectedValue(new AppError(503, 'Provider unavailable', 'PROVIDER_DOWN'))

    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({
      status: 'UNAVAILABLE',
      errorCode: 'POLICY_PROVIDER_ERROR',
    })
  })

  // ─── T9: Audit log failure, AVAILABLE preserved ──────────

  it('T9: audit log failure does NOT degrade AVAILABLE to UNAVAILABLE', async () => {
    const mockDecision = makeMockDecision()
    vi.mocked(evaluateOperationalPolicy).mockResolvedValue(mockDecision)

    const { company, bankAccount } = await setupImport()

    const spy = vi.spyOn(db.auditLog, 'create')
    spy.mockRejectedValue(new Error('Audit log write failed'))

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    spy.mockRestore()

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({
      status: 'AVAILABLE',
      decision: { context: 'IMPORT' },
    })

    const logs = await db.auditLog.findMany({
      where: { action: 'OPERATIONAL_POLICY_OBSERVATION' },
    })
    expect(logs).toHaveLength(0)
  })

  // ─── T10a: Single window invariant ───────────────────────

  it('T10a: same metricsWindow used for eval and audit log', async () => {
    const mockDecision = makeMockDecision()
    vi.mocked(evaluateOperationalPolicy).mockResolvedValue(mockDecision)

    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({ status: 'AVAILABLE' })

    // Capture the metricsQuery from the evaluateOperationalPolicy call
    expect(vi.mocked(evaluateOperationalPolicy)).toHaveBeenCalledTimes(1)
    const inputArg = vi.mocked(evaluateOperationalPolicy).mock.calls[0][0]
    expect(inputArg).toHaveProperty('metricsQuery')
    const capturedQuery = inputArg.metricsQuery

    // Capture the audit log payload
    const log = await db.auditLog.findFirst({
      where: { action: 'OPERATIONAL_POLICY_OBSERVATION' },
      orderBy: { createdAt: 'desc' },
    })
    expect(log).not.toBeNull()
    const details = JSON.parse(log!.details || '{}')

    // Assert: the SAME window was used (identical timestamps)
    expect(details.metricsWindow.from).toBe(capturedQuery.from.toISOString())
    expect(details.metricsWindow.to).toBe(capturedQuery.to.toISOString())
    expect(details.metricsWindow.source).toBe('IMPORT')
    expect(details.metricsWindow.trustPolicy).toBe('INCLUDE_LEGACY_IMPORT')
    expect(details.context).toBe('IMPORT')
  })

  // ─── T10b: Zero shadow records (fresh company) ──────────

  it('T10b: zero shadow records creates exactly one OPERATIONAL_POLICY_OBSERVATION audit log', async () => {
    const { company, bankAccount } = await setupImport()

    await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    const logs = await db.auditLog.findMany({
      where: { action: 'OPERATIONAL_POLICY_OBSERVATION' },
    })
    expect(logs).toHaveLength(1)
    expect(logs[0].entity).toBe('BankStatement')
    expect(logs[0].entityId).toBeTruthy()
  })
})
