import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearDatabase,
  createTestCompany,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
} from '../helpers/factories';
import { classifyEntity, getEntityCandidates, getKnownSocioPatterns } from '@/lib/services/entity-classifier';
import { detectConflictSync } from '@/lib/services/entity-conflict-detector';
import { entityFirstCheck } from '@/lib/services/rule-matching-engine';
import { extractComponents, loadConfig } from '@/lib/services/entity-detector';
import { db } from '@/lib/db';

describe('Entity Classification Flow — Integration', () => {
  let companyId: string;
  let bankAccountId: string;
  let statementId: string;

  beforeEach(async () => {
    await clearDatabase();
    const company = await createTestCompany('Entity First Test Co');
    companyId = company.id;
    const gl = await createTestGlAccount({ companyId, code: '1000', name: 'Cash' });
    const ba = await createTestBankAccount(companyId, gl.id, 'Entity Test Bank');
    bankAccountId = ba.id;
    const stmt = await createTestBankStatement(companyId, bankAccountId);
    statementId = stmt.id;
  });

  describe('classifyEntity()', () => {
    it('debe guardar entidad SOCIO en DB y poder recuperarla como known pattern', async () => {
      await classifyEntity({
        companyId,
        pattern: 'laura quijano',
        role: 'SOCIO',
        roles: ['SOCIO'],
        source: 'user',
      });

      const socioContext = await db.entityContext.findFirst({
        where: { companyId, pattern: 'laura quijano' },
      });

      expect(socioContext).not.toBeNull();
      expect(socioContext!.role).toBe('SOCIO');
      expect(socioContext!.roles).toContain('SOCIO');

      const known = await getKnownSocioPatterns(companyId);
      expect(known).toContain('laura quijano');
    });

    it('debe guardar entidad CLIENTE con roles array JSON', async () => {
      await classifyEntity({
        companyId,
        pattern: 'juan perez',
        role: 'CLIENTE',
        roles: ['CLIENTE', 'PROVEEDOR'],
        source: 'user',
      });

      const ctx = await db.entityContext.findFirst({
        where: { companyId, pattern: 'juan perez' },
      });

      expect(ctx).not.toBeNull();
      expect(ctx!.role).toBe('CLIENTE');

      const parsed: string[] = JSON.parse(ctx!.roles!);
      expect(parsed).toContain('CLIENTE');
      expect(parsed).toContain('PROVEEDOR');
    });

    it('debe asociar GL account code si existe', async () => {
      const capGl = await createTestGlAccount({ companyId, code: '3010', name: 'Capital Social' });

      await classifyEntity({
        companyId,
        pattern: 'omar mira',
        role: 'SOCIO',
        roles: ['SOCIO'],
        glAccountCode: '3010',
        source: 'user',
      });

      const ctx = await db.entityContext.findFirst({
        where: { companyId, pattern: 'omar mira' },
      });

      expect(ctx).not.toBeNull();
      expect(ctx!.glAccountId).toBe(capGl.id);
    });
  });

  describe('getEntityCandidates()', () => {
    it('debe retornar candidatos de transacciones sin GL account', async () => {
      await createTestBankTransaction(companyId, statementId, {
        date: '2025-03-15',
        amount: -150.0,
        description: 'Zelle payment to LAURA QUIJANO',
      });
      await createTestBankTransaction(companyId, statementId, {
        date: '2025-03-16',
        amount: -250.0,
        description: 'Zelle payment to LAURA QUIJANO',
      });

      const candidates = await getEntityCandidates(companyId);
      expect(candidates.length).toBeGreaterThan(0);
      const laura = candidates.find((c) =>
        c.canonicalName.toLowerCase().includes('laura quijano'),
      );
      expect(laura).toBeDefined();
      expect(laura!.occurrences).toBe(2);
    });

    it('NO debe incluir entidades ya clasificadas', async () => {
      await createTestBankTransaction(companyId, statementId, {
        date: '2025-03-15',
        amount: -150.0,
        description: 'Zelle payment to LAURA QUIJANO',
      });

      await classifyEntity({
        companyId,
        pattern: 'laura quijano',
        role: 'SOCIO',
        source: 'user',
      });

      const candidates = await getEntityCandidates(companyId);
      const laura = candidates.find((c) =>
        c.canonicalName.toLowerCase().includes('laura quijano'),
      );
      expect(laura).toBeUndefined();
    });

    it('NO debe incluir entidades que ya tienen BankRule', async () => {
      await createTestBankTransaction(companyId, statementId, {
        date: '2025-03-15',
        amount: -150.0,
        description: 'Zelle payment to JUAN PEREZ',
      });
      await createTestBankTransaction(companyId, statementId, {
        date: '2025-03-16',
        amount: -250.0,
        description: 'Zelle payment to JUAN PEREZ',
      });

      await classifyEntity({
        companyId,
        pattern: 'juan perez',
        role: 'CLIENTE',
        source: 'user',
      });

      // Create a bank rule that covers this entity
      await db.bankRule.create({
        data: {
          companyId,
          name: 'Test Rule for Juan',
          conditionType: 'contains',
          conditionValue: 'juan perez',
          transactionDirection: 'any',
          glAccountId: null,
          isActive: true,
          priority: 5,
        },
      });

      const candidates = await getEntityCandidates(companyId);
      const juan = candidates.find((c) =>
        c.canonicalName.toLowerCase().includes('juan perez'),
      );
      expect(juan).toBeUndefined();
    });
  });

  describe('entityFirstCheck()', () => {
    it('debe detectar conflicto merchant+SOCIO y sugerir skip', () => {
      const tx = {
        description: 'AMERICAN EXPRESS DES:ACH PMT ID:123 INDN:LAURA QUIJANO CO ID:9876',
        amount: -500,
      };
      const knownSocioPatterns = ['laura quijano'];

      const result = entityFirstCheck(tx, knownSocioPatterns, true);
      expect(result.skipSocioRules).toBe(true);
      expect(result.reason).toContain('SOCIO');
    });

    it('NO debe skippear si no hay merchant en P1', () => {
      const tx = {
        description: 'Zelle payment to LAURA QUIJANO',
        amount: -500,
      };
      const knownSocioPatterns = ['laura quijano'];

      const result = entityFirstCheck(tx, knownSocioPatterns, true);
      expect(result.skipSocioRules).toBe(false);
    });

    it('NO debe skippear si entityFirstMode=false (legacy)', () => {
      const tx = {
        description: 'AMERICAN EXPRESS DES:ACH PMT ID:123 INDN:LAURA QUIJANO CO ID:9876',
        amount: -500,
      };
      const result = entityFirstCheck(tx, ['laura quijano'], false);
      expect(result.skipSocioRules).toBe(false);
    });

    it('NO debe skippear si conocidoSOCIO est vacío', () => {
      const tx = {
        description: 'AMERICAN EXPRESS DES:ACH PMT ID:123 INDN:LAURA QUIJANO CO ID:9876',
        amount: -500,
      };
      const result = entityFirstCheck(tx, [], true);
      expect(result.skipSocioRules).toBe(false);
    });
  });

  describe('detectConflictSync()', () => {
    it('debe detectar merchant + SOCIO en INDN', () => {
      const result = detectConflictSync(
        'KMF DES:KMFUSA.com ID:9876543210 INDN:OMAR MIRA CO ID:1234',
        ['omar mira'],
      );
      expect(result.hasMerchant).toBe(true);
      expect(result.hasSocioInIndn).toBe(true);
      expect(result.merchantName).toBe('KMF');
      expect(result.socioIndnName).toBe('OMAR MIRA');
    });

    it('NO debe marcar conflicto si INDN no es SOCIO conocido', () => {
      const result = detectConflictSync(
        'KMF DES:KMFUSA.com ID:9876543210 INDN:UNKNOWN GUY CO ID:1234',
        ['omar mira'],
      );
      expect(result.hasMerchant).toBe(true);
      expect(result.hasSocioInIndn).toBe(false);
    });

    it('NO debe marcar conflicto si no hay merchant (solo Zelle)', () => {
      const result = detectConflictSync(
        'Zelle payment to LAURA QUIJANO',
        ['laura quijano'],
      );
      expect(result.hasMerchant).toBe(false);
      expect(result.hasSocioInIndn).toBe(false);
    });
  });
});

describe('Condition specificity — SOCIO role fallback', () => {
  it('debe usar contains para SOCIO en lugar de starts_with', async () => {
    const { parseConversationalContext } = await import('@/lib/services/conversational-service');

    const result = await parseConversationalContext(
      'company-test',
      'laura quijano',
      'socio retiro de capital laura quijano',
    );

    expect(result.conditions).toBeDefined();
    expect(result.conditions!.length).toBeGreaterThan(0);
    const cond = result.conditions![0];
    expect(cond.operator).toBe('contains');
    expect(cond.value).toBe('laura quijano');
  }, 15000);
});
