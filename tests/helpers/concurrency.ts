import { PrismaClient, Prisma, type TransactionClient } from '@prisma/client';

/**
 * Builds the PostgreSQL connection URL used for CONCURRENCY-CONTROLLED test
 * clients. This MUST point at the test database and MUST set
 * connection_limit=1 so each independent client opens exactly one connection.
 *
 * Safety checks (mirror tests/setup.ts + src/lib/db.ts):
 *  - NODE_ENV must be 'test'
 *  - database name must be exactly `accountexpress_test`
 *  - `schema=public` is preserved
 *  - `connection_limit=1` is appended without altering other parameters
 */
function buildTestConnectionUrl(): string {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `[CONCURRENCY HELPER] Refusing to build a limited datasource outside tests. ` +
      `NODE_ENV=${process.env.NODE_ENV ?? '(unset)'} — must be 'test'.`,
    );
  }

  const raw = process.env.DATABASE_URL ?? '';
  if (!raw) {
    throw new Error('[CONCURRENCY HELPER] DATABASE_URL is not set.');
  }

  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, '');
  if (dbName !== 'accountexpress_test') {
    throw new Error(
      `[CONCURRENCY HELPER] DATABASE_URL does NOT point at accountexpress_test ` +
      `(got "${dbName}"). Refusing to build concurrency clients.`,
    );
  }

  url.searchParams.set('schema', 'public');
  url.searchParams.set('connection_limit', '1');
  return url.toString();
}

function createControlledClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: buildTestConnectionUrl() });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ConcurrentRaceResult {
  resultA: unknown;
  resultB: unknown;
  pidA: number;
  pidB: number;
  blockerPid: number;
}

export interface ConcurrentRaceOptions {
  /** The single disputed BankTransaction row every operation races over. */
  transactionId: string;
  /** Timeout for the observer to confirm BOTH operations are waiting on the blocker. */
  timeoutMs?: number;
}

/**
 * Runs operation A and operation B against the SAME row under a deterministically
 * controlled lock race, using four independent single-connection clients:
 *   - blocker  : holds `SELECT ... FOR UPDATE` on the row until released
 *   - observer : watches pg_stat_activity / pg_blocking_pids
 *   - A, B     : each run their operation inside its own transaction
 *
 * Release of the blocker only happens after the observer confirms BOTH A and B
 * are waiting with wait_event_type='Lock' and both are blocked by the blocker.
 */
export async function orchestrateConcurrentRace(
  operationA: (tx: TransactionClient, pid: number) => Promise<unknown>,
  operationB: (tx: TransactionClient, pid: number) => Promise<unknown>,
  options: ConcurrentRaceOptions,
): Promise<ConcurrentRaceResult> {
  const { transactionId, timeoutMs = 5000 } = options;

  const blocker = createControlledClient();
  const observer = createControlledClient();
  const clientA = createControlledClient();
  const clientB = createControlledClient();

  // ── DSL: deferred signals ──────────────────────────────────────────
  let resolveBlockerPid!: (pid: number) => void;
  let resolveLock!: () => void;
  let resolvePidA!: (pid: number) => void;
  let resolvePidB!: (pid: number) => void;
  let resolveRelease!: () => void;

  const blockerPidReady = new Promise<number>((r) => (resolveBlockerPid = r));
  const rowLockAcquired = new Promise<void>((r) => (resolveLock = r));
  const pidAReady = new Promise<number>((r) => (resolvePidA = r));
  const pidBReady = new Promise<number>((r) => (resolvePidB = r));

  let released = false;
  const releaseBlocker = () => {
    if (!released) {
      released = true;
      resolveRelease();
    }
  };

  try {
    // 1. Blocker: ask its pid, lock the row, hold until released.
    const blockerTx = blocker.$transaction(
      async (b) => {
        const [row] = await b.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        resolveBlockerPid(Number(row.pid));
        await b.$queryRaw(
          Prisma.sql`SELECT id FROM "BankTransaction" WHERE id = ${transactionId} FOR UPDATE`,
        );
        resolveLock();
        await new Promise<void>((r) => (resolveRelease = r));
      },
      { timeout: 30000 },
    );

    await blockerPidReady;
    await rowLockAcquired;

    // 2. Launch A and B only AFTER the blocker holds the row.
    const runA = clientA.$transaction(
      async (ta) => {
        const [row] = await ta.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        const pid = Number(row.pid);
        resolvePidA(pid);
        return operationA(ta, pid);
      },
      { timeout: 30000 },
    );

    const runB = clientB.$transaction(
      async (tb) => {
        const [row] = await tb.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        const pid = Number(row.pid);
        resolvePidB(pid);
        return operationB(tb, pid);
      },
      { timeout: 30000 },
    );

    // Propagate a pre-pid A/B failure instead of hanging on pid readiness.
    const pidOrThrow = async (ready: Promise<number>, run: Promise<unknown>): Promise<number> =>
      new Promise<number>((res, rej) => {
        ready.then(res, rej);
        run.catch(rej);
      });

    const [pidA, pidB, blockerPid] = await Promise.all([
      pidOrThrow(pidAReady, runA),
      pidOrThrow(pidBReady, runB),
      blockerPidReady,
    ]);

    // 3. Observe: both A and B must be Lock-waiting AND their blocking chain
    //    must reach the blocker. PostgreSQL's EvalPlanQual forms a chain:
    //    op2 ->(tuple) op1 ->(transactionid) blocker, so a direct
    //    pg_blocking_pids containment check is NOT reliable — we chase the
    //    transitive blocking chain to the blocker instead.
    const chainReachesBlocker = async (
      targetPid: number,
      blockerPidRef: number,
      depth = 0,
    ): Promise<boolean> => {
      if (targetPid === blockerPidRef) return true;
      if (depth > 8) return false;
      const blockers = await observer.$queryRaw<Array<{ b: number }>>(
        Prisma.sql`SELECT unnest(pg_blocking_pids(${targetPid}::int)) AS b`,
      );
      for (const { b } of blockers) {
        if (await chainReachesBlocker(Number(b), blockerPidRef, depth + 1)) return true;
      }
      return false;
    };

    let reached = false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [state] = await observer.$queryRaw<
        Array<{ wea: string | null; web: string | null; aReach: boolean; bReach: boolean }>
      >(Prisma.sql`
        SELECT
          (SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pidA}) AS wea,
          (SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pidB}) AS web
      `);
      const aReach = await chainReachesBlocker(pidA, blockerPid);
      const bReach = await chainReachesBlocker(pidB, blockerPid);
      if (state.wea === 'Lock' && state.web === 'Lock' && aReach && bReach) {
        reached = true;
        break;
      }
      await sleep(50);
    }

    if (!reached) {
      const diag = await observer.$queryRaw(Prisma.sql`
        SELECT pid, state, wait_event_type, wait_event, query
        FROM pg_stat_activity
        WHERE pid = ANY(ARRAY[${pidA}::int, ${pidB}::int, ${blockerPid}::int])
      `);
      releaseBlocker(); // MUST release or disconnect hangs
      throw new Error(
        `[CONCURRENCY HELPER] Both operations were not observed waiting on the blocker ` +
        `within ${timeoutMs}ms. pg_stat_activity: ${JSON.stringify(diag)}`,
      );
    }

    // 4. Release the blocker → both operations contend for the row.
    releaseBlocker();
    const [resultA, resultB] = await Promise.all([runA, runB, blockerTx]);

    return { resultA, resultB, pidA, pidB, blockerPid };
  } finally {
    releaseBlocker(); // idempotent — never leave the blocker hanging
    await Promise.allSettled([
      blocker.$disconnect(),
      observer.$disconnect(),
      clientA.$disconnect(),
      clientB.$disconnect(),
    ]);
  }
}