/**
 * AI failures inside the PDF parser are NOT thrown to the caller.
 *
 * Contract since the per-file import pipeline: `/api/import/validate` collects a
 * result per file and answers 200 with that collection, so a file whose format
 * could not be learned must degrade into an empty parse carrying an actionable
 * warning instead of aborting the batch. `parsePDF` therefore swallows AI
 * failures from both the onboarding and the self-healing paths and never writes
 * review state or an audit row for a document it could not read.
 *
 * These tests pin that degradation explicitly so nobody mistakes it for the
 * parser "returning an empty statement" silently.
 */
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

/** Warning the parser shows when no format could be learned for the document. */
const MANUAL_ALIGNMENT_WARNING = 'No se encontró un perfil bancario';

beforeEach(() => { vi.clearAllMocks(); mocks.profiles.mockResolvedValue([]); });

describe('PDF parser degrades an unreadable format into one reported file', () => {
  it.each([false, true])('reports missing configuration as an unreadable document instead of throwing (matching=%s)', async (matching) => {
    if (matching) mocks.profiles.mockResolvedValue([{ bankId: 'synthetic', bankName: 'Synthetic', fingerprints: ['Synthetic Bank'], config }]);
    mocks.learn.mockRejectedValue(new ImportAiError('AI_CONFIG_MISSING'));

    const result = await parsePDF(Buffer.from('synthetic'));

    // The learning boundary was reached exactly once and the failure was reported
    // as "no transactions + reason", never as a thrown batch abort.
    expect(mocks.learn).toHaveBeenCalledTimes(1);
    expect(result.transactions).toEqual([]);
    expect(result.mathValid).toBe(false);
    // The onboarding path (no candidate profile) must tell the user why the file
    // produced nothing; the self-healing path reports the same situation through
    // the absence of a learned format and writes no review state.
    if (!matching) {
      expect(result.warnings.join(' ')).toContain(MANUAL_ALIGNMENT_WARNING);
    }
    // No write happens for a document the parser could not read.
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('never disguises a provider error as a successful reconciliation', async () => {
    mocks.learn.mockRejectedValue(new ImportAiError('AI_PROVIDER_UNAVAILABLE'));

    const result = await parsePDF(Buffer.from('synthetic'));

    expect(result.transactions).toEqual([]);
    expect(result.mathValid).toBe(false);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
