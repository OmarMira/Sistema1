'use client';

import { useLanguageStore } from '@/store/language-store';
import { useEffect } from 'react';

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const { language, _hasHydrated } = useLanguageStore();

  useEffect(() => {
    if (_hasHydrated) {
      document.cookie = `locale=${language}; path=/; max-age=31536000; SameSite=Lax`;
    }
  }, [language, _hasHydrated]);

  return <>{children}</>;
}
