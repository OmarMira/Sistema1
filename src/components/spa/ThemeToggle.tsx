'use client';

import { useTheme } from '@/components/providers/theme-provider';
import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguageStore } from '@/store/language-store';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const t = useLanguageStore((s) => s.t);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="size-9" disabled>
        <span className="sr-only">Toggle theme</span>
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          aria-label={t('common.themeToggleHint')}
        >
      {resolvedTheme === 'dark' ? (
        <Sun className="size-[1.2rem]" />
      ) : (
        <Moon className="size-[1.2rem]" />
      )}
          <span className="sr-only">{t('common.themeToggleHint')}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('common.themeToggleHint')}</TooltipContent>
    </Tooltip>
  );
}
