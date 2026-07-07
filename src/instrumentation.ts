// ─── Next.js Instrumentation Hook ────────────────────────────────────────────
// Called once when the server starts. Used to verify DB connection and set session params.
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

import * as Sentry from '@sentry/nextjs';

// Next.js 15+ soporta register() async
export async function register() {
  // 1️⃣ Sentry Edge Config
  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
    });
  }

  // 2️⃣ Node.js Runtime Config & Setup
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Sentry Server Config
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
    });

    // POLYFILL: Debe ejecutarse ANTES de que cualquier módulo importe pdfjs-dist
    if (typeof globalThis.DOMMatrix === 'undefined') {
      (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = class DOMMatrix {
        constructor() {}
        toString() {
          return 'matrix(1,0,0,1,0,0)';
        }
        static fromFloat32Array() {
          return new this();
        }
        static fromFloat64Array() {
          return new this();
        }
        multiply() {
          return this;
        }
      };
    }

    // Inicializa worker PDF dinámicamente para evitar warnings en el compilador de Edge
    const { initPdfWorker } = await import('./lib/pdf-worker');
    await initPdfWorker();

    const { optimizeSQLite } = await import('./lib/db-optimizer');
    const { resetMetrics } = await import('./lib/metrics');
    const { startSessionCleanupInterval } = await import('./lib/maintenance/cleanupSessions');
    const { decrypt } = await import('./lib/crypto');

    await optimizeSQLite();
    resetMetrics();
    startSessionCleanupInterval();

    // Auto-decrypt API key at startup if encrypted variant exists
    if (process.env.AI_API_KEY_ENCRYPTED && !process.env.AI_API_KEY) {
      try {
        process.env.AI_API_KEY = decrypt(process.env.AI_API_KEY_ENCRYPTED);
      } catch {
        // encrypted key exists but decryption failed (e.g. SESSION_SECRET changed)
      }
    }
  }
}

// Hook para capturar errores de requests
export const onRequestError = Sentry.captureRequestError;
