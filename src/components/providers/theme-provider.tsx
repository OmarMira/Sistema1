'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeValue {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeValue>({
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => {},
});

function getSystem(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
}

function apply(r: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', r === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem('theme') as Theme) || 'system';
    const r = stored === 'system' ? getSystem() : stored;
    setTheme(stored);
    setResolved(r);
    apply(r);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const r = theme === 'system' ? getSystem() : theme;
    setResolved(r);
    apply(r);
    localStorage.setItem('theme', theme);
  }, [theme, ready]);

  useEffect(() => {
    if (!ready || theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme:dark)');
    const h = () => { const r = getSystem(); setResolved(r); apply(r); };
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [ready, theme]);

  return (
    <Ctx.Provider value={{ theme, resolvedTheme: resolved, setTheme }}>
      {children}
    </Ctx.Provider>
  );
}

export const useTheme = () => useContext(Ctx);
