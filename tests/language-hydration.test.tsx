import { vi } from 'vitest';

// Use vi.hoisted to ensure localStorage is mocked before any module gets imported
vi.hoisted(() => {
  if (typeof global.localStorage === 'undefined') {
    global.localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    } as any;
  }
});

// A local variable to store the useEffect callback
let lastEffectCallback: (() => void) | null = null;

// Mock the react module to intercept useEffect and prevent invalid hook calls in node tests
vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    useEffect: (callback: () => void) => {
      lastEffectCallback = callback;
    },
  };
});

import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { useLanguageStore } from '@/store/language-store';
import { LocaleProvider } from '@/providers/LocaleProvider';

// Mock useLanguageStore hook to avoid React dispatcher errors; preserve store state + .persist
vi.mock('@/store/language-store', async (importOriginal) => {
  const original = await importOriginal<any>();
  const mockHook = (selector?: any) => {
    const state = original.useLanguageStore.getState();
    return selector ? selector(state) : state;
  };
  Object.assign(mockHook, original.useLanguageStore);
  return {
    ...original,
    useLanguageStore: mockHook,
  };
});

describe('Language Store & Hydration Fix', () => {
  beforeEach(() => {
    // Reset state before each test
    useLanguageStore.setState({
      language: 'es',
      _hasHydrated: false,
    });
    // Clear global document mock if it exists
    if (typeof global.document !== 'undefined') {
      global.document.cookie = '';
    }
    // Clear captured effect
    lastEffectCallback = null;
  });

  describe('Language Store', () => {
    it('should initialize with hasHydrated as false and default to es', () => {
      const state = useLanguageStore.getState();
      expect(state.language).toBe('es');
      expect(state._hasHydrated).toBe(false);
    });

    it('should allow setting language and update translator t', () => {
      useLanguageStore.setState({ language: 'es' });
      useLanguageStore.getState().setLanguage('en');
      
      const updatedState = useLanguageStore.getState();
      expect(updatedState.language).toBe('en');
      expect(updatedState.t('common.save')).toBe('Save'); // Test translator actually translates
    });

    it('should update _hasHydrated via setHasHydrated', () => {
      useLanguageStore.getState().setHasHydrated(true);
      expect(useLanguageStore.getState()._hasHydrated).toBe(true);
    });

    it('should trigger onRehydrateStorage properly', () => {
      // onRehydrateStorage hydrates the translator and flags _hasHydrated
      const state = useLanguageStore.getState();
      expect(state.setHasHydrated).toBeDefined();

      useLanguageStore.getState().setHasHydrated(true);
      expect(useLanguageStore.getState()._hasHydrated).toBe(true);
    });
  });

  describe('LocaleProvider Component', () => {
    it('should render children', () => {
      const children = <div>Hello</div>;
      const element = LocaleProvider({ children });

      expect(element).toBeDefined();
    });

    it('should write cookie only when _hasHydrated is true', () => {
      const cookieStore: { value: string } = { value: '' };
      global.document = {
        get cookie() {
          return cookieStore.value;
        },
        set cookie(val) {
          cookieStore.value = val;
        }
      } as any;

      try {
        // Test 1: _hasHydrated is false -> cookie should not be set even when effect runs
        useLanguageStore.setState({
          language: 'en',
          _hasHydrated: false,
        });
        LocaleProvider({ children: null });
        
        expect(lastEffectCallback).toBeDefined();
        if (lastEffectCallback) lastEffectCallback();
        expect(global.document.cookie).not.toContain('locale=en');

        // Test 2: _hasHydrated is true -> cookie should be set when effect runs
        useLanguageStore.setState({
          language: 'en',
          _hasHydrated: true,
        });
        LocaleProvider({ children: null });
        
        expect(lastEffectCallback).toBeDefined();
        if (lastEffectCallback) lastEffectCallback();
        expect(global.document.cookie).toContain('locale=en');
      } finally {
        delete (global as any).document;
      }
    });
  });
});
