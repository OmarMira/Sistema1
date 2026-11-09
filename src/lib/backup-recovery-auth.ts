if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import crypto from 'node:crypto';
import { parseSnapshot } from './backup-format';
import {
  PORTABLE_LIMITS, PortableRecoveryError, companyNameMatches, normalizeOwnerEmail, openPortableContainer,
  portableFileDigest, portableThrottleDigest, validatePortableRecoveryCredential,
  type PortableSourceOwnerCredential,
} from './backup-portable';
import { createRecoveryToken, tokenDigest } from './identity/crypto';
import { deliverRecoveryToken } from './backup-recovery-mail';
import { RECOVERY_LOCK_TTL_MS, createRecoveryLockHolder, type RecoveryLockStore } from './backup-recovery-lock';
import type { IdentityMailTransport } from './identity/mail';
import type { PortableRestoreRequest, PortableRestoreResult } from './backup-recovery-provenance';

/**
 * Application-level authorization for portable bootstrap recovery (S3).
 *
 * Two-stage and fail closed:
 *  1. `request` validates the encrypted container header, charges the bounded
 *     attempt budget, opens the identity-bound KDF with the owner password AND
 *     the owner email AND the company legal name (all three are supplied by the
 *     caller; the password alone can never open a portable file), confirms the
 *     company name, proves the SOURCE owner from the sealed credential and
 *     emails a single-use token to that owner address. The installation is not
 *     mutated, and no destination account has to exist first.
 *  2. `complete` repeats every check, consumes the token atomically, and only
 *     then starts the restore. A consumed token is never re-armed, so a failed,
 *     refused or uncertain restore requires a brand new challenge.
 *
 * Both stages hold the cross-request recovery lease, so two different backup
 * files can never prepare/restore concurrently.
 */
export const RECOVERY_POLICY = Object.freeze({
  /** Window in which a delivered token stays usable. */
  tokenMs: 15 * 60_000,
  /**
   * Password attempts allowed per wrapping-key subject (see
   * `portableThrottleDigest`) and window.
   */
  attempts: 5,
  /** Sliding budget window for password attempts. */
  windowMs: 10 * 60_000,
  tokenPattern: /^[a-f0-9]{64}$/,
  lockTtlMs: RECOVERY_LOCK_TTL_MS,
});

export { createRecoveryToken, tokenDigest as recoveryTokenDigest };

export type RecoveryChallengeState = 'ok' | 'absent' | 'expired' | 'used' | 'mismatch';
export type RecoveryEventAction =
  | 'challenge_issued'
  | 'challenge_rejected'
  | 'challenge_delivery_failed'
  | 'challenge_consumed'
  | 'restore_committed'
  | 'restore_failed';

export interface RecoveryChallengeRecord {
  fileDigest: string;
  ownerUserId: string;
  companyId: string;
  tokenDigest: string;
  generation: number;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface RecoveryChallengeStore {
  /**
   * Bounded password-attempt budget. `fileDigest` is the CANONICAL throttle
   * subject of the uploaded file (`portableThrottleDigest`): the Wrapping-Key
   * inputs, so reformatting the file or mutating bytes that never reach the
   * wrapping key cannot reset the budget (F2).
   */
  admitPasswordAttempt(input: { fileDigest: string; now: Date }): Promise<boolean>;
  /** Rotation: installing a new draft makes every older token unusable. */
  issue(input: {
    fileDigest: string;
    ownerUserId: string;
    companyId: string;
    tokenDigest: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;
  /** True only while this exact token is still the current, unused draft. */
  isCurrent(input: { fileDigest: string; tokenDigest: string; now: Date }): Promise<boolean>;
  /** Atomic single use, bound to file digest + owner + token. */
  consume(input: {
    fileDigest: string;
    ownerUserId: string;
    tokenDigest: string;
    now: Date;
  }): Promise<RecoveryChallengeState>;
  recordEvent(action: RecoveryEventAction, subject: string, now: Date): Promise<void>;
}

export interface RecoveryMemoryStore extends RecoveryChallengeStore {
  describe(): {
    challenges: RecoveryChallengeRecord[];
    attemptsUsed: number;
    events: Array<{ action: RecoveryEventAction; subject: string }>;
  };
}

function windowStart(now: Date): number {
  return Math.floor(now.getTime() / RECOVERY_POLICY.windowMs) * RECOVERY_POLICY.windowMs;
}

/** Deterministic in-memory store: used by tests and by no production path. */
export function createMemoryRecoveryChallengeStore(): RecoveryMemoryStore {
  const challenges = new Map<string, RecoveryChallengeRecord>();
  const attempts = new Map<string, number>();
  const events: Array<{ action: RecoveryEventAction; subject: string }> = [];
  return {
    async admitPasswordAttempt({ fileDigest, now }) {
      const key = `${fileDigest}:${windowStart(now)}`;
      const used = attempts.get(key) ?? 0;
      if (used >= RECOVERY_POLICY.attempts) return false;
      attempts.set(key, used + 1);
      return true;
    },
    async issue(input) {
      const previous = challenges.get(input.fileDigest);
      challenges.set(input.fileDigest, {
        fileDigest: input.fileDigest,
        ownerUserId: input.ownerUserId,
        companyId: input.companyId,
        tokenDigest: input.tokenDigest,
        generation: (previous?.generation ?? 0) + 1,
        attempts: 0,
        expiresAt: input.expiresAt,
        usedAt: null,
        createdAt: input.now,
      });
    },
    async isCurrent({ fileDigest, tokenDigest: digest, now }) {
      const record = challenges.get(fileDigest);
      if (!record || record.usedAt || record.tokenDigest !== digest) return false;
      return record.expiresAt.getTime() > now.getTime();
    },
    async consume(input) {
      const record = challenges.get(input.fileDigest);
      if (!record) return 'absent';
      if (record.ownerUserId !== input.ownerUserId || record.tokenDigest !== input.tokenDigest) return 'mismatch';
      if (record.usedAt) return 'used';
      if (record.expiresAt.getTime() <= input.now.getTime()) return 'expired';
      record.usedAt = input.now;
      return 'ok';
    },
    async recordEvent(action, subject) {
      events.push({ action, subject });
    },
    describe() {
      return {
        challenges: [...challenges.values()].map((record) => ({ ...record })),
        attemptsUsed: [...attempts.values()].reduce((total, value) => total + value, 0),
        events: [...events],
      };
    },
  };
}

export interface RecoveryRawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface ChallengeRow {
  fileDigest: string;
  ownerUserId: string;
  companyId: string;
  tokenDigest: string;
  generation: number;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

/**
 * Durable store. Constant SQL identifiers, bound values. Single use is an
 * atomic CAS UPDATE, so concurrent callers can never both win and `usedAt` is
 * never cleared afterwards.
 */
export function createPostgresRecoveryChallengeStore(client: RecoveryRawClient): RecoveryChallengeStore {
  return {
    async admitPasswordAttempt({ fileDigest, now }) {
      const subject = `bootstrap-recovery:${fileDigest}`;
      const start = new Date(windowStart(now));
      const rows = await client.$queryRawUnsafe<Array<{ attempts: number }>>(
        `INSERT INTO "IdentityRateLimit" (subject,"windowStart",attempts,"expiresAt")
         VALUES ($1,$2,1,$3)
         ON CONFLICT (subject,"windowStart") DO UPDATE SET attempts="IdentityRateLimit".attempts+1
         WHERE "IdentityRateLimit".attempts < $4
         RETURNING attempts`,
        subject, start, new Date(start.getTime() + RECOVERY_POLICY.windowMs), RECOVERY_POLICY.attempts,
      );
      return Array.isArray(rows) && rows.length === 1;
    },
    async issue(input) {
      await client.$executeRawUnsafe(
        `INSERT INTO "BootstrapRecoveryChallenge"
           ("fileDigest","ownerUserId","companyId","tokenDigest",generation,attempts,"expiresAt","usedAt","createdAt")
         VALUES ($1,$2,$3,$4,1,0,$5,NULL,$6)
         ON CONFLICT ("fileDigest") DO UPDATE
         SET "tokenDigest"=EXCLUDED."tokenDigest", "ownerUserId"=EXCLUDED."ownerUserId",
             "companyId"=EXCLUDED."companyId", generation="BootstrapRecoveryChallenge".generation+1,
             attempts=0, "expiresAt"=EXCLUDED."expiresAt", "usedAt"=NULL`,
        input.fileDigest, input.ownerUserId, input.companyId, input.tokenDigest, input.expiresAt, input.now,
      );
    },
    async isCurrent({ fileDigest, tokenDigest: digest, now }) {
      const rows = await client.$queryRawUnsafe<Array<{ tokenDigest: string }>>(
        `SELECT "tokenDigest" FROM "BootstrapRecoveryChallenge"
         WHERE "fileDigest"=$1 AND "tokenDigest"=$2 AND "usedAt" IS NULL AND "expiresAt" > $3`,
        fileDigest, digest, now,
      );
      return Array.isArray(rows) && rows.length === 1;
    },
    async consume(input) {
      const claimed = await client.$queryRawUnsafe<Array<{ generation: number }>>(
        `UPDATE "BootstrapRecoveryChallenge" SET "usedAt"=$4
         WHERE "fileDigest"=$1 AND "ownerUserId"=$2 AND "tokenDigest"=$3
           AND "usedAt" IS NULL AND "expiresAt" > $4
         RETURNING generation`,
        input.fileDigest, input.ownerUserId, input.tokenDigest, input.now,
      );
      if (Array.isArray(claimed) && claimed.length === 1) return 'ok';
      const rows = await client.$queryRawUnsafe<ChallengeRow[]>(
        `SELECT "fileDigest","ownerUserId","companyId","tokenDigest",generation,attempts,
                "expiresAt","usedAt","createdAt"
         FROM "BootstrapRecoveryChallenge" WHERE "fileDigest"=$1`,
        input.fileDigest,
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) return 'absent';
      if (row.ownerUserId !== input.ownerUserId || row.tokenDigest !== input.tokenDigest) return 'mismatch';
      if (row.usedAt) return 'used';
      return 'expired';
    },
    async recordEvent(action, subject, now) {
      await client.$executeRawUnsafe(
        // IdentitySecurityEvent.id is a uuid column: randomUUID() returns text,
        // so the parameter needs the same explicit ::uuid cast the identity
        // repository uses (42804 otherwise).
        `INSERT INTO "IdentitySecurityEvent" (id,action,subject,"createdAt") VALUES ($1::uuid,$2,$3,$4)`,
        crypto.randomUUID(), action, subject,
        // Fixed columns only: never an email, token, password or provider payload.
        now,
      );
    },
  };
}

/* ─── Recovery workflow ─────────────────────────────────────────────── */

export interface PortableRecoveryDeps {
  now: () => Date;
  challenges: RecoveryChallengeStore;
  lock: RecoveryLockStore;
  /** Undefined/null means "no delivery channel": recovery must fail closed. */
  mail: IdentityMailTransport | null | undefined;
  /**
   * Company and audit row counts of the destination installation.
   *
   * Only `companies` gates recovery. Retained audit history (a deleted company's
   * rows, which the schema deliberately keeps) is history, not accounting data:
   * it is preserved byte-identical by the restore, so a zero-company
   * installation with retained audits is still recoverable.
   */
  installationState: () => Promise<{ companies: number; audits: number }>;
  restore: (request: PortableRestoreRequest) => Promise<PortableRestoreResult>;
}

export interface PortableRejection {
  status: number;
  code: string;
  message: string;
}

/**
 * WHERE a portable recovery may land (S23 / S24).
 *
 * - `bootstrap`: the anonymous first-installation door. Unchanged contract,
 *   including the `DB_NOT_EMPTY` refusal of an installation that already has
 *   companies (the destination restore keeps its own gate as a second fence).
 * - `owner-admin`: a session door for the installation owner (Administración de
 *   Empresas). The target is the backup's OWN company, created by the existing
 *   destination prepare when this installation does not have it yet.
 * - `active-company`: a session door for the company the operator is working in
 *   (Configuración → Respaldos del Sistema). The target is that ACTIVE company,
 *   whose data the existing coordinated restore replaces.
 *
 * Both session modes inherit every S25 rule: the mandatory owner email token,
 * single use/expiry/binding, throttling, identity mapping, retained history and
 * the provenance archive are the SAME engine code, never a second copy.
 */
export type PortableRecoveryDestination =
  | { mode: 'bootstrap' }
  | { mode: 'owner-admin' }
  | { mode: 'active-company'; companyId: string };

const BOOTSTRAP_DESTINATION: PortableRecoveryDestination = Object.freeze({ mode: 'bootstrap' });

/** Inputs shared by both stages of ONE portable recovery. */
export interface PortableRecoveryEntryInput {
  fileText: string;
  password: string;
  companyLegalName: string;
  ownerEmail: string;
  /**
   * Destination of this restore. Omitted means the anonymous bootstrap contract,
   * so every existing caller keeps its exact behavior.
   */
  destination?: PortableRecoveryDestination;
  /**
   * Email of the AUTHENTICATED session user, resolved server-side (never from a
   * client field). Required by the session doors and ignored by `bootstrap`.
   */
  sessionEmail?: string;
}

export interface PortableCompletionInput extends PortableRecoveryEntryInput {
  token: string;
}

export type PortableChallengeOutcome = { status: 'challenge_sent'; expiresAt: string } | PortableRejection;

export type PortableCompletionOutcome =
  | {
      status: 'restored';
      operationId: string;
      sessionUserId: string;
      counts: Record<string, number | boolean>;
    }
  | { status: 'reconciliation_required'; operationId: string; code: string; message: string }
  | PortableRejection;

interface AuthorizedSource {
  ok: true;
  snapshot: ReturnType<typeof parseSnapshot>;
  payload: ReturnType<typeof openPortableContainer>;
  /** SOURCE owner, proven by the authenticated backup credential (S2/S3). */
  credential: PortableSourceOwnerCredential;
  fileDigest: string;
}

type SourceAuthorization = AuthorizedSource | { ok: false; rejection: PortableRejection };

function rejection(status: number, code: string, message: string): { ok: false; rejection: PortableRejection } {
  return { ok: false, rejection: { status, code, message } };
}

/** Opaque, non-reversible subject for security events and budgets. */
function eventSubject(fileDigest: string): string {
  return crypto.createHash('sha256').update(`bootstrap-recovery:${fileDigest}`).digest('hex');
}

function describeError(error: unknown): string {
  if (error instanceof PortableRecoveryError) return error.message;
  if (error instanceof Error && /^(PORTABLE|RESTORE|RECOVERY)_[A-Z_]+/.test(error.message)) return error.message;
  // Sanitized: a JSON/parse error may quote file content.
  return 'The file could not be read as a portable owner-verified recovery file';
}

async function authorizeSource(
  deps: PortableRecoveryDeps,
  input: { fileText: string; password: string; companyLegalName: string; ownerEmail: string },
): Promise<SourceAuthorization> {
  // 1. Structural header first: a malformed envelope is refused before any budget
  //    is charged. `portableThrottleDigest` performs exactly that read and derives
  //    the canonical budget key from the WRAPPING-KEY inputs only (F2), so
  //    reformatting the file or mutating bytes that never reach the wrapping key
  //    can never buy a fresh set of password guesses.
  let fileDigest: string;
  let throttleSubject: string;
  try {
    throttleSubject = portableThrottleDigest(input.fileText);
    // The authorization token stays bound to the EXACT bytes the operator uploaded.
    fileDigest = portableFileDigest(input.fileText);
  } catch (error) {
    // An older portable version is refused with its own code so the operator is
    // told to export a new backup instead of guessing a wrong password.
    const code = error instanceof PortableRecoveryError && error.code === 'RECOVERY_FORMAT_UNSUPPORTED'
      ? error.code
      : 'RECOVERY_FILE_UNSUPPORTED';
    return rejection(400, code, describeError(error));
  }
  if (typeof input.password !== 'string' ||
      input.password.length < PORTABLE_LIMITS.passwordMin ||
      input.password.length > PORTABLE_LIMITS.passwordMax) {
    return rejection(400, 'RECOVERY_PASSWORD_REQUIRED',
      'The owner password is required and must be between 8 and 256 characters.');
  }
  // The owner email is an input of the password KDF: refuse an incomplete
  // request structurally, before charging an attempt.
  if (typeof input.ownerEmail !== 'string' || input.ownerEmail.trim().length === 0) {
    return rejection(400, 'RECOVERY_IDENTITY_REQUIRED',
      'The owner email recorded in the backup is required, together with the company name and the owner password.');
  }

  const now = deps.now();
  if (!await deps.challenges.admitPasswordAttempt({ fileDigest: throttleSubject, now })) {
    await deps.challenges.recordEvent('challenge_rejected', eventSubject(fileDigest), now);
    return rejection(429, 'RECOVERY_TOO_MANY_ATTEMPTS',
      'Too many recovery password attempts for this file. Wait before trying again.');
  }

  // 2. Identity-bound KDF + AEAD open: proves the password, the owner email and
  //    the company name together, and authenticates the whole payload.
  let opened: ReturnType<typeof openPortableContainer>;
  try {
    opened = openPortableContainer(input.fileText, input.password, {
      ownerEmail: input.ownerEmail,
      companyLegalName: input.companyLegalName,
    });
  } catch (error) {
    await deps.challenges.recordEvent('challenge_rejected', eventSubject(fileDigest), now);
    const code = error instanceof PortableRecoveryError ? error.code : 'RECOVERY_CREDENTIAL_INVALID';
    // A wrong password, a wrong owner email, a wrong company name and a modified
    // file share one sanitized failure; only the "missing input" codes pass
    // through because they describe the request, not the secret.
    const mapped = code === 'RECOVERY_PASSWORD_REQUIRED' || code === 'RECOVERY_IDENTITY_REQUIRED'
      ? code
      : 'RECOVERY_PASSWORD_MISMATCH';
    return rejection(400, mapped, describeError(error));
  }

  let snapshot: ReturnType<typeof parseSnapshot>;
  try {
    snapshot = parseSnapshot(JSON.stringify(opened.payload.snapshot), {
      recovery: 'portable',
      authenticatedDigest: opened.fileDigest,
    });
  } catch (error) {
    return rejection(400, 'RECOVERY_FILE_UNSUPPORTED', describeError(error));
  }

  if (opened.payload.companyId !== snapshot.manifest.companyId ||
      opened.payload.companyLegalName !== snapshot.manifest.companyInfo.legalName) {
    await deps.challenges.recordEvent('challenge_rejected', eventSubject(fileDigest), now);
    return rejection(400, 'RECOVERY_IDENTITY_MISMATCH',
      'The recovery file identity does not match the accounting data inside it.');
  }
  if (!companyNameMatches(opened.payload.companyLegalName, input.companyLegalName)) {
    await deps.challenges.recordEvent('challenge_rejected', eventSubject(fileDigest), now);
    return rejection(400, 'RECOVERY_COMPANY_MISMATCH',
      'The company name does not match the company recorded in this backup.');
  }

  // 3. The source owner is proven by the AUTHENTICATED BACKUP CREDENTIAL, never
  //    by an account that must already exist here. The KDF+AEAD above already
  //    proved the owner password, the owner email and the company name; this
  //    step requires the sealed stamp to describe a verified source owner and
  //    checks it against the owner row inside the same authenticated snapshot.
  //    A brand-new machine has no owner account at all, so a local lookup here
  //    made zero-installation recovery impossible (RECOVERY_OWNER_UNAVAILABLE).
  let credential: PortableSourceOwnerCredential;
  try {
    credential = validatePortableRecoveryCredential({
      payload: opened.payload,
      identity: opened.identity,
    });
  } catch (error) {
    await deps.challenges.recordEvent('challenge_rejected', eventSubject(fileDigest), now);
    return rejection(403, 'RECOVERY_OWNER_UNAVAILABLE', describeError(error));
  }

  return { ok: true, snapshot, payload: opened, credential, fileDigest };
}

async function releaseLease(deps: PortableRecoveryDeps, holder: string): Promise<void> {
  try {
    await deps.lock.release({ holder, now: deps.now() });
  } catch {
    // Expiry reclaims an unreleased lease; never turn this into a failure of
    // the operation that already succeeded.
  }
}

/**
 * Session-scoped rules (S23 / S24 / S25), applied ONLY after the file was opened
 * (that is when the sealed owner email and the payload company are known) and
 * strictly BEFORE any token exists:
 *
 *  - the AUTHENTICATED session user's email must be the backup's authenticated
 *    owner email. It is re-verified on completion, so a token issued to the
 *    owner can never be completed from another session. A missing session email
 *    fails closed with the same fixed code: it must not become an oracle that
 *    says whether the sealed owner differs or is simply unknown;
 *  - for the settings door the opened payload's company must BE the active
 *    company. A mismatch is named, so the operator is not left guessing while
 *    no token is issued, no attempt budget is consumed and nothing is replaced.
 *
 * The anonymous bootstrap door returns immediately and keeps its exact
 * behavior, including the `DB_NOT_EMPTY` gate below.
 */
function checkSessionDestination(
  destination: PortableRecoveryDestination,
  authorized: AuthorizedSource,
  sessionEmail: string | undefined,
): PortableRejection | null {
  if (destination.mode === 'bootstrap') return null;

  const ownerEmail = normalizeOwnerEmail(authorized.credential.ownerEmail);
  const session = typeof sessionEmail === 'string' ? normalizeOwnerEmail(sessionEmail) : '';
  if (session.length === 0 || session !== ownerEmail) {
    return {
      status: 403,
      code: 'RECOVERY_SESSION_IDENTITY_MISMATCH',
      message:
        'The signed-in account is not the owner recorded in this backup. Sign in with the owner email ' +
        'registered in the backup and start the recovery again. Nothing was changed.',
    };
  }

  if (destination.mode === 'active-company' &&
      authorized.payload.payload.companyId !== destination.companyId) {
    return {
      status: 409,
      code: 'RECOVERY_ACTIVE_COMPANY_MISMATCH',
      message:
        'This backup belongs to a different company than the one selected here. Restore it from ' +
        'Configuracion > Respaldos del Sistema while that company is active, or add it from ' +
        'Administracion de Empresas. Nothing was changed.',
    };
  }

  return null;
}

function inProgress(): PortableRejection {
  return {
    status: 429,
    code: 'RECOVERY_IN_PROGRESS',
    message: 'Another recovery attempt is in progress for this installation. Wait for it to finish.',
  };
}

export async function requestPortableRecoveryChallenge(
  deps: PortableRecoveryDeps,
  entry: PortableRecoveryEntryInput,
): Promise<PortableChallengeOutcome> {
  const destination = entry.destination ?? BOOTSTRAP_DESTINATION;
  const holder = createRecoveryLockHolder();
  if (!await deps.lock.acquire({ holder, now: deps.now(), ttlMs: RECOVERY_POLICY.lockTtlMs })) {
    return inProgress();
  }
  try {
    const authorized = await authorizeSource(deps, entry);
    if (!authorized.ok) return authorized.rejection;

    const sessionRefusal = checkSessionDestination(destination, authorized, entry.sessionEmail);
    if (sessionRefusal) {
      await deps.challenges.recordEvent('challenge_rejected', eventSubject(authorized.fileDigest), deps.now());
      return sessionRefusal;
    }

    // The zero-installation gate belongs to the ANONYMOUS door only. A session
    // door targets one explicit company and the destination prepare owns that
    // decision (S23 creates the backup's company, S24 replaces the active one).
    if (destination.mode === 'bootstrap') {
      const state = await deps.installationState();
      if (state.companies > 0) {
        await deps.challenges.recordEvent('challenge_rejected', eventSubject(authorized.fileDigest), deps.now());
        return {
          status: 409,
          code: 'DB_NOT_EMPTY',
          message:
            'This installation already contains companies and cannot be initialized from a backup.',
        };
      }
    }

    const now = deps.now();
    const expiresAt = new Date(now.getTime() + RECOVERY_POLICY.tokenMs);
    const token = createRecoveryToken();
    const digest = tokenDigest(token);
    await deps.challenges.issue({
      fileDigest: authorized.fileDigest,
      ownerUserId: authorized.credential.ownerUserId,
      companyId: authorized.snapshot.manifest.companyId,
      tokenDigest: digest,
      expiresAt,
      now,
    });

    // The token only ever goes to the owner address sealed in the backup.
    const outcome = await deliverRecoveryToken(deps.mail, { to: authorized.credential.ownerEmail, token });
    if (outcome !== 'sent') {
      // Fail closed: an undelivered draft is consumed so it can never be used,
      // and the caller is told delivery is unavailable instead of "sent".
      await deps.challenges.consume({
        fileDigest: authorized.fileDigest,
        ownerUserId: authorized.credential.ownerUserId,
        tokenDigest: digest,
        now: deps.now(),
      });
      await deps.challenges.recordEvent('challenge_delivery_failed', eventSubject(authorized.fileDigest), now);
      return {
        status: 503,
        code: 'RECOVERY_MAIL_UNAVAILABLE',
        message: 'No recovery email could be sent. Configure the mail channel and try again; recovery is blocked.',
      };
    }

    // A concurrent request may have rotated the draft while this message was in
    // flight. Never report a "delivered" token that is already superseded.
    if (!await deps.challenges.isCurrent({
      fileDigest: authorized.fileDigest, tokenDigest: digest, now: deps.now(),
    })) {
      await deps.challenges.recordEvent('challenge_rejected', eventSubject(authorized.fileDigest), now);
      return {
        status: 409,
        code: 'RECOVERY_CHALLENGE_ROTATED',
        message: 'Another recovery request replaced this code. Request a new one.',
      };
    }

    await deps.challenges.recordEvent('challenge_issued', eventSubject(authorized.fileDigest), now);
    return { status: 'challenge_sent', expiresAt: expiresAt.toISOString() };
  } finally {
    await releaseLease(deps, holder);
  }
}

export async function completePortableRecovery(
  deps: PortableRecoveryDeps,
  entry: PortableCompletionInput,
): Promise<PortableCompletionOutcome> {
  const destination = entry.destination ?? BOOTSTRAP_DESTINATION;
  if (typeof entry.token !== 'string' || !RECOVERY_POLICY.tokenPattern.test(entry.token)) {
    return { status: 400, code: 'RECOVERY_TOKEN_INVALID', message: 'The recovery token is invalid.' };
  }
  const holder = createRecoveryLockHolder();
  if (!await deps.lock.acquire({ holder, now: deps.now(), ttlMs: RECOVERY_POLICY.lockTtlMs })) {
    return inProgress();
  }
  let keepLease = false;
  try {
    const authorized = await authorizeSource(deps, entry);
    if (!authorized.ok) return authorized.rejection;

    // Re-verified BEFORE the token is consumed: a refusal here must leave the
    // owner's code usable for the legitimate session.
    const sessionRefusal = checkSessionDestination(destination, authorized, entry.sessionEmail);
    if (sessionRefusal) {
      await deps.challenges.recordEvent('challenge_rejected', eventSubject(authorized.fileDigest), deps.now());
      return sessionRefusal;
    }

    // Same rule as the challenge stage: the zero-installation gate belongs to
    // the anonymous bootstrap door only.
    if (destination.mode === 'bootstrap') {
      const state = await deps.installationState();
      if (state.companies > 0) {
        return {
          status: 409,
          code: 'DB_NOT_EMPTY',
          message:
            'This installation already contains companies and cannot be initialized from a backup.',
        };
      }
    }

    const now = deps.now();
    const consumed = await deps.challenges.consume({
      fileDigest: authorized.fileDigest,
      ownerUserId: authorized.credential.ownerUserId,
      tokenDigest: tokenDigest(entry.token),
      now,
    });
    if (consumed !== 'ok') {
      await deps.challenges.recordEvent('challenge_rejected', eventSubject(authorized.fileDigest), now);
      if (consumed === 'expired') {
        return { status: 400, code: 'RECOVERY_TOKEN_EXPIRED', message: 'The recovery token has expired. Request a new one.' };
      }
      if (consumed === 'used') {
        return { status: 400, code: 'RECOVERY_TOKEN_USED', message: 'This recovery token was already used. Request a new one.' };
      }
      return { status: 400, code: 'RECOVERY_TOKEN_INVALID', message: 'The recovery token is invalid for this backup.' };
    }
    await deps.challenges.recordEvent('challenge_consumed', eventSubject(authorized.fileDigest), now);

    const result = await deps.restore({
      snapshot: authorized.snapshot,
      fileText: entry.fileText,
      fileDigest: authorized.fileDigest,
      payloadDigest: authorized.payload.payloadDigest,
      ownerUserId: authorized.credential.ownerUserId,
      ownerEmail: authorized.credential.ownerEmail,
      ownerPassword: entry.password,
    });

    if (result.status === 'committed') {
      await deps.challenges.recordEvent('restore_committed', eventSubject(authorized.fileDigest), deps.now());
      return {
        status: 'restored',
        operationId: result.operationId,
        sessionUserId: result.sessionUserId,
        counts: result.counts,
      };
    }
    await deps.challenges.recordEvent('restore_failed', eventSubject(authorized.fileDigest), deps.now());
    if (result.status === 'refused') {
      return { status: result.httpStatus, code: result.code, message: result.message };
    }
    // Uncertain outcome: keep the lease (it expires on its own) so no second
    // recovery starts while maintenance is closed for reconciliation.
    keepLease = true;
    return {
      status: 'reconciliation_required',
      operationId: result.operationId,
      code: result.code,
      message: result.message,
    };
  } finally {
    if (!keepLease) await releaseLease(deps, holder);
  }
}
