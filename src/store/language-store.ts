import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { translations, type Locale } from '@/lib/i18n';
import { getTranslation } from '@/lib/i18n';

interface LanguageState {
  language: Locale;
  setLanguage: (lang: Locale) => void;
  t: (key: string) => string;
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set, get) => ({
      language: 'es' as Locale,

      setLanguage: (lang: Locale) => {
        const localeTranslations = translations[lang] as Record<string, unknown>;
        const newT = (key: string): string => getTranslation(localeTranslations, key, key);
        set({ language: lang, t: newT });
      },

      t: (key: string): string => {
        const { language } = get();
        const localeTranslations = translations[language] as Record<string, unknown>;
        return getTranslation(localeTranslations, key, key);
      },
    }),
    {
      name: 'accountexpress-language',
      partialize: (state) => ({ language: state.language }),
    }
  )
);
