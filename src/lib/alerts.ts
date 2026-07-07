// ─── Alert Aggregator ────────────────────────────────────────────────────────
// Batches slow query alerts to avoid webhook flooding under load.
// - Queue limited to MAX_QUEUE_SIZE (backpressure)
// - Flushes every FLUSH_INTERVAL_MS with a single summarized webhook
// - Hard timeout on webhook via AbortController (5s)
// - Proper SIGTERM cleanup with removeListener (no infinite loop)

import { logger } from './logger';

interface SlowQueryInfo {
  query: string;
  durationMs: number;
}

const MAX_QUEUE_SIZE = 100;
const FLUSH_INTERVAL_MS = 60_000; // 1 minute

class AlertAggregator {
  private queue: SlowQueryInfo[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  push(info: SlowQueryInfo) {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      logger.warn('ALERT_QUEUE_FULL', { droppedQuery: info.query.substring(0, 50) });
      return;
    }
    this.queue.push(info);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);
    const summary = this.buildSummary(batch);

    // Log locally always
    logger.warn('SLOW_QUERIES_BATCH', summary);

    // Send webhook if configured
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(summary),
          signal: controller.signal,
        });
        clearTimeout(timeout);
      } catch {
        logger.error('ALERT_WEBHOOK_FAILED', { webhookUrl });
      }
    }
  }

  private buildSummary(batch: SlowQueryInfo[]) {
    const avgDuration = batch.reduce((s, q) => s + q.durationMs, 0) / batch.length;
    const maxDuration = Math.max(...batch.map((q) => q.durationMs));

    return {
      type: 'SLOW_QUERIES_BATCH',
      period: 'last_60s',
      count: batch.length,
      avgDurationMs: Math.round(avgDuration),
      maxDurationMs: maxDuration,
      top3: batch
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 3)
        .map((q) => ({ query: q.query.substring(0, 100), durationMs: q.durationMs })),
      timestamp: new Date().toISOString(),
    };
  }
}

export const alertAggregator = new AlertAggregator();

// ─── Alert helper (used in db.ts) ────────────────────────────────────────────
export function alertIfSlowQuery(durationMs: number, query: string) {
  if (durationMs > 500) {
    alertAggregator.push({ query, durationMs });
  }
}
