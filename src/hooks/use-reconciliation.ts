import { useState, useCallback } from 'react';

export function useReconciliation() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReconciliation = useCallback(
    async (companyId: string, bankAccountId: string, filters: Record<string, string> = {}) => {
      if (!companyId || !bankAccountId) return;
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ companyId, bankAccountId, ...filters });
        const res = await fetch(`/api/reconciliation?${params.toString()}`);
        const result = await res.json();
        if (!res.ok) {
          throw new Error(result.error || 'Failed to fetch reconciliation data');
        }
        setData(result);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const reconcile = async (payload: Record<string, unknown>) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || 'Failed to reconcile transactions');
      }
      return result;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    data,
    isLoading,
    error,
    fetchReconciliation,
    reconcile,
  };
}
