'use client';

import { useEffect } from 'react';
import { logger } from '@/lib/logger';

/**
 * App-level route error boundary (S23g).
 *
 * `ViewErrorBoundary` covers failures inside a single view; this boundary is the
 * Next.js App Router safety net for a route segment that threw during render.
 * Copy stays i18n-neutral on purpose: it renders before the language store has
 * rehydrated, so it must never depend on translation keys (or leak raw ones).
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logger.error('Route error boundary caught an error:', {
      error: String(error),
      digest: error.digest ?? null,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center shadow-lg">
        <div className="flex size-12 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/50">
          <svg
            className="size-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-bold">Algo salió mal · Something went wrong</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Esta pantalla no se pudo mostrar. Puedes reintentar sin perder tus datos. · This screen
            could not be displayed. You can retry without losing your data.
          </p>
        </div>
        <button
          type="button"
          onClick={() => reset()}
          className="w-full rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground shadow transition-colors hover:bg-primary/90"
        >
          Reintentar · Try again
        </button>
      </div>
    </div>
  );
}
