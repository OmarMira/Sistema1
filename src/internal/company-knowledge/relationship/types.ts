import { z } from 'zod';

// ───────────────────────────────────────────────
// RelationshipValues — 9 approved values
// ───────────────────────────────────────────────

export const RelationshipValues = [
  'owner',
  'employee',
  'vendor',
  'customer',
  'tenant',
  'lender',
  'credit_card_provider',
  'related_company',
  'income_platform',
] as const;

export const relationshipSchema = z.enum(RelationshipValues);

export type Relationship = z.infer<typeof relationshipSchema>;
