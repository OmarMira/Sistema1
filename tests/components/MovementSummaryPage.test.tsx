// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MovementSummaryPage } from '@/components/spa/MovementSummaryPage';
import { useAuthStore } from '@/store/auth-store';

afterEach(() => cleanup());

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
}

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
      const safe: Record<string, unknown> = {};
      for (const key of Object.keys(props)) {
        if (['variants', 'initial', 'animate', 'exit', 'transition', 'custom', 'layout'].includes(key)) continue;
        safe[key] = props[key];
      }
      return <div {...safe}>{children}</div>;
    },
  },
}));

const RANGE_ONLY_RE = 'rangeOnly=true';

const summaryPayload = {
  summary: {
    totalDebits: 1500.5,
    totalCredits: 900.25,
    netMovement: 600.25,
    transactionCount: 42,
  },
  byAccount: [
    {
      accountId: 'acc-1',
      accountCode: '1010',
      accountName: 'Caja',
      accountType: 'asset',
      debits: 1500.5,
      credits: 900.25,
      net: 600.25,
    },
  ],
  byType: [{ type: 'asset', debits: 1500.5, credits: 900.25, net: 600.25 }],
  recentMovements: [
    {
      id: 'mv-1',
      date: '2026-01-15',
      description: 'Ingreso inicial',
      debit: 1500.5,
      credit: 0,
      account: 'Caja',
      reference: 'REF-1',
    },
  ],
};

function okResponse(json: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(json) };
}

function errorResponse(status: number, json: unknown) {
  return { ok: false, status, json: () => Promise.resolve(json) };
}

const mockFetch = vi.fn();

function requestedUrls(): string[] {
  return mockFetch.mock.calls.map((call) => String(call[0]));
}

function mainSummaryCalls(): string[] {
  return requestedUrls().filter((u) => u.includes('/api/movement-summary?') && !u.includes(RANGE_ONLY_RE));
}

describe('MovementSummaryPage fetch orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    useAuthStore.setState({
      activeCompany: {
        id: 'company-1',
        legalName: 'Test Co',
        taxId: null,
        isOnboardingComplete: true,
      },
    });
  });

  it('unblocks the main fetch when the rangeOnly boundaries request fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes(RANGE_ONLY_RE)) {
        return Promise.resolve(errorResponse(500, { error: 'boom' }));
      }
      if (url.includes('/api/journal/accounts')) {
        return Promise.resolve(okResponse({ data: [] }));
      }
      if (url.includes('/api/movement-summary?')) {
        return Promise.resolve(okResponse(summaryPayload));
      }
      return Promise.resolve(okResponse({}));
    });

    render(<MovementSummaryPage />);

    await waitFor(() => {
      expect(mainSummaryCalls().length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument();
    });

    expect(screen.getByText('Por Cuenta')).toBeInTheDocument();
    expect(screen.queryByText(/No se pudo cargar el resumen de movimientos/)).not.toBeInTheDocument();
  });

  it('shows a retryable banner with status detail when the main fetch fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes(RANGE_ONLY_RE)) {
        return Promise.resolve(okResponse({ minDate: '2026-01-01', maxDate: '2026-01-31' }));
      }
      if (url.includes('/api/journal/accounts')) {
        return Promise.resolve(okResponse({ data: [] }));
      }
      if (url.includes('/api/movement-summary?')) {
        return Promise.resolve(errorResponse(500, { error: 'boom' }));
      }
      return Promise.resolve(okResponse({}));
    });

    render(<MovementSummaryPage />);

    await waitFor(() => {
      expect(
        screen.getByText('No se pudo cargar el resumen de movimientos (HTTP 500) — boom'),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Reintentar/ })).toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
  });
});
