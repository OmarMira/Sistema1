import { z } from 'zod';

// ───────────────────────────────────────────────
// Per-type metadata schemas
// ───────────────────────────────────────────────

export const personMetadataSchema = z.object({
  relationship: z.string().optional(),
  notes: z.string().optional(),
});

export const companyMetadataSchema = z.object({
  industry: z.string().optional(),
  taxId: z.string().optional(),
  notes: z.string().optional(),
});

export const financialProductMetadataSchema = z.object({
  productType: z.string(),
  issuer: z.string().optional(),
  accountType: z.string().optional(),
});

export const platformMetadataSchema = z.object({
  platformType: z.string(),
  url: z.string().url().optional(),
});

export const assetMetadataSchema = z.object({
  assetType: z.string(),
  estimatedValue: z.number().positive().optional(),
});

// ───────────────────────────────────────────────
// Discriminated union — validates metadata based on entity type
// 'platform' metadata MUST NOT accept 'assetType'.
// ───────────────────────────────────────────────

export const entityMetadataByType = {
  person: personMetadataSchema,
  company: companyMetadataSchema,
  financial_product: financialProductMetadataSchema,
  platform: platformMetadataSchema,
  asset: assetMetadataSchema,
} as const;
