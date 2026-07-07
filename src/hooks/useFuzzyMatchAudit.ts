import { useMutation, useQueryClient } from '@tanstack/react-query';

export interface FuzzyMatchRequest {
  companyId: string;
  targetDescription: string;
  date: string;
  amount: number;
  minScore?: number;
  windowDays?: number;
}

export interface LinkTransactionRequest {
  bankTransactionId: string;
  journalLineId: string;
}

export function useFuzzyMatchAudit() {
  const queryClient = useQueryClient();

  // Mutación para buscar coincidencias difusas
  const fuzzyMatchMutation = useMutation({
    mutationFn: async (payload: FuzzyMatchRequest) => {
      const response = await fetch('/api/accounting-flow/audit/fuzzy-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Error al buscar coincidencias contables');
      }

      return response.json();
    },
  });

  // Mutación para vincular una transacción bancaria a un asiento contable
  const linkTransactionMutation = useMutation({
    mutationFn: async (payload: LinkTransactionRequest) => {
      const response = await fetch('/api/accounting-flow/audit/link', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || 'Error al vincular la transacción');
      }

      return response.json();
    },
    onSuccess: (_, variables) => {
      // Invalidar el flujo contable y las queries de conciliación relacionadas para refrescar los KPIs
      queryClient.invalidateQueries({ queryKey: ['accounting-flow'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  return {
    getFuzzyMatches: fuzzyMatchMutation.mutateAsync,
    isMatching: fuzzyMatchMutation.isPending,
    linkTransaction: linkTransactionMutation.mutateAsync,
    isLinking: linkTransactionMutation.isPending,
  };
}
