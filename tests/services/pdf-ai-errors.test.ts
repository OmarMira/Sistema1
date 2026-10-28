import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePDF } from '@/lib/pdf-parser';
import { ImportAiError } from '@/lib/ai-import-error';
import config from '@/lib/bank-profiles/boa-standard.json';

const mocks = vi.hoisted(() => ({ profiles: vi.fn(), learn: vi.fn(), review: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { auditLog: { create: mocks.audit } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/bank-profile-service', () => ({ getAllActiveProfiles: mocks.profiles, updateRequiresReviewStatus: mocks.review }));
vi.mock('@/lib/bank-profile-onboarding', () => ({ createProfileFromPdf: mocks.learn }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({
    numPages: 1,
    getPage: async () => ({
      getViewport: () => ({ width: 600 }),
      getTextContent: async () => ({ items: [
        { str: 'Synthetic Bank Statement', transform: [1, 0, 0, 1, 10, 100], width: 250, height: 10 },
      ] }),
    }),
  }) }),
}));

beforeEach(() => { vi.clearAllMocks(); mocks.profiles.mockResolvedValue([]); });

describe('PDF parser preserves actionable AI failures', () => {
  it.each([false, true])('preserves missing configuration through onboarding/self-healing (matching=%s)', async (matching) => {
    if (matching) mocks.profiles.mockResolvedValue([{ bankId: 'synthetic', bankName: 'Synthetic', fingerprints: ['Synthetic Bank'], config }]);
    const failure = new ImportAiError('AI_CONFIG_MISSING');
    mocks.learn.mockRejectedValue(failure);
    await expect(parsePDF(Buffer.from('synthetic'))).rejects.toBe(failure);
    expect(mocks.learn).toHaveBeenCalledTimes(1);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not disguise a provider error as an empty statement', async () => {
    const failure = new ImportAiError('AI_PROVIDER_UNAVAILABLE');
    mocks.learn.mockRejectedValue(failure);
    await expect(parsePDF(Buffer.from('synthetic'))).rejects.toBe(failure);
    expect(mocks.review).not.toHaveBeenCalled();
  });
});
