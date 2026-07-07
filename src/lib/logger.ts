// ─── Structured Logger ───────────────────────────────────────────────────────
// JSON-structured logging for production. Compatible with CloudWatch, Datadog, Loki, Sentry.
// In development: also outputs to console for visibility.

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  // JSON structured output — machine-parseable for log aggregators
   
  const output = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  output(JSON.stringify(entry));
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),

  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),

  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),

  slowQuery: (query: string, durationMs: number) => {
    log('warn', 'SLOW_QUERY', {
      query: query.substring(0, 200),
      durationMs,
    });
  },
};
