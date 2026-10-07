// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useAccountingFlow,
  AccountingFlowQueryError,
} from '@/hooks/useAccountingFlow';

const OPTIONS = {
  companyId: 'company-test-1',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

describe('useAccountingFlow queryFn — typed error on !ok', () => {
  it('exposes status and code from the API error body', async () => {
    stubFetch(async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({
          error: 'Error interno del agregador',
          code: 'FLOW_AGGREGATION_FAILED',
        }),
      }) as unknown as Response,
    );

    const { result } = renderHook(() => useAccountingFlow(OPTIONS), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const error = result.current.error;
    expect(error).toBeInstanceOf(AccountingFlowQueryError);
    expect(error?.status).toBe(500);
    expect(error?.code).toBe('FLOW_AGGREGATION_FAILED');
    expect(error?.message).toBe('Error interno del agregador');
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the generic Spanish message when the body is absent or not JSON', async () => {
    stubFetch(async () =>
      ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response,
    );

    const { result } = renderHook(() => useAccountingFlow(OPTIONS), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const error = result.current.error;
    expect(error).toBeInstanceOf(AccountingFlowQueryError);
    expect(error?.status).toBe(502);
    expect(error?.code).toBeUndefined();
    expect(error?.message).toBe('Error al cargar el flujo contable');
    expect(result.current.data).toBeUndefined();
  });

  it('returns data on a successful response', async () => {
    const payload = {
      summary: {
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        totalInflows: 10,
        totalOutflows: 4,
        netFlow: 6,
        transactionCount: 2,
      },
      byPeriod: [],
      byAccount: [],
      transactions: [],
    };

    stubFetch(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => payload,
      }) as unknown as Response,
    );

    const { result } = renderHook(() => useAccountingFlow(OPTIONS), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual(payload);
  });
});
