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

const { ImportService } = await import('@/lib/services/import.service')
const { toRulePrecedenceRule } = await import('@/lib/services/rule-precedence-shadow')

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
