if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import { createHash } from 'crypto';

export function generateHash(payload: string | Record<string, unknown>): string {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHash('sha256').update(content).digest('hex');
}

export function verifyHash(content: string, expectedHash: string): boolean {
  const actualHash = generateHash(content);
  return actualHash === expectedHash;
}
