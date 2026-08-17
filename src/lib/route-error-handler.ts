// ─── Route-Level Error Handler ──────────────────────────────────────────────
// Shared utility for catch blocks in API routes.
// Re-throws AppError (letting apiHandler handle typed errors with correct status codes).
// Returns generic 500 for unknown errors with safe logging.

import { NextResponse } from 'next/server';
import { AppError } from './api-error';
import { logger } from './logger';

/**
 * Extract a safe error message for logging.
 *
 * SECURITY RULE: error.message is UNTRUSTED content. It can contain connection
 * strings, SQL queries, file paths, tokens, credentials, or other sensitive data.
 * We NEVER log error.message for unknown/technical errors.
 *
 * - AppError: message is safe (business logic: "Validation failed", "Unauthorized")
 * - Other Error subclasses: only log name (message is untrusted)
 * - Non-Error values: log as-is (they're not Error objects, likely safe strings)
 */
function safeErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) {
    // Technical errors — only log name, never message (untrusted content)
    return error.name;
  }
  return String(error);
}

/**
 * Handle errors in route-level catch blocks.
 *
 * - Re-throws AppError/ValidationError so apiHandler returns correct status codes
 * - Returns generic 500 for unknown errors
 * - Logs with endpoint-specific tag for observability
 *
 * SECURITY: For unknown errors, only error.name is logged (never error.message),
 * because error.message is untrusted content that may contain connection strings,
 * SQL, file paths, tokens, or credentials.
 */
export function handleRouteError(
  error: unknown,
  logTag: string,
  genericMessage: string = 'Internal server error',
): NextResponse | never {
  // Log with safe error message (no stack traces, no sensitive details)
  logger.error(logTag, { error: safeErrorMessage(error) });

  // Re-throw AppError so apiHandler handles it with correct status code
  if (error instanceof AppError) {
    throw error;
  }

  // Return generic 500 for unknown errors
  return NextResponse.json({ error: genericMessage }, { status: 500 });
}
