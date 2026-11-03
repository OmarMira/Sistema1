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
    const { withRuntimeOperation } = await import('./lib/backup-runtime-maintenance');
    await withRuntimeOperation(registerNodeRuntime);
  }
}

async function registerNodeRuntime() {
  // Validate required environment before starting any runtime service.
  const { validateEnv } = await import('./lib/env/server');
  validateEnv();

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

  const { initRuntimeData } = await import('./lib/init-runtime');
  const { optimizeDatabase } = await import('./lib/db-optimizer');
  const { resetMetrics } = await import('./lib/metrics');
  const { startSessionCleanupInterval } = await import('./lib/maintenance/cleanupSessions');

  initRuntimeData();
  await optimizeDatabase();
  resetMetrics();
  startSessionCleanupInterval();

  await decryptAiApiKeyAtStartup();
}

/**
 * Auto-decrypt the encrypted AI API key at startup when only the sealed variant
 * is present.
 *
 * S23f: the failure path used to be swallowed, so a rotated SESSION_SECRET (or a
 * corrupted value) silently left the assistant without a key and no diagnostic.
 * A failure is now logged as an ERROR with the actionable cause.
 *
 * @returns true when AI_API_KEY was populated.
 */
export async function decryptAiApiKeyAtStartup(): Promise<boolean> {
  if (!process.env.AI_API_KEY_ENCRYPTED || process.env.AI_API_KEY) return false;

  const { decrypt } = await import('./lib/crypto');
  try {
    process.env.AI_API_KEY = await decrypt(process.env.AI_API_KEY_ENCRYPTED);
    return true;
  } catch (error) {
    const { logger } = await import('./lib/logger');
    logger.error(
      '[INSTRUMENTATION] Failed to decrypt AI_API_KEY_ENCRYPTED — the AI assistant will run without a key. ' +
        'Most common cause: SESSION_SECRET changed since the key was saved. Re-save the AI key from Settings.',
      { error: String(error) },
    );
    return false;
  }
}

// Hook para capturar errores de requests
export const onRequestError = Sentry.captureRequestError;
