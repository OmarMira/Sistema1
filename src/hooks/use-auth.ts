import { useAuthStore } from '@/store/auth-store';
import { useState } from 'react';

export function useAuth() {
  const store = useAuthStore();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async (email: string, password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to login');
      }
      store.login(data.user);
      store.setActiveCompany(null);
      store.setCurrentView('select-company');
      return data;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (input: Record<string, unknown>) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to register');
      }
      store.login(data.user);
      if (data.companies && data.companies.length > 0) {
        store.setActiveCompany(data.companies[0]);
        store.setCurrentView('dashboard');
      }
      return data;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      store.logout();
    } finally {
      setIsLoading(false);
    }
  };

  return {
    ...store,
    isLoading,
    error,
    login,
    register,
    logout,
  };
}
