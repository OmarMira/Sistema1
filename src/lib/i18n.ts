import en from '@/i18n/locales/en';
import es from '@/i18n/locales/es';

export type Locale = 'en' | 'es';

export const translations: Record<Locale, Record<string, unknown>> = {
  en,
  es,
} as Record<Locale, Record<string, unknown>>;

export const locales: Locale[] = ['en', 'es'];

export const defaultLocale: Locale = 'es';

export const localeNames: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
};

/**
 * Turn a missing translation key into something a human can read.
 *
 * A raw key must never reach the UI: `onboarding.step1.legalName` renders as
 * `legalName` (last segment, separators spelled out) instead of the dotted key.
 * This is a stopgap — the real fix is adding the key to both locales — but it
 * keeps the fallback honest and non-alarming.
 */
export function humanizeKey(key: string): string {
  const segments = key.split('.').filter((segment) => segment.trim() !== '');
  const last = segments[segments.length - 1] ?? key;
  return last.replace(/[_-]+/g, ' ').trim() || key;
}

/**
 * Look up a nested translation key like 'common.save' from a translation object.
 *
 * A miss returns `fallback` when it is a real string, and otherwise the
 * humanized key — never the raw dotted key.
 */
export function getTranslation(
  translations: Record<string, unknown>,
  key: string,
  fallback?: string,
): string {
  const keys = key.split('.');
  let current: unknown = translations;

  for (const k of keys) {
    if (current && typeof current === 'object' && k in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[k];
    } else {
      return resolveFallback(key, fallback);
    }
  }

  return typeof current === 'string' ? current : resolveFallback(key, fallback);
}

function resolveFallback(key: string, fallback?: string): string {
  // `t(key)` callers pass the key itself as the fallback; that is not a
  // translation, so it must be humanized like any other miss.
  if (fallback && fallback !== key) return fallback;
  return humanizeKey(key);
}
