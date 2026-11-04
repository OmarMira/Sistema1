import { Prisma, PrismaClient } from '@prisma/client';
import { trackQueryDuration } from './metrics';
import { logger } from './logger';
import { withRuntimeOperation } from './backup-runtime-maintenance';
import { toMoneyNumber } from './money';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  isListenerRegistered?: boolean;
};

// ─── Base client ─────────────────────────────────────────────────────────
// Create ONCE and cache. Event listeners must be registered on the BASE
// client before extending, because $extends wraps it.

function createBaseClient() {
  // ─── Test isolation guard ────────────────────────────────────────────────
  // Prevent tests from accidentally connecting to production/dev database.
  // This MUST run before PrismaClient reads DATABASE_URL.
  if (process.env.NODE_ENV === 'test') {
    const configuredDatabase =
      process.env.DATABASE_URL
        ? new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '')
        : null;

    if (configuredDatabase !== 'accountexpress_test' && configuredDatabase !== 'accountexpress_bootstraptest') {
      throw new Error(
        `[TEST SAFETY] Refusing to create PrismaClient — DATABASE_URL points to "${configuredDatabase ?? 'null'}" ` +
        `instead of "accountexpress_test". Tests MUST use the test database. Aborting.`
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
// G6/F6 closure: the blanket Decimal→Number conversion via
// $allModels.$allOperations was REMOVED (it silently converted every
// Prisma.Decimal in every result). The explicit per-field `result` overrides
// below are the ONLY conversion layer: each monetary field is deliberately
// exposed as `number` for API/UI consumers.
//
// Decimal-money boundary (S2): every compute below routes through
// `toMoneyNumber` from src/lib/money.ts — Decimal → exact integer cents →
// number. For valid Decimal(18,2) data this is bit-identical to the previous
// `Number(decimal)`, but a stored magnitude above Number.MAX_SAFE_INTEGER
// cents (9_007_199_254_740_991 = 2^53-1 ≈ ±$90.07 trillion) now throws a
// descriptive RangeError instead of drifting silently. Prisma materializes
// `compute` fields lazily, so the throw happens when a consumer reads a money
// field — or serializes the row (JSON.stringify) — rather than yielding a
// silently drifted value.
// Never replace these with `Number(...)` or `decimal.toNumber()`: ALL money
// arithmetic MUST go through src/lib/money.ts (see its module header).
//
// KNOWN BYPASS — aggregate()/groupBy() results do NOT flow through `result`
// overrides (Prisma applies extensions to model results only), so `_sum`,
// `_avg`, `_min`, `_max` still return Prisma.Decimal. Those call sites must
// normalize with the money module themselves; the current ones are:
//   - src/app/api/ai-assistant/route.ts            (bankTransaction _sum/_avg/_min/_max.amount)
//   - src/app/api/reconciliation/report/route.ts   (_sum.amount)
//   - src/lib/reconciliation.ts                    (_sum.amount)
//   - src/lib/assistant/insight-engine.ts          (groupBy _sum.debit/_sum.credit)
//   - src/lib/budget/engine.ts                     (groupBy _sum.debit/_sum.credit)
//   - src/lib/services/closing-engine.ts           (groupBy _sum.debit/_sum.credit)
//   - src/lib/services/journal-entry.service.ts    (aggregate _sum.debit/_sum.credit)
// Converting every one of them is the S3 follow-up task, not this layer.

const extended = base.$extends({
  result: {
    bankTransaction: {
      amount: {
        needs: { amount: true },
        compute(data) {
          return toMoneyNumber(data.amount);
        },
      },
    },
    glAccount: {
      balance: {
        needs: { balance: true },
        compute(data) {
          return toMoneyNumber(data.balance);
        },
      },
    },
    bankAccount: {
      balance: {
        needs: { balance: true },
        compute(data) {
          return toMoneyNumber(data.balance);
        },
      },
      initialBalance: {
        needs: { initialBalance: true },
        compute(data) {
          return toMoneyNumber(data.initialBalance);
        },
      },
    },
    bankStatement: {
      openingBalance: {
        needs: { openingBalance: true },
        compute(data) {
          return toMoneyNumber(data.openingBalance);
        },
      },
      closingBalance: {
        needs: { closingBalance: true },
        compute(data) {
          return toMoneyNumber(data.closingBalance);
        },
      },
      totalCredits: {
        needs: { totalCredits: true },
        compute(data) {
          return toMoneyNumber(data.totalCredits);
        },
      },
      totalDebits: {
        needs: { totalDebits: true },
        compute(data) {
          return toMoneyNumber(data.totalDebits);
        },
      },
    },
    reconciliationPeriod: {
      statementBalance: {
        needs: { statementBalance: true },
        compute(data) {
          return toMoneyNumber(data.statementBalance);
        },
      },
      bookBalance: {
        needs: { bookBalance: true },
        compute(data) {
          return toMoneyNumber(data.bookBalance);
        },
      },
      difference: {
        needs: { difference: true },
        compute(data) {
          return toMoneyNumber(data.difference);
        },
      },
    },
    journalLine: {
      debit: {
        needs: { debit: true },
        compute(data) {
          return toMoneyNumber(data.debit);
        },
      },
      credit: {
        needs: { credit: true },
        compute(data) {
          return toMoneyNumber(data.credit);
        },
      },
    },
  },
});

// Keep PrismaPromise construction lazy. Batch transactions receive the original
// promises (including Prisma's requestTransaction protocol), never native async
// wrappers. Admission surrounds execution, not promise construction.
const originals = new WeakMap<object, object>();
function guardedPromise(promise: unknown): object {
  if (!promise || typeof promise !== 'object') throw new TypeError('Expected PrismaPromise');
  const proxy = new Proxy(promise, {
    get(target, key, receiver) {
      if (key === 'then' || key === 'catch' || key === 'finally') {
        return (...args: unknown[]) => {
          const work = withRuntimeOperation(() => Promise.resolve(target));
          return Reflect.apply(Reflect.get(work, key), work, args);
        };
      }
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      // Fluent relation calls and transaction rebinding must stay guarded too.
      return (...args: unknown[]) => guardedPromise(Reflect.apply(value, target, args));
    },
  });
  originals.set(proxy, promise);
  return proxy;
}
function guardedClient(client: object): object {
  const delegates = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key === '$transaction') {
        return (input: unknown, ...options: unknown[]) => withRuntimeOperation(() => {
          const operation = typeof input === 'function'
            ? (tx: object) => Reflect.apply(input, undefined, [guardedClient(tx)])
            : Array.isArray(input) ? input.map(item => originals.get(item) ?? item) : input;
          return Reflect.apply(Reflect.get(target, key), target, [operation, ...options]);
        });
      }
      if (key === '$extends') return (...args: unknown[]) => guardedClient(Reflect.apply(Reflect.get(target, key), target, args));
      if (key === '$parent') {
        const parent = Reflect.get(target, key);
        return parent ? guardedClient(parent) : parent;
      }
      // Private engine handles are not part of the supported application client.
      if (typeof key === 'string' && key.startsWith('_')) return undefined;
      const value = Reflect.get(target, key);
      if (typeof value === 'function') {
        if (typeof key === 'string' && /^(\$queryRaw|\$executeRaw)/.test(key)) {
          return (...args: unknown[]) => guardedPromise(Reflect.apply(value, target, args));
        }
        // Native lifecycle methods need private engine state. Custom client
        // methods instead receive the guarded client, without changing their
        // synchronous or lazy PrismaPromise return values.
        const nativeLifecycle = key === '$connect' || key === '$disconnect' || key === '$on';
        return value.bind(nativeLifecycle ? target : receiver);
      }
      if (value && typeof value === 'object' && typeof key === 'string' && !key.startsWith('$')) {
        if (!delegates.has(key)) delegates.set(key, new Proxy(value, {
          get(delegate, operation) {
            const method = Reflect.get(delegate, operation);
            return typeof method === 'function'
              ? (...args: unknown[]) => guardedPromise(Reflect.apply(method, delegate, args))
              : method;
          },
        }));
        return delegates.get(key);
      }
      return value;
    },
  });
}

/** Internal company backup capability: raw Decimal results, never a raw client.
 * Admission encloses callback AND commit; escaped transaction operations remain
 * guarded. Ordinary application promises/extensions are deliberately unchanged.
 */
export function withCompanyBackupTransaction<T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  return withRuntimeOperation(() => base.$transaction(
    tx => callback(guardedClient(tx) as Prisma.TransactionClient), options,
  ));
}

export const db = guardedClient(extended) as typeof extended;
export type ExtendedPrismaClient = typeof db;
