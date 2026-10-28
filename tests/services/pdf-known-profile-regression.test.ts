import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePDF } from '@/lib/pdf-parser';
import config from '@/lib/bank-profiles/boa-standard.json';

const mocks = vi.hoisted(() => {
  // Text extraction does not render; PDF.js still needs this global at import.
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class {} as unknown as typeof DOMMatrix;
  return { learn: vi.fn(), write: vi.fn(), network: vi.fn() };
});
vi.mock('@/lib/db', () => ({ db: { auditLog: { create: mocks.write } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/bank-profile-service', () => ({
  getAllActiveProfiles: async () => [{ bankId: config.bankId, bankName: config.bankName, fingerprints: config.fingerprints, config }],
  updateRequiresReviewStatus: mocks.write,
}));
vi.mock('@/lib/bank-profile-onboarding', () => ({ createProfileFromPdf: mocks.learn }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.learn.mockRejectedValue(new Error('Known formats must not require AI'));
  mocks.network.mockRejectedValue(new Error('External requests are forbidden'));
  vi.stubGlobal('fetch', mocks.network);
});

afterEach(() => vi.unstubAllGlobals());

const months = [
  ['01-31', 20], ['02-28', 10], ['03-31', 8], ['04-30', 7], ['05-30', 15], ['06-30', 16],
  ['07-31', 29], ['08-29', 35], ['09-30', 37], ['10-31', 49], ['11-28', 27], ['12-31', 49],
] as const;

// Optional local corpus: customer documents are not a distributed dependency.
describe.skipIf(process.env.RUN_BANK_PDF_CORPUS !== '1')('known PDF formats remain independent of AI configuration', () => {
  it.each(months)('preserves the existing %s statement extraction (%i rows)', async (month, expected) => {
    const bytes = readFileSync(path.join(process.cwd(), 'tests/fixtures/boa-statements', `eStmt_2025-${month}.pdf`));
    const result = await parsePDF(bytes);
    expect(result.transactions.length).toBe(expected);
    expect(result.mathValid).toBe(true);
    expect(Math.abs(result.mismatch)).toBeLessThan(0.01);
    expect(result.transactions.every(row => Number.isFinite(row.amount) && Number.isFinite(row.date.getTime()))).toBe(true);
    expect(mocks.learn).not.toHaveBeenCalled();
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
