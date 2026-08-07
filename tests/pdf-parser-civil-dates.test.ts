import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF } from '@/lib/pdf-parser';

/**
 * D8 real-parser regression through the full `parsePDF` entry point, using the
 * deterministic BOA fixture (profile-guided parsing via the seeded bank profile;
 * no OCR/LLM). Layer covered: `parseDateString` + `reconstructTransactionDates`
 * date construction, end to end.
 */
describe('D8 PDF parser civil-date regression', () => {
  const fixturesPath = join(__dirname, 'fixtures/boa-statements');

  it('parses the real BOA fixture with every transaction date at T00:00:00.000Z', async () => {
    const pdfBuffer = readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf'));
    const result = await parsePDF(pdfBuffer, { fileName: 'eStmt_2025-03-31.pdf' });

    expect(result.transactions.length).toBeGreaterThan(0);
    for (const tx of result.transactions) {
      expect(tx.date.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(tx.date.getUTCHours()).toBe(0);
    }
  });

  it('preserves the known reference transaction with a UTC-midnight date', async () => {
    const pdfBuffer = readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf'));
    const result = await parsePDF(pdfBuffer, { fileName: 'eStmt_2025-03-31.pdf' });

    const referenced = result.transactions.find((t) => t.reference === 'T0YKY6RCL');
    expect(referenced).toBeDefined();
    expect(referenced!.date.toISOString()).toMatch(/T00:00:00\.000Z$/);
  });
});
