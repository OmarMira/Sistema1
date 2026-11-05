if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import crypto from 'node:crypto';
import { AppError } from './api-error';

/* ─── Backup ownership verifier (S1/S2/S7) ─────────────────────────────
 * A backup file is a complete copy of a company: company PII, the full
 * ledger and every restorable row. Until now, holding the FILE was enough to
 * restore it anywhere, so a stolen backup was a stolen company. A restore now
 * has to prove ownership with the credential of the super admin who created
 * the backup, exactly like creating a backup requires that admin to re-enter
 * their password (sudo style).
 *
 * What is stored, and where:
 *  - ONLY a verifier: per-backup random salt + scrypt-derived key.
 *  - NEVER the password, never its bcrypt hash, never a plaintext section.
 *  - The verifier lives in `manifest.ownership`, which is part of the payload
 *    that is (a) HMAC-sealed with SESSION_SECRET and (b) AES-256-GCM sealed at
 *    rest. A hand-edited or transplanted verifier therefore fails the seal
 *    before it is ever consulted, and no plaintext section of the file or the
 *    at-rest envelope carries it.
 *
 * Why scrypt from node:crypto and not a new dependency: the project forbids
 * adding runtime dependencies for a credential primitive, and scrypt is a
 * memory-hard KDF that ships with Node. Argon2id (named in the ODD spec) would
 * require a native module; scrypt with N=2^15, r=8, p=1 and a 16-byte salt is
 * the equivalent-strength choice available with zero new dependencies.
 * The parameters are STORED with the verifier so a later parameter change
 * never invalidates a backup that already exists.
 */
export interface BackupOwnershipParams {
  /** CPU/memory cost: 2^15. */
  N: number;
  /** Block size: 8. */
  r: number;
  /** Parallelization: 1. */
  p: number;
  /** Derived key length in bytes: 32. */
  keyLength: number;
}

export interface BackupOwnershipVerifier {
  kdf: 'scrypt';
  /** base64 of the per-backup random salt (16 bytes). */
  salt: string;
  /** base64 of the derived key (32 bytes). */
  hash: string;
  params: BackupOwnershipParams;
}

export const BACKUP_OWNERSHIP_SALT_BYTES = 16;
export const BACKUP_OWNERSHIP_KEY_BYTES = 32;

export const BACKUP_OWNERSHIP_PARAMS: Readonly<BackupOwnershipParams> = Object.freeze({
  N: 2 ** 15,
  r: 8,
  p: 1,
  keyLength: BACKUP_OWNERSHIP_KEY_BYTES,
});

/** Memory ceiling accepted when the verifier is read back from a file.
 * node's scrypt default is 32 MiB, which is too small for N=2^15/r=8; a hostile
 * backup must not be able to request an unbounded KDF either, so the accepted
 * window is bounded on both ends. */
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const MIN_N = 2 ** 14;
/** 128 * N * r must stay inside SCRYPT_MAX_MEMORY: 2^15 * 8 * 128 = 32 MiB. */
const MAX_N = 2 ** 15;
const MAX_R = 8;
const MAX_P = 4;
const MAX_KEY_BYTES = 64;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPowerOfTwo(value: number): boolean {
  return value >= MIN_N && value <= MAX_N && (value & (value - 1)) === 0;
}

function decoded(base64: unknown, bytes: number): Buffer | null {
  if (typeof base64 !== 'string' || base64.length === 0) return null;
  const raw = Buffer.from(base64, 'base64');
  return raw.length === bytes ? raw : null;
}

/** Shape gate for a verifier read back from an untrusted file. */
export function isBackupOwnershipVerifier(value: unknown): value is BackupOwnershipVerifier {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<BackupOwnershipVerifier>;
  if (candidate.kdf !== 'scrypt') return false;
  if (!decoded(candidate.salt, BACKUP_OWNERSHIP_SALT_BYTES)) return false;
  const params = candidate.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const keys = Object.keys(params);
  if (keys.length !== 4 || !['N', 'keyLength', 'p', 'r'].every((key) => keys.includes(key))) return false;
  if (!isPositiveInteger(params.N) || !isPositiveInteger(params.r) || !isPositiveInteger(params.p)) return false;
  if (!isPowerOfTwo(params.N) || params.r > MAX_R || params.p > MAX_P) return false;
  if (!isPositiveInteger(params.keyLength) || params.keyLength > MAX_KEY_BYTES) return false;
  return decoded(candidate.hash, params.keyLength) !== null;
}

/** Bounded by the verifier shape gate; a hostile file can never ask for an
 * unbounded cost, and an unsupported parameter set fails as a plain mismatch. */
function derive(password: string, salt: Buffer, params: BackupOwnershipParams): Buffer | null {
  if (typeof password !== 'string' || password.length === 0) return null;
  try {
    return crypto.scryptSync(password, salt, params.keyLength, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAX_MEMORY,
    });
  } catch {
    return null;
  }
}

/**
 * Build the verifier embedded at backup creation. The caller must already have
 * authenticated the actor against the DB (bcrypt); this function only derives
 * the one-way proof and never persists or returns the password.
 */
export function buildBackupOwnership(password: string): BackupOwnershipVerifier {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('BACKUP_PASSWORD_REQUIRED: the creating administrator password is required');
  }
  const salt = crypto.randomBytes(BACKUP_OWNERSHIP_SALT_BYTES);
  const hash = derive(password, salt, BACKUP_OWNERSHIP_PARAMS) as Buffer;
  return {
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    params: { ...BACKUP_OWNERSHIP_PARAMS },
  };
}

/**
 * - `missing-verifier`: the snapshot carries no verifier at all (created before
 *   ownership protection existed). Nothing can be proven, so it is refused.
 * - `invalid-verifier`: a verifier is present but malformed — never trusted.
 * - `invalid-credential`: the verifier is well formed and the attempt failed.
 */
export type BackupOwnershipFailure = 'missing-verifier' | 'invalid-verifier' | 'invalid-credential';

export const BACKUP_OWNERSHIP_MESSAGES: Readonly<Record<BackupOwnershipFailure, string>> = Object.freeze({
  'missing-verifier':
    'No se puede restaurar: este respaldo se creó antes de que existiera la protección por contraseña, ' +
    'así que no tiene credencial de propiedad. Generá un respaldo nuevo desde la instalación original.',
  'invalid-verifier':
    'No se puede restaurar: la credencial de propiedad de este respaldo está dañada o fue alterada.',
  'invalid-credential':
    'No se puede restaurar: la contraseña del super administrador que creó este respaldo no es correcta ' +
    'o no fue ingresada.',
});

/**
 * Verify the restorer's credential against the stored scrypt parameters with a
 * timing-safe comparison. Pure: no I/O, no DB, never logs the attempt.
 */
export function checkBackupOwnership(
  verifier: unknown,
  password: unknown,
): BackupOwnershipFailure | null {
  if (verifier === undefined || verifier === null) return 'missing-verifier';
  if (!isBackupOwnershipVerifier(verifier)) return 'invalid-verifier';
  const expected = decoded(verifier.hash, verifier.params.keyLength) as Buffer;
  const actual = derive(
    typeof password === 'string' ? password : '',
    decoded(verifier.salt, BACKUP_OWNERSHIP_SALT_BYTES) as Buffer,
    verifier.params,
  );
  if (!actual || actual.length !== expected.length) return 'invalid-credential';
  return crypto.timingSafeEqual(actual, expected) ? null : 'invalid-credential';
}

/**
 * Ownership refusal is a client error (400) with its own machine code, so the
 * routes answer `RESTORE_OWNERSHIP` instead of a generic validation failure,
 * and the message stays Spanish for the operator.
 */
export class BackupOwnershipError extends AppError {
  constructor(readonly reason: BackupOwnershipFailure) {
    super(400, BACKUP_OWNERSHIP_MESSAGES[reason], 'RESTORE_OWNERSHIP', { reason });
    this.name = 'BackupOwnershipError';
  }
}

/**
 * Fail-closed gate shared by every restore path (in-system and bootstrap).
 * MUST run before any mutation: before the bootstrap shell rows, before the
 * destination validation, before any delete or file publication.
 */
export function assertBackupOwnership(
  manifest: { ownership?: unknown } | null | undefined,
  password: unknown,
): void {
  const failure = checkBackupOwnership(manifest?.ownership, password);
  if (failure) throw new BackupOwnershipError(failure);
}
