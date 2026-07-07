import { logger } from './logger';
// src/lib/pdf-worker.ts
// Inicialización idempotente del worker de pdfjs-dist para Next.js 16 + ESM

let initialized = false;

export async function initPdfWorker() {
  // Guard de seguridad: solo Node.js, y una sola vez
  if (initialized || process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    // ✅ Importación dinámica: evita hoisting de ESM y garantiza que DOMMatrix ya existe
    const { GlobalWorkerOptions } = await import('pdfjs-dist');

    // ✅ Resolución 100% en runtime. Cero imports de 'path' ni 'url' para evitar conflictos con Webpack/Edge
    const workerPath =
      `${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`.replace(/\\/g, '/');
    GlobalWorkerOptions.workerSrc = new URL(`file://${workerPath}`).href;

    initialized = true;
    logger.info('[PDF Worker] Inicializado correctamente.');
  } catch (error) {
    logger.warn('[PDF Worker] Fallo en resolución primaria:', { error: String(error) });
    try {
      // Fallback por ruta absoluta (seguro en Docker/Vercel/Railway con hoisting)
      const fallback =
        `${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`.replace(/\\/g, '/');
      const { GlobalWorkerOptions } = await import('pdfjs-dist');
      GlobalWorkerOptions.workerSrc = new URL(`file://${fallback}`).href;
      initialized = true;
    } catch (fallbackErr) {
      logger.error('[PDF Worker] No se pudo inicializar el worker:', { error: String(fallbackErr) });
    }
  }
}
