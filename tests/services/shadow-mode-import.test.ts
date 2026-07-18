import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createTestCompany, createTestGlAccount, clearDatabase } from '../helpers/factories'
import { db } from '@/lib/db'

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

const { ImportService } = await import('@/lib/services/import.service')
const { toRulePrecedenceRule } = await import('@/lib/services/rule-precedence-shadow')
const { createAuditLogWithRetry } = await import('@/lib/audit')

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
