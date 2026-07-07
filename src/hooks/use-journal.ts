import { useState, useCallback } from 'react';

export function useJournal() {
  const [entries, setEntries] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = useCallback(async (companyId: string, filters: Record<string, string> = {}) => {
    if (!companyId) return;
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ companyId, ...filters });
      const res = await fetch(`/api/journal?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch journal entries');
      }
      setEntries(data.data || []);
      setTotal(data.pagination?.total || 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createEntry = async (entryData: Record<string, unknown>) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entryData),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create journal entry');
      }
      return data;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    entries,
    total,
    isLoading,
    error,
    fetchEntries,
    createEntry,
  };
}
