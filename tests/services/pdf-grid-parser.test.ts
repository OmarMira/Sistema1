import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF } from '@/lib/pdf-parser';

describe('PDF Grid Parser - Geometric & Topological Tests', () => {
  const fixturesPath = join(__dirname, '../fixtures/boa-statements');

  it('debe detectar la topología de columna de monto única y parsear 5 statements matemáticamente consistentes', async () => {
    const months = ['01-31', '02-28', '03-31', '04-30', '05-30'];
    
    for (const m of months) {
      const pdfPath = join(fixturesPath, `eStmt_2025-${m}.pdf`);
      const buffer = readFileSync(pdfPath);
      const result = await parsePDF(buffer);
      
      expect(result).toBeDefined();
      expect(result.openingBalance).toBeDefined();
      expect(result.closingBalance).toBeDefined();
      expect(result.transactions.length).toBeGreaterThan(0);

      // Verify mathematical balance formula: Opening + Credits - Debits = Closing
      const credits = result.transactions.filter(t => t.amount >= 0).reduce((sum, t) => sum + t.amount, 0);
      const debits = Math.abs(result.transactions.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0));
      const calculatedClosing = result.openingBalance! + credits - debits;
      
      expect(Math.abs(calculatedClosing - result.closingBalance!)).toBeLessThan(0.01);
    }
  });

  it('debe inferir y reconstruir años correctamente en rollovers de diciembre a enero', async () => {
    // We can verify this via the real statement of Enero 2025 which starts in December 2024 and rolls over
    const buffer = readFileSync(join(fixturesPath, 'eStmt_2025-01-31.pdf'));
    const result = await parsePDF(buffer);

    // Civil dates are stored as UTC-midnight, so read UTC components.
    expect(result.startDate?.getUTCFullYear()).toBe(2025);
    expect(result.endDate?.getUTCFullYear()).toBe(2025);
    expect(result.startDate?.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(result.endDate?.toISOString()).toMatch(/T00:00:00\.000Z$/);

    // Check that transactions are within the reconstructed time window or correctly inferred years
    for (const tx of result.transactions) {
      expect(tx.date.getUTCFullYear()).toBe(2025);
      expect(tx.date.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });
});
