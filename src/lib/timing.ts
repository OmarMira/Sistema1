// ─── Timing Wrapper ──────────────────────────────────────────────────────────
// Transparent wrapper that measures execution time of async functions.
// Logs warnings for functions exceeding 500ms threshold.

import { trackAPIResponseTime } from './metrics';
import { logger } from './logger';

 
export function withTiming<T extends (...args: any[]) => Promise<any>>(fn: T, label: string): T {
  return (async (...args: Parameters<T>) => {
    const start = performance.now();
    try {
      return await fn(...args);
    } finally {
      const duration = performance.now() - start;
      trackAPIResponseTime(label, 'CALL', duration);
      if (duration > 500) {
        logger.warn('SLOW_FUNCTION', {
          label,
          durationMs: Math.round(duration),
        });
      }
    }
  }) as T;
}
