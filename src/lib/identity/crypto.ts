import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

export function createCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function createRecoveryToken(): string {
  return randomBytes(32).toString('hex');
}

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function opaqueSubject(key: Buffer, purpose: string, value: string): string {
  if (key.length < 32) throw new Error('A dedicated identity key of at least 32 bytes is required');
  return createHmac('sha256', key).update(JSON.stringify([purpose, value])).digest('hex');
}

export function codeDigest(key: Buffer, subjectId: string, generation: number, code: string): string {
  return opaqueSubject(key, 'VERIFICATION', JSON.stringify([subjectId, generation, code]));
}
