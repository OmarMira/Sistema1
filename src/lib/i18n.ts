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
 * Look up a nested translation key like 'common.save' from a translation object.
 */
export function getTranslation(
  translations: Record<string, unknown>,
  key: string,
  fallback?: string
): string {
  const keys = key.split('.');
  let current: unknown = translations;

  for (const k of keys) {
    if (current && typeof current === 'object' && k in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[k];
    } else {
      return fallback ?? key;
    }
  }

  return typeof current === 'string' ? current : (fallback ?? key);
}
