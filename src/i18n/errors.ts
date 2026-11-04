import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';

/**
 * S3 — translating API errors without teaching the backend the locale.
 *
 * The server answers with `{ error, code, details }`:
 *   - `error` is the human message (Spanish today, and it stays the fallback),
 *   - `code` is the machine code of the error family
 *     (`VALIDATION_ERROR`, `FORBIDDEN`, `DATABASE_ERROR`, `IMPORT_TIMEOUT`…),
 *   - `details.code` (when present) carries the SPECIFIC reason for errors whose
 *     family code is too coarse to translate — e.g. the fiscal guard answers
 *     `403 FORBIDDEN` plus `details.code: 'FISCAL_PERIOD_LOCKED'`, keeping the
 *     historical `code` contract intact for existing clients.
 *
 * The frontend resolves those codes against the locale catalogs under
 * `errors.<CODE>` in the language the user selected. A code without a catalog
 * entry falls back to the SERVER message — never to a raw key, and never to a
 * generic text that would hide the server's detail.
 */
export interface ApiErrorPayload {
  error?: unknown;
  code?: unknown;
  details?: unknown;
}

/** Translator signature shared with the language store (`t`). */
export type ErrorTranslator = (key: string) => string;

type ErrorCatalog = Record<string, unknown>;

function errorCatalog(locale: unknown): ErrorCatalog {
  const errors = (locale as { errors?: unknown } | null | undefined)?.errors;
  return errors !== null && typeof errors === 'object' ? (errors as ErrorCatalog) : {};
}

/**
 * Every code the UI can translate. Keys are locale-independent, and the locale
 * parity test keeps `es` and `en` declaring the same set, so building the set
 * from both catalogs can never accept a half-translated code.
 */
const TRANSLATED_ERROR_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(errorCatalog(es)),
  ...Object.keys(errorCatalog(en)),
]);

/** True when `errors.<code>` exists, i.e. the code renders in both locales. */
export function isTranslatedErrorCode(code: unknown): code is string {
  return typeof code === 'string' && TRANSLATED_ERROR_CODES.has(code);
}

/** The specific reason (`details.code`) first, then the family `code`. */
export function apiErrorCodes(payload: ApiErrorPayload | null | undefined): string[] {
  const codes: string[] = [];

  const details = payload?.details;
  const specific =
    details !== null && typeof details === 'object'
      ? (details as { code?: unknown }).code
      : undefined;
  if (typeof specific === 'string' && specific.trim() !== '') codes.push(specific);

  const family = payload?.code;
  if (typeof family === 'string' && family.trim() !== '' && !codes.includes(family)) {
    codes.push(family);
  }

  return codes;
}

/**
 * Locale message for a known error code, or the server message verbatim.
 *
 * @param payload   Parsed response body (`{ error, code, details }`).
 * @param t         Translator for the selected locale.
 * @param fallback  Optional message to use when the body has no message either.
 */
export function translateApiError(
  payload: ApiErrorPayload | null | undefined,
  t: ErrorTranslator,
  fallback?: string,
): string {
  for (const code of apiErrorCodes(payload)) {
    if (isTranslatedErrorCode(code)) return t(`errors.${code}`);
  }

  const serverMessage = payload?.error;
  if (typeof serverMessage === 'string' && serverMessage.trim() !== '') return serverMessage;

  return fallback ?? t('common.error');
}
