/* eslint-disable no-console */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

  if (meta) {
    console[level](`${prefix} ${message}`, meta);
  } else {
    console[level](`${prefix} ${message}`);
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) =>
    log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) =>
    log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    log('error', message, meta),
  debug: (message: string, meta?: Record<string, unknown>) =>
    log('debug', message, meta),
};
