import { describe, it, expect, beforeAll } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { initPdfWorker } from '@/lib/pdf-worker';
import { generateMockPDFBuffer } from '../helpers/test-data-factory';
import { parsePDF } from '@/lib/pdf-parser';

describe('PDF Worker Resilience', () => {
  beforeAll(() => initPdfWorker());

  it('debe inicializar el worker una sola vez (idempotente)', () => {
    const srcBefore = GlobalWorkerOptions.workerSrc;
    initPdfWorker();
    expect(GlobalWorkerOptions.workerSrc).toBe(srcBefore);
  });

  it('debe parsear un PDF genérico sin crashear', async () => {
    const buffer = generateMockPDFBuffer();
    const result = await parsePDF(buffer);
    expect(result).toHaveProperty('transactions');
    expect(Array.isArray(result.transactions)).toBe(true);
  });

  it('debe fallar gracefulmente con buffer inválido', async () => {
    await expect(parsePDF(Buffer.from('NOT_A_PDF'))).rejects.toThrow();
  });
});
