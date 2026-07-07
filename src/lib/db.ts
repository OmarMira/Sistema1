import { Prisma, PrismaClient } from '@prisma/client';
import { trackQueryDuration } from './metrics';
import { logger } from './logger';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  isListenerRegistered?: boolean;
};

// ─── Base client ─────────────────────────────────────────────────────────
// Create ONCE and cache. Event listeners must be registered on the BASE
// client before extending, because $extends wraps it.

function createBaseClient() {
  return new PrismaClient({
    log: [
      { level: 'query', emit: 'event' },
      { level: 'warn', emit: 'stdout' },
      { level: 'error', emit: 'stdout' },
    ],
  });
}

// ─── Safety-net helper ────────────────────────────────────────────────────
// Catches any Prisma.Decimal value that the result override misses
// (e.g. raw queries, groupBy aggregates, newly added fields).
function deepConvertDecimals(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) {
    return value.toNumber();
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepConvertDecimals);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    obj[key] = deepConvertDecimals(obj[key]) as never;
  }
  return obj;
}

const base: PrismaClient = globalForPrisma.prisma ?? createBaseClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = base;
}

const isEdge = process.env.NEXT_RUNTIME === 'edge';

// Register event listeners on the BASE client (they are NOT available on the
// extended wrapper in Prisma v6).
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
          import('./alerts')
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

// ─── Single $extends call ──────────────────────────────────────────────────
// In Prisma v6, $use was REMOVED. Middleware must be done via
// $extends({ query: { ... } }). We combine the Decimal safety-net (query
// middleware) AND the result-type overrides in ONE extension to keep a single
// wrapper layer.

export const db = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        const result = await query(args);
        return deepConvertDecimals(result);
      },
    },
  },
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
