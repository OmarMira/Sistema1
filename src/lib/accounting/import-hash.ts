if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import { createHash } from 'crypto';

export interface HashPayload {
  companyId: string;
  accountNumber: string; // accountNo de BankAccount
  /**
   * @deprecated The statement month is NO LONGER part of the hash.
   *
   * It used to be, which made the same bank row hash differently under a
   * different statement range and silently produced duplicates. The field
   * stays optional only so existing callers keep compiling; it is ignored.
   * Pre-existing rows hashed the old way are still matched through
   * `generateLegacyImportHash`.
   */
  statementMonth?: string;
  txDate: string; // "YYYY-MM-DD"
  amount: number;
  description: string;
  reference?: string;
}

/** Deterministic text normalization used by every hash input. */
function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Genera un hash SHA-256 determinista para una transacción bancaria.
 * Se usa para detectar y rechazar reimportaciones duplicadas.
 *
 * The hash covers ONLY normalized row content (company, account, date,
 * amount, description, reference). The statement range is deliberately
 * excluded: re-importing the same rows under a different statement range
 * must be detected as a duplicate.
 */
export function generateImportHash(payload: HashPayload): string {
  const raw = [
    payload.companyId,
    payload.accountNumber,
    payload.txDate,
    payload.amount.toFixed(2),
    normalizeText(payload.description),
    normalizeText(payload.reference ?? ''),
  ].join('|');
  return sha256(raw);
}

/**
 * LEGACY hash shape (statement month INCLUDED), kept only to recognize rows
 * stored before the content-hash change.
 *
 * Migration note: rows imported by older builds keep this value in
 * `BankTransaction.importHash`. They cannot be recomputed without knowing the
 * statement range they were imported under, so the import pipeline looks up
 * BOTH hashes when it checks for duplicates. A row stored the legacy way is
 * therefore still detected inside its original statement range; detecting it
 * under a NEW range would require a data migration (rewrite of stored hashes),
 * which is intentionally not performed here. Only new rows are stored with the
 * content hash. Never change this function: it is the compatibility anchor.
 */
export function generateLegacyImportHash(payload: HashPayload & { statementMonth: string }): string {
  const raw = [
    payload.companyId,
    payload.accountNumber,
    payload.statementMonth,
    payload.txDate,
    payload.amount.toFixed(2),
    normalizeText(payload.description),
  ].join('|');
  return sha256(raw);
}
