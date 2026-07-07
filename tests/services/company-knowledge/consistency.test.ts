import { describe, it, expect } from 'vitest';
import {
  entityTypeSchema,
  decisionReasonSchema,
} from '@/internal/company-knowledge/entity/types';

const PRISMA_ENTITY_TYPES = [
  'PERSON',
  'COMPANY',
  'FINANCIAL_PRODUCT',
  'PLATFORM',
  'ASSET',
] as const;

const PRISMA_DECISION_REASONS = [
  'COMPANY_KNOWLEDGE_CONFIRMED',
  'COMPANY_KNOWLEDGE_UPDATED',
  'COMPANY_KNOWLEDGE_MERGED',
  'ENTITY_CONTEXT_MATCH',
  'BANK_RULE_MATCH',
  'LLM_SUGGESTION',
  'MANUAL_OVERRIDE',
  'FALLBACK_DEFAULT',
] as const;

function prismaToTsValue(prismaValue: string): string {
  return prismaValue.toLowerCase();
}

describe('EntityType consistency: Prisma ↔ Zod', () => {
  it('every Prisma EntityType has a matching Zod enum option', () => {
    const zodOptions = entityTypeSchema.options;
    for (const prismaValue of PRISMA_ENTITY_TYPES) {
      expect(zodOptions).toContain(prismaToTsValue(prismaValue));
    }
  });

  it('Prisma and Zod have the same number of EntityType values', () => {
    expect(PRISMA_ENTITY_TYPES.length).toBe(entityTypeSchema.options.length);

  });

  it('every Zod EntityType option maps back to a Prisma value', () => {
    const prismaSet = new Set(PRISMA_ENTITY_TYPES as readonly string[]);
    for (const zodValue of entityTypeSchema.options) {
      expect(prismaSet.has(zodValue.toUpperCase())).toBe(true);
    }
  });
});

describe('DecisionReason consistency: Prisma ↔ Zod', () => {
  it('every Prisma DecisionReason has a matching Zod enum option', () => {
    const zodOptions = decisionReasonSchema.options;
    for (const prismaValue of PRISMA_DECISION_REASONS) {
      expect(zodOptions).toContain(prismaToTsValue(prismaValue));
    }
  });

  it('Prisma and Zod have the same number of DecisionReason values', () => {
    expect(PRISMA_DECISION_REASONS.length).toBe(
      decisionReasonSchema.options.length,
    );
  });

  it('every Zod DecisionReason option maps back to a Prisma value', () => {
    const prismaSet = new Set(PRISMA_DECISION_REASONS as readonly string[]);
    for (const zodValue of decisionReasonSchema.options) {
      expect(prismaSet.has(zodValue.toUpperCase())).toBe(true);
    }
  });
});
