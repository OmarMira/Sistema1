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

// ─── G12-3: Centralized secret redaction ────────────────────────────────────
const SENSITIVE_KEYS = /^(api[_-]?key|password|passwordHash|secret|token|authorization|webhookUrl|accessToken|refreshToken|keyPrefix|apiKeyPrefix|secretPrefix|tokenPrefix|keyFragment|secretFragment)$/i;

function redactValue(val: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    // Redact Slack webhook tokens (keep workspace path, mask token)
    if (val.includes('hooks.slack.com')) {
      return val.replace(/(services\/[A-Z0-9]+\/[A-Z0-9]+\/)[a-zA-Z0-9]+/, '$1[REDACTED]');
    }
    // Redact long hex/base64 strings that look like secrets (>32 chars, no spaces)
    if (val.length > 32 && !val.includes(' ') && /^[a-zA-Z0-9+/=_-]+$/.test(val)) {
      return '[REDACTED]';
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => redactValue(item, depth + 1));
  }
  if (typeof val === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(val)) {
      if (SENSITIVE_KEYS.test(key)) {
        copy[key] = '[REDACTED]';
      } else {
        copy[key] = redactValue(value, depth + 1);
      }
    }
    return copy;
  }
  return val;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const sanitized = meta ? redactValue(meta) as Record<string, unknown> : undefined;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(sanitized ?? {}),
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
