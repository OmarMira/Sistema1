// AI governance — per-company daily token budget, kill switch and usage capture.
//
// Config-driven, no schema change: usage accumulates in SystemConfig rows that
// are keyed per company + UTC day. Enforcement is deliberately conservative:
//   - AI_DISABLED=1 is a hard kill switch for every AI provider call;
//   - AI_DAILY_TOKEN_BUDGET is the daily per-company cap;
//   - when the cap is unset the check fails OPEN (legacy installs keep working)
//     and warns once per process so the exposure is visible in the logs.
import { AppError } from '@/lib/api-error';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

export const AI_DISABLED_CODE = 'AI_DISABLED';
export const AI_BUDGET_EXCEEDED_CODE = 'AI_DAILY_BUDGET_EXCEEDED';

/** SystemConfig key prefix; one row per company + day, JSON value `{ tokens }`. */
const USAGE_KEY_PREFIX = 'ai.tokens';

let warnedUncappedBudget = false;

function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function aiTokenUsageKey(companyId: string, now: Date = new Date()): string {
  return `${USAGE_KEY_PREFIX}.${companyId}.${utcDay(now)}`;
}

/** Kill switch: AI_DISABLED=1 disables every provider call. */
export function isAiDisabled(): boolean {
  return (process.env.AI_DISABLED ?? '').trim() === '1';
}

/** Daily per-company token cap. `null` means uncapped (legacy/fail-open). */
export function getDailyTokenBudget(): number | null {
  const raw = (process.env.AI_DAILY_TOKEN_BUDGET ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/**
 * Token count exposed by an OpenAI-compatible provider response.
 * `usage.total_tokens` when present, otherwise prompt + completion tokens.
 */
export function extractTotalTokens(payload: unknown): number {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== 'object') return 0;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total > 0) return Math.floor(total);
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  const sum = (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0);
  return sum > 0 ? Math.floor(sum) : 0;
}

/** Tokens already spent today by this company (0 when unknown/unreadable). */
export async function getDailyTokenUsage(companyId: string, now: Date = new Date()): Promise<number> {
  const row = await db.systemConfig.findUnique({ where: { key: aiTokenUsageKey(companyId, now) } });
  if (!row) return 0;
  try {
    const parsed = JSON.parse(row.value) as { tokens?: unknown };
    const tokens = Number(parsed?.tokens);
    return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  } catch {
    logger.warn('[AI QUOTA] Unreadable usage record — treating as zero', { companyId });
    return 0;
  }
}

/**
 * Accumulate token usage for company + day.
 *
 * Bookkeeping must never fail the user request: any storage error is logged and
 * swallowed, and the spend simply stays uncounted for that call.
 */
export async function recordAiTokenUsage(
  companyId: string,
  tokens: number,
  now: Date = new Date(),
): Promise<void> {
  if (!companyId || !Number.isFinite(tokens) || tokens <= 0) return;
  const key = aiTokenUsageKey(companyId, now);
  const delta = Math.floor(tokens);

  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.systemConfig.findUnique({ where: { key } });
      let current = 0;
      if (existing) {
        try {
          const parsed = JSON.parse(existing.value) as { tokens?: unknown };
          const value = Number(parsed?.tokens);
          current = Number.isFinite(value) && value > 0 ? value : 0;
        } catch {
          current = 0;
        }
      }
      const value = JSON.stringify({ tokens: current + delta, updatedAt: now.toISOString() });
      await tx.systemConfig.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    });
  } catch (error) {
    logger.warn('[AI QUOTA] Failed to record token usage', {
      companyId,
      tokens: delta,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Gate every AI provider call.
 *
 * Throws a controlled AppError (rendered by apiHandler) when the kill switch is
 * on (503) or the company's daily budget is exhausted (429). Fails open — with
 * one warning per process — when no budget is configured, and also when the
 * usage record cannot be read, so telemetry problems never block accounting.
 */
export async function assertAiCallAllowed(companyId: string, now: Date = new Date()): Promise<void> {
  if (isAiDisabled()) {
    throw new AppError(
      503,
      'AI features are disabled by the operator (AI_DISABLED).',
      AI_DISABLED_CODE,
    );
  }

  const budget = getDailyTokenBudget();
  if (budget === null) {
    if (!warnedUncappedBudget) {
      warnedUncappedBudget = true;
      logger.warn(
        '[AI QUOTA] AI_DAILY_TOKEN_BUDGET is not set — AI spend is uncapped (fail-open)',
      );
    }
    return;
  }

  let used: number;
  try {
    used = await getDailyTokenUsage(companyId, now);
  } catch (error) {
    logger.warn('[AI QUOTA] Usage lookup failed — allowing the AI call (fail-open)', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (used >= budget) {
    logger.warn('[AI QUOTA] Daily token budget exhausted', { companyId, used, budget });
    throw new AppError(
      429,
      `AI daily token budget exhausted for this company (${used}/${budget} tokens).`,
      AI_BUDGET_EXCEEDED_CODE,
      { used, budget },
    );
  }
}
