import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ImportService } from '@/lib/services/import.service'
import {
  createTestCompany,
  createTestGlAccount,
  createTestBankAccount,
  clearDatabase,
} from '../../helpers/factories'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'

const { mockRunRuleEngineV2, mockFindMatchingRule } = vi.hoisted(() => ({
  mockRunRuleEngineV2: vi.fn(),
  mockFindMatchingRule: vi.fn(),
}))

vi.mock('@/lib/services/rule-engine-adapter', () => ({
  runRuleEngineV2: (...args: unknown[]) => mockRunRuleEngineV2(...args),
}))

vi.mock('@/lib/services/rule-matching-engine', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@/lib/services/rule-matching-engine')
  mockFindMatchingRule.mockImplementation(actual.findMatchingRule as (...args: unknown[]) => unknown)
  return { ...actual, findMatchingRule: mockFindMatchingRule }
})

describe('ImportService — V2 flag integration', () => {
  let company: Awaited<ReturnType<typeof createTestCompany>>
  let glAccount: Awaited<ReturnType<typeof createTestGlAccount>>
  let bankAccount: Awaited<ReturnType<typeof createTestBankAccount>>

  beforeEach(async () => {
    await clearDatabase()
    vi.clearAllMocks()
    vi.unstubAllEnvs()

    company = await createTestCompany('V2 Integration Test')
    glAccount = await createTestGlAccount({ companyId: company.id, code: '6000', name: 'Gastos' })
    bankAccount = await createTestBankAccount(company.id, glAccount.id)
  })

  afterEach(async () => {
    await clearDatabase()
    vi.unstubAllEnvs()
  })

  describe('RULE_ENGINE_V2_ENABLED=false (legacy)', () => {
    it('uses findMatchingRule and increments autoCategorizedCount', async () => {
      await db.bankRule.create({
        data: {
          companyId: company.id,
          name: 'Amazon',
          conditionType: 'contains',
          conditionValue: 'AMAZON',
          glAccountId: glAccount.id,
          priority: 10,
        },
      })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      const result = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(result.autoCategorizedCount).toBe(1)
      expect(result.transactionCount).toBe(1)
      expect(mockFindMatchingRule).toHaveBeenCalled()

      const txs = await db.bankTransaction.findMany({
        where: { statement: { companyId: company.id } },
        select: { glAccountId: true, matchedRuleId: true },
      })
      expect(txs).toHaveLength(1)
      expect(txs[0]!.glAccountId).toBe(glAccount.id)
      expect(txs[0]!.matchedRuleId).not.toBeNull()
    })

    it('leaves glAccountId and matchedRuleId null when no rule matches', async () => {
      const csvContent = 'date,description,amount\n2025-06-01,COFFEE SHOP,-5.00'
      const result = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(result.autoCategorizedCount).toBe(0)
      expect(mockFindMatchingRule).toHaveBeenCalled()

      const txs = await db.bankTransaction.findMany({
        where: { statement: { companyId: company.id } },
        select: { glAccountId: true, matchedRuleId: true },
      })
      expect(txs[0]!.glAccountId).toBeNull()
      expect(txs[0]!.matchedRuleId).toBeNull()
    })
  })

  describe('RULE_ENGINE_V2_ENABLED=true', () => {
    beforeEach(() => {
      vi.stubEnv('RULE_ENGINE_V2_ENABLED', 'true')
    })

    it('calls runRuleEngineV2 and maps matched outcome', async () => {
      const rule = await db.bankRule.create({
        data: {
          companyId: company.id,
          name: 'Amazon',
          conditionType: 'contains',
          conditionValue: 'AMAZON',
          glAccountId: glAccount.id,
          priority: 10,
        },
      })

      mockRunRuleEngineV2.mockResolvedValue({
        outcome: 'matched',
        classification: { glAccountId: glAccount.id },
        matchedRuleId: rule.id,
      })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      const result = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(result.autoCategorizedCount).toBe(1)
      expect(result.transactionCount).toBe(1)
      expect(mockRunRuleEngineV2).toHaveBeenCalledOnce()

      const txs = await db.bankTransaction.findMany({
        where: { statement: { companyId: company.id } },
        select: { glAccountId: true, matchedRuleId: true },
      })
      expect(txs).toHaveLength(1)
      expect(txs[0]!.glAccountId).toBe(glAccount.id)
      expect(txs[0]!.matchedRuleId).toBe(rule.id)
    })

    it('sends uniqueHashes[idx] as transaction.id (SHA-256, not pending-N)', async () => {
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending' })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      const args = mockRunRuleEngineV2.mock.calls[0]!
      const txId = args[0].id

      expect(txId).not.toMatch(/^pending-\d+$/)
      expect(txId).toEqual(expect.any(String))
      expect(txId.length).toBeGreaterThan(0)

      const txs = await db.bankTransaction.findMany({
        where: { statement: { companyId: company.id } },
        select: { importHash: true },
      })
      expect(txs[0]!.importHash).toBe(txId)
    })

    it('produces different transaction.id for different transactions in same import', async () => {
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending' })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON,-45.99\n2025-06-02,UBER,-12.50'
      await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      const ids = mockRunRuleEngineV2.mock.calls.map((c: unknown[]) => c[0].id)
      expect(ids[0]).not.toBe(ids[1])
      expect(ids[0]).not.toMatch(/^pending-\d+$/)
      expect(ids[1]).not.toMatch(/^pending-\d+$/)
    })

    it('does not call findMatchingRule when flag is ON', async () => {
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending' })

      const csvContent = 'date,description,amount\n2025-06-01,COFFEE SHOP,-5.00'
      await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(mockFindMatchingRule).not.toHaveBeenCalled()
    })

    it('maps pending outcome as null glAccountId and matchedRuleId', async () => {
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending' })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      const result = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(result.autoCategorizedCount).toBe(0)

      const txs = await db.bankTransaction.findMany({
        where: { statement: { companyId: company.id } },
        select: { glAccountId: true, matchedRuleId: true },
      })
      expect(txs).toHaveLength(1)
      expect(txs[0]!.glAccountId).toBeNull()
      expect(txs[0]!.matchedRuleId).toBeNull()
    })

    it('pending outcome does not create journal entry', async () => {
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending' })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      const journals = await db.journalEntry.findMany({
        where: { companyId: company.id },
      })
      expect(journals).toHaveLength(0)
    })

    it('pending + errorCode same as plain pending (no legacy fallback)', async () => {
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending', errorCode: 'engine_execution_error' })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      const result = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(result.autoCategorizedCount).toBe(0)
      expect(mockFindMatchingRule).not.toHaveBeenCalled()

      const txs = await db.bankTransaction.findMany({
        where: { statement: { companyId: company.id } },
        select: { glAccountId: true, matchedRuleId: true },
      })
      expect(txs[0]!.glAccountId).toBeNull()
      expect(txs[0]!.matchedRuleId).toBeNull()
    })

    it('pending + errorCode logs a warning with errorCode, companyId, bankAccountId, transactionId', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending', errorCode: 'engine_execution_error' })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(warnSpy).toHaveBeenCalledTimes(1)
      const callArgs = warnSpy.mock.calls[0]!
      expect(callArgs[0]).toBe('Rule Engine v2 import evaluation failed')
      const data = callArgs[1] as Record<string, unknown>
      expect(data.errorCode).toBe('engine_execution_error')
      expect(data.companyId).toBe(company.id)
      expect(data.bankAccountId).toBe(bankAccount.id)
      expect(data.transactionId).toEqual(expect.any(String))

      warnSpy.mockRestore()
    })

    it('pending without errorCode does not log a warning', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending' })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('passes bankAccountId and companyId to runRuleEngineV2', async () => {
      mockRunRuleEngineV2.mockResolvedValue({ outcome: 'pending' })

      const csvContent = 'date,description,amount\n2025-06-01,AMAZON PURCHASE,-45.99'
      await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'test.csv',
        extension: 'csv',
        buffer: Buffer.from(''),
        content: csvContent,
      })

      expect(mockRunRuleEngineV2).toHaveBeenCalledOnce()
      const args = mockRunRuleEngineV2.mock.calls[0]!
      expect(args[0]).toMatchObject({
        description: 'AMAZON PURCHASE',
        amount: -45.99,
        bankAccountId: bankAccount.id,
      })
      expect(args[3]).toBe(company.id)
    })
  })
})
