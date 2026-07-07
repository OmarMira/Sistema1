import { useQuery } from '@tanstack/react-query';
import type { AccountingFlowResponse } from '../types/accounting-flow';

export interface UseAccountingFlowOptions {
  companyId?: string | null;
  startDate?: string;
  endDate?: string;
  enabled?: boolean;
}

export function useAccountingFlow({
  companyId,
  startDate,
  endDate,
  enabled = true,
}: UseAccountingFlowOptions) {
  return useQuery<AccountingFlowResponse>({
    queryKey: ['accounting-flow', companyId, startDate, endDate],
    queryFn: async () => {
      if (!companyId || !startDate || !endDate) {
        throw new Error('Parámetros requeridos ausentes');
      }

      const params = new URLSearchParams({
        companyId,
        startDate,
        endDate,
      });

      const response = await fetch(`/api/accounting-flow?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Error al cargar el flujo contable');
      }

      return response.json();
    },
    enabled: enabled && !!companyId && !!startDate && !!endDate,
    staleTime: 10 * 60 * 1000, // 10 minutos
    gcTime: 30 * 60 * 1000, // 30 minutos
  });
}
