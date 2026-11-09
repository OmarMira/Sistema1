// ─── Startup self-migrations (S2/S9) ─────────────────────────────────────────
// The installed system upgrades its own schema: on every Node.js server boot,
// pending Prisma migrations are applied automatically so the customer never has
// to run a migration by hand and the developer never has to touch each machine.
//
// Safety contract:
//   * only `prisma migrate deploy` runs — it applies pending migrations recorded
//     in `_prisma_migrations`, and never resets, drops or rewrites data;
//   * destructive commands (`migrate reset`, `db push --force-reset`, …) are
//     never issued by this module;
//   * this module never reads, prints or forwards `.env` values or credentials —
//     the Prisma CLI resolves its own connection from the inherited process
//     environment, and captured output is sanitized before it is logged;
//   * concurrent boots serialize through a lock file in RUNTIME_DIR, and the
//     losing boot skips once the winner has recorded success;
//   * at most one attempt sequence runs per process (memoized promise);
//   * a failure retries once, then logs a loud structured error and lets the
//     boot continue — operations that need missing tables still fail closed.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from '@/lib/config/paths';
import { logger } from '@/lib/logger';

/** Lock/state markers live beside the other runtime files, never in the worktree. */
const LOCK_FILE = path.join(RUNTIME_DIR, 'startup-migrations.lock');
const STATE_FILE = path.join(RUNTIME_DIR, 'startup-migrations.state.json');

/** A lock older than this is considered abandoned by a crashed boot. */
const LOCK_STALE_MS = 10 * 60_000;
/** How long a second boot waits for the boot that is already migrating. */
const LOCK_WAIT_TIMEOUT_MS = 3 * 60_000;
const LOCK_POLL_MS = 250;
/** Hard ceiling for a single `migrate deploy` invocation. */
const APPLY_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 2;

const PRISMA_CLI_RELATIVE = path.join('node_modules', 'prisma', 'build', 'index.js');

export type StartupMigrationStatus =
  | 'applied'
  | 'skipped-concurrent'
  | 'skipped-no-cli'
  | 'skipped-lock-timeout'
  | 'failed';

export interface StartupMigrationsResult {
  status: StartupMigrationStatus;
  attempts: number;
  durationMs: number;
}

interface PrismaInstallation {
  repoRoot: string;
  cliPath: string;
  schemaPath: string;
}

interface StartupMigrationState {
  status: 'applied' | 'failed';
  completedAt: number;
}

/** Strip anything connection-shaped before output reaches the logs. */
function sanitize(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/DATABASE_URL=\S+/gi, 'DATABASE_URL=[REDACTED]');
}

function tail(value: string, limit = 800): string {
  const sanitized = sanitize(value).trim();
  return sanitized.length > limit ? sanitized.slice(-limit) : sanitized;
}

function describeFailure(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object') {
    const failure = error as { message?: unknown; stdout?: unknown; stderr?: unknown; code?: unknown };
    return {
      message: tail(String(failure.message ?? 'unknown failure'), 300),
      code: typeof failure.code === 'string' || typeof failure.code === 'number' ? failure.code : undefined,
      stdout: typeof failure.stdout === 'string' ? tail(failure.stdout, 400) : undefined,
      stderr: typeof failure.stderr === 'string' ? tail(failure.stderr, 400) : undefined,
    };
  }
  return { message: tail(String(error), 300) };
}

/**
 * Locate the Prisma CLI and schema that ship with this installation.
 * Independent deployments (Next standalone, `next start`, `node server.js`)
 * start from different working directories, so the lookup walks up a few
 * ancestors instead of assuming `process.cwd() === repo root`.
 */
function resolvePrismaInstallation(): PrismaInstallation | null {
  const candidates: string[] = [];
  let current = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
    candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of candidates) {
    const cliPath = path.join(candidate, PRISMA_CLI_RELATIVE);
    const schemaPath = path.join(candidate, 'prisma', 'schema.prisma');
    try {
      if (fs.existsSync(cliPath) && fs.existsSync(schemaPath)) {
        return { repoRoot: candidate, cliPath, schemaPath };
      }
    } catch {
      // Unreadable candidate: keep looking, a packaged runtime may not have one.
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readState(): StartupMigrationState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<StartupMigrationState>;
    if ((parsed.status === 'applied' || parsed.status === 'failed') && typeof parsed.completedAt === 'number') {
      return { status: parsed.status, completedAt: parsed.completedAt };
    }
  } catch {
    // Missing or unreadable marker: treat as "no previous outcome known".
  }
  return null;
}

function writeState(status: StartupMigrationState['status']): void {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ status, completedAt: Date.now() }), 'utf8');
  } catch {
    // The marker only avoids a redundant pass for a waiting boot; the lock
    // alone still serializes boots, so failing to write it is not fatal.
  }
}

function isLockStale(): boolean {
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** `O_EXCL` creation: exactly one boot can win, everyone else waits. */
function tryAcquireLock(): boolean {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(handle);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!isLockStale()) return false;
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    // Leftover lock is reclaimed by the staleness check.
  }
}

/**
 * `prisma migrate deploy` through the local CLI entry point.
 * Deliberately narrow: no `reset`, no `db push`, no `--force-reset`.
 */
function runMigrateDeploy({ repoRoot, cliPath, schemaPath }: PrismaInstallation): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, 'migrate', 'deploy', '--schema', schemaPath],
      {
        cwd: repoRoot,
        timeout: APPLY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
          failure.stdout = String(stdout ?? '');
          failure.stderr = String(stderr ?? '');
          reject(failure);
          return;
        }
        resolve(`${String(stdout ?? '')}${String(stderr ?? '')}`);
      },
    );
  });
}

async function runStartupMigrations(): Promise<StartupMigrationsResult> {
  const startedAt = Date.now();
  const installation = resolvePrismaInstallation();

  if (!installation) {
    // Packaged runtime without the dev-dependency CLI: the installer already
    // created the schema (db:push), so boot must continue and stay visible.
    logger.error(
      '[STARTUP_MIGRATIONS] Prisma CLI not found under node_modules; automatic migrations were skipped. ' +
        'Fresh installs receive their schema from the installer (db push) and do not need this step.',
      { code: 'MIGRATIONS_SKIPPED_CLI_MISSING' },
    );
    return { status: 'skipped-no-cli', attempts: 0, durationMs: Date.now() - startedAt };
  }

  let waited = false;
  const waitStart = Date.now();

  while (!tryAcquireLock()) {
    waited = true;
    if (Date.now() - waitStart > LOCK_WAIT_TIMEOUT_MS) {
      logger.warn(
        '[STARTUP_MIGRATIONS] Another boot is still applying migrations; continuing boot without waiting further.',
        { code: 'MIGRATIONS_LOCK_TIMEOUT', waitedMs: Date.now() - waitStart },
      );
      return { status: 'skipped-lock-timeout', attempts: 0, durationMs: Date.now() - startedAt };
    }
    await delay(LOCK_POLL_MS);
  }

  try {
    if (waited) {
      const state = readState();
      if (state?.status === 'applied' && state.completedAt >= waitStart) {
        logger.info('[STARTUP_MIGRATIONS] A concurrent boot already applied pending migrations; skipping.', {
          code: 'MIGRATIONS_SKIPPED_CONCURRENT',
          durationMs: Date.now() - startedAt,
        });
        return { status: 'skipped-concurrent', attempts: 0, durationMs: Date.now() - startedAt };
      }
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const output = await runMigrateDeploy(installation);
        writeState('applied');
        logger.info('[STARTUP_MIGRATIONS] Pending Prisma migrations applied (non-destructive migrate deploy).', {
          code: 'MIGRATIONS_APPLIED',
          attempts: attempt,
          durationMs: Date.now() - startedAt,
          output: tail(output, 400),
        });
        return { status: 'applied', attempts: attempt, durationMs: Date.now() - startedAt };
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) {
          logger.warn('[STARTUP_MIGRATIONS] Applying pending migrations failed; retrying once.', {
            code: 'MIGRATIONS_APPLY_RETRY',
            attempt,
            error: describeFailure(error),
          });
        }
      }
    }

    writeState('failed');
    // Loud on purpose: the boot continues, but the operator must see that the
    // schema may be behind. Restore/read paths already fail closed on missing
    // tables, so this is never silently swallowed.
    logger.error(
      '[STARTUP_MIGRATIONS] Could not apply pending Prisma migrations after one retry. The server keeps booting; ' +
        'operations that require the missing tables fail closed. Check the database connection and reinstall or re-run the app installer.',
      { code: 'MIGRATIONS_APPLY_FAILED', attempts: MAX_ATTEMPTS, durationMs: Date.now() - startedAt, error: describeFailure(lastError) },
    );
    return { status: 'failed', attempts: MAX_ATTEMPTS, durationMs: Date.now() - startedAt };
  } finally {
    releaseLock();
  }
}

let startupMigrationsPromise: Promise<StartupMigrationsResult> | null = null;

/**
 * Apply pending Prisma migrations once per process.
 *
 * Never rejects: boot must continue even when the schema upgrade cannot run.
 */
export function ensureStartupMigrations(): Promise<StartupMigrationsResult> {
  if (!startupMigrationsPromise) {
    startupMigrationsPromise = runStartupMigrations().catch((error: unknown) => {
      logger.error(
        '[STARTUP_MIGRATIONS] Unexpected failure while preparing startup migrations; the server keeps booting.',
        { code: 'MIGRATIONS_APPLY_FAILED', error: describeFailure(error) },
      );
      return { status: 'failed' as const, attempts: 0, durationMs: 0 };
    });
  }
  return startupMigrationsPromise;
}
