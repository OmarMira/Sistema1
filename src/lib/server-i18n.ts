import en from '@/i18n/locales/en';
import es from '@/i18n/locales/es';
import type { Locale } from '@/lib/i18n';

function dig(obj: Record<string, unknown>, key: string): string {
  const keys = key.split('.');
  let current: unknown = obj;
  for (const k of keys) {
    if (current && typeof current === 'object' && k in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[k];
    } else {
      return key;
    }
  }
  return typeof current === 'string' ? current : key;
}

const localeMap: Record<string, Record<string, unknown>> = { en, es };

export function serverT(locale: string | undefined, key: string): string {
  const lang = locale === 'en' ? 'en' : 'es';
  return dig(localeMap[lang], key);
}

export type { Locale };
