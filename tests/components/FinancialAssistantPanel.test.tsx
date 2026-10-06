// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FinancialAssistantPanel } from '@/components/assistant/FinancialAssistantPanel';

// Real component + real react-query; only hooks/stores and fetch are mocked.
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'owner' } }),
}));
vi.mock('@/hooks/useRBAC', () => ({
  useRBAC: () => true,
}));
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: { activeCompany: { id: string; role: string } | null }) => unknown) =>
    selector({ activeCompany: { id: 'c1', role: 'owner' } }),
}));
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: { language: string }) => unknown) =>
    selector({ language: 'en' }),
}));

const INSIGHTS = [
  {
    id: 'cash_trend',
    type: 'cash_trend',
    severity: 'info',
    message: 'Cash flow trend: 3 periods analyzed.',
    context: { '2026-10': 32615.55, '2026-09': -1200 },
  },
  {
    id: 'budget_6100',
    type: 'budget_alert',
    severity: 'warning',
    message: 'Budget deviation alert',
    context: { code: '6100', budget: 1500, actual: 1860, variance: 0.24 },
  },
  {
    id: 'unreconciled',
    type: 'recon_alert',
    severity: 'critical',
    message: '12 bank transactions unreconciled',
    context: { count: 12 },
  },
];

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FinancialAssistantPanel companyId="c1" />
    </QueryClientProvider>,
  );
}

describe('FinancialAssistantPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ insights: INSIGHTS }) })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders insight messages with severity badges', async () => {
    renderPanel();
    expect(await screen.findByText('Cash flow trend: 3 periods analyzed.')).toBeInTheDocument();
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
  });

  it('renders context as readable key-value text, not raw JSON', async () => {
    renderPanel();
    // cash_trend: date keys with locale-formatted numbers
    expect(await screen.findByText(/2026-10: 32,615\.55/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09: -1,200/)).toBeInTheDocument();
    // budget_alert: localized labels, variance rendered as a percentage
    expect(screen.getByText(/Account: 6100/)).toBeInTheDocument();
    expect(screen.getByText(/Budget: 1,500/)).toBeInTheDocument();
    expect(screen.getByText(/Variance: 24%/)).toBeInTheDocument();
    // recon_alert
    expect(screen.getByText(/Pending: 12/)).toBeInTheDocument();
  });

  it('never shows the debug Ref label or raw JSON braces', async () => {
    renderPanel();
    await screen.findByText(/2026-10: 32,615\.55/);
    expect(screen.queryByText(/Ref:/)).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('{"');
  });
});
