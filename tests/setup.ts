// Safeguard: Force DATABASE_URL to use a test database so we never wipe dev.db
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('dev.db')) {
  process.env.DATABASE_URL = 'file:./test.db';
}

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'path';
import { pathToFileURL } from 'url';
import { execSync } from 'child_process';

// Configure PDF.js worker for Node/Bun environment
const workerPath = pathToFileURL(
  path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;
pdfjs.GlobalWorkerOptions.workerSrc = workerPath;

// Mock the Z AI SDK globally in testing
import { vi, beforeAll } from 'vitest';
vi.mock('z-ai-web-dev-sdk', () => {
  return {
    default: {
      create: async () => {
        return {
          chat: {
            completions: {
              create: async () => {
                return {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          bankName: 'Mock Bank',
                          fingerprints: ['Mock Fingerprint'],
                          config: {
                            layoutType: 'SINGLE_AMOUNT_COLUMN',
                            lineGroupingTolerancePx: 5,
                            numberFormat: {
                              decimalSeparator: '.',
                              thousandsSeparator: ',',
                              negativeIndicator: 'MINUS_SIGN',
                              negativePosition: 'PREFIX'
                            },
                            rules: {
                              anchor: {
                                regex: '^\\d{2}/\\d{2}/\\d{2}$',
                                columnRange: [0.0, 0.18]
                              },
                              columns: {
                                date: [0.0, 0.18],
                                description: [0.18, 0.80],
                                amount: [0.80, 1.00]
                              },
                              metadata: {
                                accountNumber: [],
                                initialBalance: [],
                                finalBalance: []
                              }
                            }
                          }
                        })
                      }
                    }
                  ]
                };
              }
            }
          }
        };
      }
    }
  };
});

// Ensure Prisma client is regenerated before tests run (in case pre-test script was skipped)
try {
  execSync('bun x prisma generate', { stdio: 'ignore' });
} catch (e) {
  console.warn('⚠️ Prisma generate failed in test setup, assuming it was run already.');
}

// Invalidate critical module caches to avoid stale Prisma client instances
const modulesToClear = ['@prisma/client', '@/lib/db'];
modulesToClear.forEach((mod) => {
  try {
    const resolved = require.resolve(mod);
    delete require.cache[resolved];
  } catch (_) {
    // Module not loaded yet, ignore
  }
});

import { db } from '@/lib/db';
import { BankProfileConfigSchema } from '@/lib/bank-profile-schema';
import boaProfile from '@/lib/bank-profiles/boa-standard.json';

beforeAll(async () => {
  const profilesToSeed = [
    {
      bankId: boaProfile.bankId,
      bankName: boaProfile.bankName,
      fingerprints: boaProfile.fingerprints,
      config: {
        layoutType: boaProfile.layoutType,
        lineGroupingTolerancePx: boaProfile.lineGroupingTolerancePx,
        numberFormat: boaProfile.numberFormat,
        rules: boaProfile.rules,
      },
    },
  ];

  for (const item of profilesToSeed) {
    const validation = BankProfileConfigSchema.safeParse(item.config);
    if (validation.success) {
      await db.bankProfile.upsert({
        where: { bankId: item.bankId },
        create: {
          bankId: item.bankId,
          bankName: item.bankName,
          fingerprints: JSON.stringify(item.fingerprints),
          config: JSON.stringify(validation.data),
          isActive: true,
        },
        update: {
          bankName: item.bankName,
          fingerprints: JSON.stringify(item.fingerprints),
          config: JSON.stringify(validation.data),
        },
      });
    }
  }
});
