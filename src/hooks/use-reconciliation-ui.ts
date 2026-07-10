import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback } from 'react';
import { toast } from 'sonner';

export type ReconciliationConfig = {
  layout: { splitViewRatio: number; visibleColumns: string[] };
  matching: { fuzzyThreshold: number; amountTolerance: number; dateWindowDays: number };
  actions: { blockActionsOnLockedPeriods: boolean; allowedRoles: string[] };
  ui: { disclaimerText: string };
};

export function useReconciliationUI(companyId: string, bankAccountId: string) {
  const queryClient = useQueryClient();
  const [selectedBankTx, setSelectedBankTx] = useState<string[]>([]);
  const [selectedJournalEntry, setSelectedJournalEntry] = useState<string | null>(null);

  // 1. Cargar configuración
  const { data: configData, isLoading: loadingConfig } = useQuery({
    queryKey: ['reconciliation-ui-config'],
    queryFn: () => fetch('/api/config/reconciliation-ui').then((r) => r.json()),
  });
  const config = configData?.config as ReconciliationConfig;

  // 2. Cargar datos de conciliación
  const { data, isLoading, error } = useQuery({
    queryKey: ['reconciliation-data', companyId, bankAccountId],
    queryFn: () =>
      fetch(`/api/reconciliation?companyId=${companyId}&bankAccountId=${bankAccountId}`).then((r) =>
        r.json(),
      ),
    enabled: !!companyId && !!bankAccountId,
    refetchOnWindowFocus: false,
  });

  // 3. Mutación: Vincular transacciones
  const linkMutation = useMutation({
    mutationFn: async (payload: {
      bankTxIds: string[];
      journalEntryId: string;
      notes?: string;
    }) => {
      const res = await fetch('/api/accounting-flow/audit/link', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, companyId, bankAccountId }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation-data'] });
      toast.success('Transacciones vinculadas correctamente');
      setSelectedBankTx([]);
      setSelectedJournalEntry(null);
    },
    onError: (err: unknown) => toast.error((err as Error).message),
  });

  // 4. Validación de seguridad antes de ejecutar
  const canExecuteAction = useCallback(
    (action: 'link' | 'adjust') => {
      if (!data?.openPeriod && config?.actions.blockActionsOnLockedPeriods) {
        toast.warning('Acción bloqueada: No hay un período de conciliación abierto.');
        return false;
      }
      if (action === 'link' && selectedBankTx.length === 0) {
        toast.warning('Selecciona al menos una transacción bancaria.');
        return false;
      }
      if (action === 'link' && !selectedJournalEntry) {
        toast.warning('Selecciona un asiento contable posteado.');
        return false;
      }
      return true;
    },
    [config, data, selectedBankTx, selectedJournalEntry],
  );

  return {
    config,
    data,
    isLoading: isLoading || loadingConfig,
    error,
    selectedBankTx,
    setSelectedBankTx,
    selectedJournalEntry,
    setSelectedJournalEntry,
    linkMutation,
    canExecuteAction,
  };
}
