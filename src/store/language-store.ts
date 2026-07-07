import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { translations, type Locale } from '@/lib/i18n';
import { getTranslation } from '@/lib/i18n';

interface LanguageState {
  language: Locale;
  setLanguage: (lang: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  _hasHydrated: boolean;
  setHasHydrated: (state: boolean) => void;
}

const createTranslator =
  (lang: Locale) =>
  (key: string, params?: Record<string, string | number>): string => {
    const localeTranslations = translations[lang] as Record<string, unknown>;
    let result = getTranslation(localeTranslations, key, key);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return result;
  };

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set, get) => ({
      language: 'es' as Locale,
      _hasHydrated: false,

      setLanguage: (lang: Locale) =>
        set({
          language: lang,
          t: createTranslator(lang),
        }),

      setHasHydrated: (state: boolean) =>
        set({
          _hasHydrated: state,
        }),

      t: createTranslator('es' as Locale),
    }),
    {
      name: 'accountexpress-language',
      partialize: (state) => ({ language: state.language }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.t = createTranslator(state.language);
          state.setHasHydrated(true);
        }
      },
    },
  ),
);
