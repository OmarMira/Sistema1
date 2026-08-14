import { Prisma, PrismaClient } from '@prisma/client';
import { trackQueryDuration } from '../../src/lib/metrics';
import { logger } from '../../src/lib/logger';

// Bootstrap-restore isolated-database twin of src/lib/db.ts.
// Only used by the F-9 PoC via the vitest.forensic-f9.config.ts alias, so the
// bootstrap/restore route handlers write to accountexpress_bootstraptest.

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  isListenerRegistered?: boolean;
};

function createBaseClient() {
  // ─── Test isolation guard (bootstrap twin) ──────────────────────────────
  // Accept the dedicated bootstrap-test database so the F-9 PoC can run on a
  // genuinely empty DB without touching accountexpress_test.
  if (process.env.NODE_ENV === 'test') {
    const configuredDatabase =
      process.env.DATABASE_URL
        ? new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '')
        : null;

    if (configuredDatabase !== 'accountexpress_bootstraptest') {
      throw new Error(
        `[TEST SAFETY] Refusing to create PrismaClient — DATABASE_URL points to "${configuredDatabase ?? 'null'}" ` +
        `instead of "accountexpress_bootstraptest". F-9 PoC MUST use the isolated bootstrap database. Aborting.`
      );
    }
  }

  return new PrismaClient({
    log: [
      { level: 'query', emit: 'event' },
      { level: 'warn', emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
  });
}

const base: PrismaClient = globalForPrisma.prisma ?? createBaseClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = base;
}

const isEdge = process.env.NEXT_RUNTIME === 'edge';

if (!globalForPrisma.isListenerRegistered) {
  if (!isEdge) {
    (base as PrismaClient & { $on(event: string, cb: (e: unknown) => void): void }).$on(
      'query',
      (e: unknown) => {
        const ev = e as Prisma.QueryEvent;
        const duration = ev.duration;
        const query = ev.query;

        trackQueryDuration(query, duration);

        if (duration > 100) {
          logger.slowQuery(query, duration);
        }

        if (duration > 500) {
          import('../../src/lib/alerts')
            .then(({ alertIfSlowQuery }) => {
              alertIfSlowQuery(duration, query);
            })
            .catch(() => {});
        }
      },
    );
  }

  globalForPrisma.isListenerRegistered = true;
}

export const db = base.$extends({
  result: {
    bankTransaction: {
      amount: {
        needs: { amount: true },
        compute(data) {
          return Number(data.amount);
        },
      },
    },
    glAccount: {
      balance: {
        needs: { balance: true },
        compute(data) {
          return Number(data.balance);
        },
      },
    },
    bankAccount: {
      balance: {
        needs: { balance: true },
        compute(data) {
          return Number(data.balance);
        },
      },
      initialBalance: {
        needs: { initialBalance: true },
        compute(data) {
          return Number(data.initialBalance);
        },
      },
    },
    bankStatement: {
      openingBalance: {
        needs: { openingBalance: true },
        compute(data) {
          return Number(data.openingBalance);
        },
      },
      closingBalance: {
        needs: { closingBalance: true },
        compute(data) {
          return Number(data.closingBalance);
        },
      },
      totalCredits: {
        needs: { totalCredits: true },
        compute(data) {
          return Number(data.totalCredits);
        },
      },
      totalDebits: {
        needs: { totalDebits: true },
        compute(data) {
          return Number(data.totalDebits);
        },
      },
    },
    reconciliationPeriod: {
      statementBalance: {
        needs: { statementBalance: true },
        compute(data) {
          return Number(data.statementBalance);
        },
      },
      bookBalance: {
        needs: { bookBalance: true },
        compute(data) {
          return Number(data.bookBalance);
        },
      },
      difference: {
        needs: { difference: true },
        compute(data) {
          return Number(data.difference);
        },
      },
    },
    journalLine: {
      debit: {
        needs: { debit: true },
        compute(data) {
          return Number(data.debit);
        },
      },
      credit: {
        needs: { credit: true },
        compute(data) {
          return Number(data.credit);
        },
      },
    },
  },
});

export type ExtendedPrismaClient = typeof db;
