if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import crypto from 'node:crypto';

/**
 * Cross-request lease for portable bootstrap recovery (blocker 3).
 *
 * The token CAS only protects one file: two different backup files could both
 * pass the "installation is empty" check and both start preparing/restoring.
 * This single-row lease serializes the whole workflow across processes, and the
 * shell-creation transaction additionally re-checks emptiness under a
 * transaction-scoped advisory lock. The lease carries an expiry so a crashed
 * process can never fence recovery forever; a holder only releases its own
 * lease.
 */
export interface RecoveryLockClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface RecoveryLockStore {
  acquire(input: { holder: string; now: Date; ttlMs: number }): Promise<boolean>;
  release(input: { holder: string; now: Date }): Promise<boolean>;
}

export const RECOVERY_LOCK_TTL_MS = 10 * 60_000;
const LOCK_SLOT = 'portable-bootstrap-recovery';

export interface RecoveryLockState {
  holder: string;
  expiresAt: Date;
}

export function createMemoryRecoveryLockStore(): RecoveryLockStore & {
  describe(): RecoveryLockState | null;
  expire(): void;
} {
  let state: RecoveryLockState | null = null;
  return {
    async acquire({ holder, now, ttlMs }) {
      if (state && state.expiresAt.getTime() > now.getTime() && state.holder !== holder) return false;
      state = { holder, expiresAt: new Date(now.getTime() + ttlMs) };
      return true;
    },
    async release({ holder }) {
      if (!state || state.holder !== holder) return false;
      state = null;
      return true;
    },
    describe() {
      return state ? { ...state } : null;
    },
    expire() {
      if (state) state = { ...state, expiresAt: new Date(0) };
    },
  };
}

/**
 * Durable lease. Constant SQL identifiers, every value bound. The CAS in
 * `ON CONFLICT ... WHERE` makes acquire atomic: exactly one concurrent caller
 * wins a free slot, an expired slot is reclaimable, and re-entering with the
 * same holder is idempotent.
 */
export function createPostgresRecoveryLockStore(client: RecoveryLockClient): RecoveryLockStore {
  return {
    async acquire({ holder, now, ttlMs }) {
      const expiresAt = new Date(now.getTime() + ttlMs);
      const rows = await client.$queryRawUnsafe<Array<{ holder: string }>>(
        `INSERT INTO "BootstrapRecoveryLock" (id, holder, "expiresAt") VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE
           SET holder = EXCLUDED.holder, "expiresAt" = EXCLUDED."expiresAt"
         WHERE "BootstrapRecoveryLock"."expiresAt" <= $4
            OR "BootstrapRecoveryLock".holder = EXCLUDED.holder
         RETURNING holder`,
        LOCK_SLOT, holder, expiresAt, now,
      );
      return Array.isArray(rows) && rows.length === 1;
    },
    async release({ holder }) {
      const rows = await client.$queryRawUnsafe<Array<{ holder: string }>>(
        `DELETE FROM "BootstrapRecoveryLock" WHERE id = $1 AND holder = $2 RETURNING holder`,
        LOCK_SLOT, holder,
      );
      return Array.isArray(rows) && rows.length === 1;
    },
  };
}

/** Opaque per-request lease holder: unrelated to users, files or tokens. */
export function createRecoveryLockHolder(): string {
  return crypto.randomUUID();
}
