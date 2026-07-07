'use client';

import { useState, useCallback, useRef } from 'react';
import { fetchAddressSuggestions, type AddressData } from '@/lib/services/address-autocomplete';

export function useAddressAutocomplete() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<AddressData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleQueryChange = useCallback((val: string) => {
    setQuery(val);
    setSuggestions([]);
    setError(null);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!val || val.trim().length < 3) return;

    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await fetchAddressSuggestions(val);
        setSuggestions(results);
        if (results.length === 0) {
          setError('No se encontraron direcciones.');
        }
      } catch (err) {
        setError('Servicio de sugerencias no disponible.');
      } finally {
        setLoading(false);
      }
    }, 300); // 300ms debounce
  }, []);

  const selectSuggestion = useCallback((addr: AddressData) => {
    setQuery(addr.streetLine1);
    setSuggestions([]);
    return addr;
  }, []);

  const clear = useCallback(() => {
    setQuery('');
    setSuggestions([]);
    setLoading(false);
    setError(null);
  }, []);

  return {
    query,
    suggestions,
    loading,
    error,
    handleQueryChange,
    selectSuggestion,
    clear,
    setQuery,
  };
}
