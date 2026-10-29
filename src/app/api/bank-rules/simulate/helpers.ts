import { MAX_PER_BATCH } from '@/lib/services/apply-all-engine';

export type ParseSimulateLimitResult = { ok: true; value?: number } | { ok: false };

/**
 * Validates the `limit` field against the engine's real batch cap.
 * `undefined`/`null` → valid, limit omitted (engine default).
 * Rejects NaN, decimals, negatives, zero, over-cap, and non-numbers.
 */
export function parseSimulateLimit(raw: unknown): ParseSimulateLimitResult {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_PER_BATCH) {
    return { ok: false };
  }
  return { ok: true, value: raw };
}
