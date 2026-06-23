import { z } from 'zod';

export const BankProfileConfigSchema = z
  .object({
    layoutType: z.enum(['SINGLE_AMOUNT_COLUMN', 'DUAL_AMOUNT_COLUMN']),
    lineGroupingTolerancePx: z.number().min(1).max(20),
    numberFormat: z.object({
      decimalSeparator: z
        .string()
        .length(1, 'El separador decimal debe ser exactamente 1 carácter'),
      thousandsSeparator: z
        .string()
        .length(1, 'El separador de miles debe ser exactamente 1 carácter'),
      negativeIndicator: z.string().optional(),
      negativePosition: z.enum(['PREFIX', 'SUFFIX', 'PARENTHESES', 'TEXT_SUFFIX']),
    }),
    rules: z.object({
      anchor: z.object({
        regex: z.string(),
        columnRange: z
          .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
          .refine(([a, b]) => a < b, { message: 'El inicio debe ser menor que el fin' }),
      }),
      columns: z.object({
        date: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
        description: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
        amount: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
        debit: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
        credit: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
      }),
      metadata: z.object({
        accountNumber: z.array(
          z.object({
            regex: z.string(),
            captureGroup: z.number(),
          }),
        ),
        initialBalance: z.array(
          z.object({
            regex: z.string(),
            captureGroup: z.number(),
          }),
        ),
        finalBalance: z.array(
          z.object({
            regex: z.string(),
            captureGroup: z.number(),
          }),
        ),
      }),
      stopSectionRegex: z.string().optional(),
      continuationMarkers: z.array(z.string()).optional(),
      sectionContinuationRegex: z.string().optional(),
      totalLinePatterns: z.array(z.string()).optional(),
    }),
  })
  .refine(
    (data) => {
      if (data.layoutType === 'SINGLE_AMOUNT_COLUMN') {
        return !!data.rules.columns.amount;
      } else {
        return !!data.rules.columns.debit && !!data.rules.columns.credit;
      }
    },
    {
      message:
        "SINGLE_AMOUNT_COLUMN requiere definir 'amount'; DUAL_AMOUNT_COLUMN requiere definir 'debit' y 'credit'",
      path: ['rules', 'columns'],
    },
  );

export type BankProfileConfig = z.infer<typeof BankProfileConfigSchema>;

export interface BankProfileTyped {
  id: string;
  bankId: string;
  bankName: string;
  fingerprints: string[];
  isActive: boolean;
  requiresReview: boolean;
  config: BankProfileConfig;
  createdAt: Date;
  updatedAt: Date;
}
