import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePDF } from '@/lib/pdf-parser';
import { getAllActiveProfiles, getBankProfile, invalidateAllProfilesCache } from '@/lib/bank-profile-service';
import packaged from '@/lib/bank-profiles/boa-standard.json';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), update: vi.fn(),
  learn: vi.fn(), network: vi.fn(),
  items: [] as { str: string; transform: number[]; width: number; height: number }[],
}));
vi.mock('@/lib/db', () => ({ db: { bankProfile: mocks } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/bank-profile-onboarding', () => ({ createProfileFromPdf: mocks.learn }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({
    numPages: 1,
    getPage: async () => ({
      getViewport: () => ({ width: 612 }),
      getTextContent: async () => ({ items: mocks.items }),
    }),
  }) }),
}));

function item(str: string, x: number, y: number, width = 60) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height: 10 };
}
function storedProfile(isActive = true) {
  return {
    id: 'synthetic-profile', bankId: packaged.bankId, bankName: 'Stored definition',
    fingerprints: JSON.stringify(packaged.fingerprints), config: JSON.stringify(packaged),
    isActive, requiresReview: false,
    createdAt: new Date(0), updatedAt: new Date(0),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  invalidateAllProfilesCache();
  mocks.findUnique.mockResolvedValue(null);
  mocks.findMany.mockResolvedValue([]);
  mocks.learn.mockRejectedValue(new Error('SYNTHETIC_DISCOVERY_UNAVAILABLE'));
  mocks.network.mockRejectedValue(new Error('NETWORK_BLOCKED'));
  mocks.upsert.mockRejectedValue(new Error('WRITES_BLOCKED'));
  mocks.update.mockRejectedValue(new Error('WRITES_BLOCKED'));
  vi.stubGlobal('fetch', mocks.network);
  // Synthetic text and amounts, never copied from a customer document.
  mocks.items = [
    item('Bank of America Statement', 30, 760),
    item('01/01/2026 to 01/31/2026', 30, 740),
    item('Beginning balance $100.00', 30, 720),
    item('Ending balance $75.00', 30, 700),
    item('01/02/2026', 30, 660), item('Deposit example', 150, 660), item('50.00', 530, 660),
    item('01/03/2026', 30, 640), item('Payment example', 150, 640), item('-75.00', 530, 640),
  ];
});
afterEach(() => { invalidateAllProfilesCache(); vi.unstubAllGlobals(); });

function expectReadOnly() {
  expect(mocks.upsert).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.network).not.toHaveBeenCalled();
}

describe('PDF profile recovery through the real loader and public parser', () => {
  it('extracts a known layout from an empty store without discovery or writes', async () => {
    const result = await parsePDF(Buffer.from('synthetic positioned text'));
    expect(result.transactions.map(row => ({
      date: row.date.toISOString(), description: row.description, amount: row.amount,
    }))).toEqual([
      { date: '2026-01-02T00:00:00.000Z', description: 'Deposit example', amount: 50 },
      { date: '2026-01-03T00:00:00.000Z', description: 'Payment example', amount: -75 },
    ]);
    expect(result.openingBalance).toBe(100);
    expect(result.closingBalance).toBe(75);
    expect(result.mathValid).toBe(true);
    expect(result.mismatch).toBe(0);
    expect(mocks.learn).not.toHaveBeenCalled();
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
    expectReadOnly();
  });

  it('uses a stored definition instead of duplicating the packaged bank', async () => {
    const stored = storedProfile();
    mocks.findUnique.mockResolvedValue(stored);
    mocks.findMany.mockResolvedValue([stored]);
    expect((await getBankProfile(packaged.bankId))?.id).toBe(stored.id);
    expect((await getAllActiveProfiles()).map(profile => profile.id)).toEqual([stored.id]);
    expect((await parsePDF(Buffer.from('synthetic'))).bankName).toBe('Stored definition');
    expect(mocks.learn).not.toHaveBeenCalled();
    expectReadOnly();
  });

  it('respects explicit deactivation rather than reactivating the packaged definition', async () => {
    mocks.findUnique.mockResolvedValue(null);
    // S1 (Wave 5): the global lookup reads through findMany (a nullable companyId is
    // not addressable by a unique input), so the deactivated row is the first read.
    mocks.findMany
      .mockResolvedValueOnce([storedProfile(false)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ bankId: packaged.bankId }])
      .mockResolvedValue([]);
    expect((await getBankProfile(packaged.bankId))?.isActive).toBe(false);
    expect(await getAllActiveProfiles()).toEqual([]);
    const result = await parsePDF(Buffer.from('synthetic'));
    expect(result.transactions).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('layout automáticamente'))).toBe(true);
    expect(mocks.learn).toHaveBeenCalledTimes(1);
    expectReadOnly();
  });

  it('does not apply a packaged bank to an unknown document and retains its discovery warning', async () => {
    mocks.items[0] = item('Unrecognized synthetic institution', 30, 760);
    expect(await getBankProfile('unknown-bank')).toBeNull();
    const result = await parsePDF(Buffer.from('synthetic'));
    expect(result.transactions).toEqual([]);
    expect(result.warnings.some(warning => warning.includes('layout automáticamente'))).toBe(true);
    expect(mocks.learn).toHaveBeenCalledTimes(1);
    expectReadOnly();
  });
});
