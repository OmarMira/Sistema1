import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { parsePDF } from '@/lib/pdf-parser';
import { db } from '@/lib/db';
import { invalidateAllProfilesCache } from '@/lib/bank-profile-service';
import { BankProfileConfigSchema } from '@/lib/bank-profile-schema';
import { clearDatabase } from '../helpers/factories';

/**
 * Block 5 — PDF format learning loop certification.
 *
 * Proves causally that the product already implemented loop:
 *   unknown PDF -> createProfileFromPdf -> real BankProfile row
 *   -> second equivalent PDF -> persisted fingerprint match
 *   -> profile reuse -> NO second learning call.
 *
 * Only the external inference boundary (z-ai-web-dev-sdk) is substituted with
 * a deterministic response equivalent to a valid provider answer. Every other
 * link of the loop (pdf-parser, createProfileFromPdf, upsertBankProfile,
 * getAllActiveProfiles, fingerprint matching, runParseWithProfile, Prisma) is
 * the real product code running against the real test database.
 */

// ── External boundary: inference provider only ──────────────────────────────
const llmCreate = vi.hoisted(() => vi.fn());

vi.mock('z-ai-web-dev-sdk', () => ({
  default: {
    create: async () => ({
      chat: {
        completions: {
          create: (args: unknown) => llmCreate(args),
        },
      },
    }),
  },
}));

// ── Fixture ─────────────────────────────────────────────────────────────────
const FIXTURE_DIR = join(__dirname, '../fixtures/boa-statements');
const FIXTURE_NAME = 'eStmt_2025-03-31.pdf';

// Verified against the fixture's extracted text: each value is a contiguous
// substring of a single text item, so fingerprint matching is deterministic.
const EXPECTED_FINGERPRINTS = [
  'Bank of America, N.A.',
  'Business Advantage Relationship Banking',
];

// Deterministic provider-equivalent answer. The config mirrors the shape the
// product validates (BankProfileConfigSchema + regex validation) and is the
// layout that parses this fixture into a consistent statement.
const PROVIDER_RESPONSE = {
  bankName: 'Bank of America',
  fingerprints: EXPECTED_FINGERPRINTS,
  config: {
    layoutType: 'SINGLE_AMOUNT_COLUMN',
    lineGroupingTolerancePx: 5,
    numberFormat: {
      decimalSeparator: '.',
      thousandsSeparator: ',',
      negativeIndicator: 'MINUS_SIGN',
      negativePosition: 'PREFIX',
    },
    rules: {
      anchor: {
        regex: '^\\d{2}/\\d{2}/\\d{2}$',
        columnRange: [0.0, 0.18],
      },
      columns: {
        date: [0.0, 0.18],
        description: [0.12, 0.80],
        amount: [0.8, 1.0],
      },
      metadata: {
        accountNumber: [
          {
            regex:
              '(?:Account number|Account\\s*#|Account\\s*no\\.?|Account\\s*Number|Numero de cuenta):?\\s*([0-9\\s\\-]+)',
            captureGroup: 1,
          },
        ],
        initialBalance: [
          {
            regex:
              '(?:Beginning|Starting|Opening|Saldo\\s+inicial|Saldo\\s+anterior)\\s+(?:balance)?(?:\\s+on\\s+[^$]+)?\\s+\\$?([0-9,.-]+)',
            captureGroup: 1,
          },
          {
            regex: 'Beginning\\s+balance\\s+\\$?([0-9,.-]+)',
            captureGroup: 1,
          },
        ],
        finalBalance: [
          {
            regex:
              '(?:Ending|Closing|New|Saldo\\s+final|Nuevo\\s+saldo)\\s+(?:balance)?(?:\\s+on\\s+[^$]+)?\\s+\\$?([0-9,.-]+)',
            captureGroup: 1,
          },
          {
            regex: 'Ending\\s+balance\\s+\\$?([0-9,.-]+)',
            captureGroup: 1,
          },
        ],
      },
    },
  },
};

async function resetFormatState(): Promise<void> {
  await clearDatabase();
  // clearDatabase() does not cover BankProfile rows, and the format loop must
  // start from a provably empty format knowledge base.
  await db.bankProfile.deleteMany({});
  invalidateAllProfilesCache();
}

describe('Block 5 — PDF format learning loop', () => {
  beforeEach(async () => {
    await resetFormatState();
    llmCreate.mockReset();
    llmCreate.mockImplementation(async () => ({
      choices: [{ message: { content: JSON.stringify(PROVIDER_RESPONSE) } }],
    }));
  });

  afterEach(async () => {
    await resetFormatState();
  });

  it('learns once, persists the profile, and reuses it on the second import without relearning', async () => {
    const pdfBuffer = readFileSync(join(FIXTURE_DIR, FIXTURE_NAME));

    // ── Initial state: provably no usable format knowledge ──────────────────
    const initialProfiles = await db.bankProfile.findMany();
    expect(initialProfiles).toHaveLength(0);
    expect(llmCreate).toHaveBeenCalledTimes(0);

    // ── First occurrence ────────────────────────────────────────────────────
    const first = await parsePDF(pdfBuffer, { fileName: FIXTURE_NAME });

    expect(llmCreate).toHaveBeenCalledTimes(1);

    const firstProfiles = await db.bankProfile.findMany();
    expect(firstProfiles).toHaveLength(1);

    const learned = firstProfiles[0];
    expect(learned.bankId).toMatch(/^auto-[0-9a-f]{12}$/);
    expect(learned.bankName).toBe('Bank of America');
    expect(learned.isActive).toBe(true);
    expect(learned.fingerprints).toBe(JSON.stringify(EXPECTED_FINGERPRINTS));

    const learnedConfig = BankProfileConfigSchema.parse(JSON.parse(learned.config));
    expect(learnedConfig.layoutType).toBe('SINGLE_AMOUNT_COLUMN');
    expect(learnedConfig.rules.anchor.regex).toBe('^\\d{2}/\\d{2}/\\d{2}$');
    expect(learnedConfig.rules.anchor.columnRange).toEqual([0.0, 0.18]);
    expect(learnedConfig.rules.columns.date).toEqual([0.0, 0.18]);
    expect(learnedConfig.rules.columns.description).toEqual([0.12, 0.80]);
    expect(learnedConfig.rules.columns.amount).toEqual([0.8, 1.0]);
    expect(learnedConfig.numberFormat.negativePosition).toBe('PREFIX');
    expect(learnedConfig.numberFormat.decimalSeparator).toBe('.');

    expect(first.transactions.length).toBeGreaterThan(0);
    expect(first.mathValid).toBe(true);

    // Factual observation only — no behavioural requirement is imposed here.
    expect(typeof learned.requiresReview).toBe('boolean');
    // The onboarding failure warning is only pushed when the L862 block throws,
    // which is also the only path that would leave requiresReview untouched
    // after a successful math reconciliation.
    expect(first.warnings.join(' ')).not.toContain(
      'No se encontr\u00f3 un perfil bancario',
    );

    const firstProfileId = learned.id;
    const persistedRequiresReview = learned.requiresReview;

    // ── Second occurrence: same equivalent statement, no manual insertion ───
    const second = await parsePDF(pdfBuffer, { fileName: FIXTURE_NAME });

    // Load-bearing property: the learning boundary was not reached again.
    expect(llmCreate).toHaveBeenCalledTimes(1);

    const secondProfiles = await db.bankProfile.findMany();
    expect(secondProfiles).toHaveLength(1);
    expect(secondProfiles[0].id).toBe(firstProfileId);

    expect(second.transactions.length).toBeGreaterThan(0);
    expect(second.mathValid).toBe(true);

    // Evidence carrier for the report (never used as a normative requirement).
    expect(persistedRequiresReview).toBe(secondProfiles[0].requiresReview);
    expect(firstProfileId).toBe(secondProfiles[0].id);
  });
});
