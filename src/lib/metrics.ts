import { logger } from './logger';
// ─── Metrics Ring Buffer ─────────────────────────────────────────────────────
// Bounded in-memory metrics collection. MAX_METRICS entries per buffer (~200KB total).
// Metrics reset on server restart (by design — see README Observabilidad section).

export interface QueryMetric {
  query: string;
  durationMs: number;
  timestamp: number;
}

export interface APIMetric {
  route: string;
  method: string;
  durationMs: number;
  timestamp: number;
}

export interface PDFMetric {
  fileName: string;
  durationMs: number;
  timestamp: number;
}

const MAX_METRICS = 1000;

class MetricsBuffer<T> {
  private buffer: T[] = [];
  private index = 0;

  push(metric: T) {
    if (this.buffer.length < MAX_METRICS) {
      this.buffer.push(metric);
    } else {
      this.buffer[this.index] = metric;
      this.index = (this.index + 1) % MAX_METRICS;
    }
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  clear() {
    this.buffer = [];
    this.index = 0;
  }

  get size(): number {
    return this.buffer.length;
  }
}

export const metrics = {
  queries: new MetricsBuffer<QueryMetric>(),
  apiRequests: new MetricsBuffer<APIMetric>(),
  pdfParses: new MetricsBuffer<PDFMetric>(),
};

export function trackQueryDuration(query: string, durationMs: number) {
  metrics.queries.push({
    query: query.substring(0, 200),
    durationMs,
    timestamp: Date.now(),
  });
}

export function trackAPIResponseTime(route: string, method: string, durationMs: number) {
  metrics.apiRequests.push({
    route,
    method,
    durationMs,
    timestamp: Date.now(),
  });
}

export function trackPDFParseDuration(fileName: string, durationMs: number) {
  metrics.pdfParses.push({
    fileName,
    durationMs,
    timestamp: Date.now(),
  });
}

export function calculatePercentiles(values: number[]) {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, count: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const len = sorted.length;

  return {
    p50: sorted[Math.floor(len * 0.5)] || 0,
    p95: sorted[Math.floor(len * 0.95)] || 0,
    p99: sorted[Math.floor(len * 0.99)] || 0,
    count: len,
  };
}

export function getMetricsSummary() {
  const queryDurations = metrics.queries.getAll().map((q) => q.durationMs);
  const apiDurations = metrics.apiRequests.getAll().map((a) => a.durationMs);
  const pdfDurations = metrics.pdfParses.getAll().map((p) => p.durationMs);

  const slowQueries = metrics.queries
    .getAll()
    .filter((q) => q.durationMs > 100)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);

  return {
    queries: {
      ...calculatePercentiles(queryDurations),
      slowQueries,
    },
    api: calculatePercentiles(apiDurations),
    pdf: {
      ...calculatePercentiles(pdfDurations),
      totalParsed: metrics.pdfParses.size,
    },
    collectedAt: new Date().toISOString(),
  };
}

export function resetMetrics() {
  metrics.queries.clear();
  metrics.apiRequests.clear();
  metrics.pdfParses.clear();
  logger.info('📊 Metrics reset (server restart detected)');
}
