import { createHash } from 'crypto';

export interface HashPayload {
  companyId: string;
  accountNumber: string; // accountNo de BankAccount
  statementMonth: string; // "YYYY-MM" del período del extracto
  txDate: string; // "YYYY-MM-DD"
  amount: number;
  description: string;
}

/**
 * Genera un hash SHA-256 determinista para una transacción bancaria.
 * Se usa para detectar y rechazar reimportaciones duplicadas.
 */
export function generateImportHash(payload: HashPayload): string {
  const normalizedDesc = payload.description.trim().replace(/\s+/g, ' ').toLowerCase();
  const raw = [
    payload.companyId,
    payload.accountNumber,
    payload.statementMonth,
    payload.txDate,
    payload.amount.toFixed(2),
    normalizedDesc,
  ].join('|');
  return createHash('sha256').update(raw).digest('hex');
}
