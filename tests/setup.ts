// SAFEGUARD: Always force a test database when running vitest.
// Never allow tests to touch the real PostgreSQL/dev database.
if (!process.env.DATABASE_URL?.includes('test')) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgrespassword@localhost:5432/accountexpress_test?schema=public';
}

// DOUBLE CHECK: If DATABASE_URL was overridden but still points to production, abort.
const _dbUrl = process.env.DATABASE_URL ?? '';
if (_dbUrl.includes('accountexpress') && !_dbUrl.includes('test')) {
  throw new Error(
    `[TEST SAFETY] DATABASE_URL points to production database! ` +
    `Value: ${_dbUrl.slice(0, 60)}... — Tests MUST use a test database. Aborting.`
  );
}

// A published backup is sealed at rest (AES-256-GCM, PBKDF2-SHA256 over
// SESSION_SECRET) and the publisher fails closed without a secret. Vitest does not
// read the ambient .env, so the suite provides a deterministic default. Tests that
// need a specific secret — or its absence — still set or delete it themselves.
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'test-session-secret-not-for-production';
}

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'path';
import { pathToFileURL } from 'url';

// ── Network barrier: every real fetch() must be mocked ──────────────
// Uses direct assignment (not vi.stubGlobal) so vi.unstubAllGlobals()
// in individual test files cannot permanently remove it.
const BARRIER_FETCH: typeof globalThis.fetch = (input) => {
  const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
  const stack = new Error().stack?.split('\n').slice(2).join('\n') ?? '(no stack)';
  const msg = [
    `[NETWORK BARRIER] fetch() llamado durante tests sin mock.`,
    `  URL: ${url}`,
    `  Callsite:`,
    stack,
  ].join('\n');
  console.error(msg);
  throw new Error(msg);
};
globalThis.fetch = BARRIER_FETCH;
beforeEach(() => {
  globalThis.fetch = BARRIER_FETCH;
});

// Configure PDF.js worker for Node/Bun environment
const workerPath = pathToFileURL(
  path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;
pdfjs.GlobalWorkerOptions.workerSrc = workerPath;

// Mock the Z AI SDK globally in testing
import { vi, beforeEach } from 'vitest';
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

// Invalidate critical module caches to avoid stale Prisma client instances
// Database schema and global bank-profile fixtures are prepared once by
// global-setup.ts, outside per-file mocks of @/lib/db and @prisma/client.
