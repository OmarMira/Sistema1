import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

export function usePredictiveSuggestions(companyId: string, bankAccountId: string) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['predictive-suggestions', companyId, bankAccountId],
    queryFn: () =>
      fetch(
        `/api/reconciliation/predictive-suggestions?companyId=${companyId}&bankAccountId=${bankAccountId}`,
      ).then((r) => r.json()),
    refetchInterval: 60000,
    enabled: !!companyId && !!bankAccountId,
  });

  const applySuggestion = useMutation({
    mutationFn: async (payload: {
      bankTxId: string;
      journalEntryId: string;
      confidence: number;
    }) => {
      const res = await fetch('/api/accounting-flow/audit/link', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, companyId, bankAccountId, source: 'predictive' }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['predictive-suggestions'] });
      queryClient.invalidateQueries({ queryKey: ['reconciliation-data'] });
      toast.success('✅ Sugerencia predictiva aplicada');
    },
    onError: () => toast.error('Error aplicando sugerencia'),
  });

  return { suggestions: data?.suggestions || [], isLoading, applySuggestion };
}
