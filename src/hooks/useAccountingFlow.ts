import { useQuery } from '@tanstack/react-query';
import type { AccountingFlowResponse } from '../types/accounting-flow';

export interface UseAccountingFlowOptions {
  companyId?: string | null;
  startDate?: string;
  endDate?: string;
  enabled?: boolean;
}

/**
 * Typed error for /api/accounting-flow query failures.
 * Preserves the HTTP status and the machine-readable `code` from the API body
 * so the UI can render a precise error state instead of failing silently.
 */
export class AccountingFlowQueryError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message);
    this.name = 'AccountingFlowQueryError';
    this.status = options?.status;
    this.code = options?.code;
  }
}

export function useAccountingFlow({
  companyId,
  startDate,
  endDate,
  enabled = true,
}: UseAccountingFlowOptions) {
  return useQuery<AccountingFlowResponse, AccountingFlowQueryError>({
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
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          code?: string;
        } | null;
        throw new AccountingFlowQueryError(
          body?.error || 'Error al cargar el flujo contable',
          { status: response.status, code: body?.code },
        );
      }

      return response.json();
    },
    enabled: enabled && !!companyId && !!startDate && !!endDate,
    staleTime: 10 * 60 * 1000, // 10 minutos
    gcTime: 30 * 60 * 1000, // 30 minutos
  });
}
