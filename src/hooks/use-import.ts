import { useState } from 'react';

export function useImport() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<Record<string, unknown> | null>(null);

  const importFile = async (file: File, companyId: string, bankAccountId: string | null) => {
    setIsLoading(true);
    setError(null);
    setSuccessData(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('companyId', companyId);
      if (bankAccountId) {
        formData.append('bankAccountId', bankAccountId);
      }

      const res = await fetch('/api/import', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to import file');
      }
      setSuccessData(data);
      return data;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    error,
    successData,
    importFile,
  };
}
