// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DashboardPage } from '@/components/spa/DashboardPage';
import { AccountingFlowQueryError } from '@/hooks/useAccountingFlow';

const hookState = vi.hoisted(() => ({
  current: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
}));

vi.mock('@/hooks/useAccountingFlow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAccountingFlow')>();
  return {
    ...actual,
    useAccountingFlow: () => hookState.current,
  };
});

vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: { t: (k: string) => string; language: string }) => unknown) =>
    selector({ t: (k: string) => k, language: 'es' }),
}));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: { activeCompany: { id: string } | null; setCurrentView: () => void }) => unknown) =>
    selector({ activeCompany: { id: 'company-1' }, setCurrentView: vi.fn() }),
}));

vi.mock('@/components/accounting-flow/FlowKpiCards', () => ({
  FlowKpiCards: () => <div data-testid="flow-kpis" />,
}));

vi.mock('@/components/audit/AuditSection', () => ({
  AuditSection: () => <div data-testid="audit-section" />,
}));

vi.mock('@/components/assistant/FinancialAssistantPanel', () => ({
  FinancialAssistantPanel: () => null,
}));

vi.mock('@/components/spa/UtcEducationalModal', () => ({
  UtcEducationalModal: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/dashboard/DashboardPageBlocks', () => ({
  StatCard: () => null,
  SummaryMiniCards: () => null,
  BalanceChartCard: () => null,
  MonthlyTrendChartCard: () => null,
  RecentTransactionsTable: () => null,
  BankAccountsCard: () => null,
  QuickActionsCard: () => null,
  containerVariants: { hidden: {}, show: {} },
  itemVariants: { hidden: {}, show: {} },
}));

function flowSummary() {
  return {
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    totalInflows: 100,
    totalOutflows: 40,
    netFlow: 60,
    transactionCount: 3,
  };
}

beforeEach(() => {
  hookState.current = {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
});

describe('DashboardPage — accounting flow error state', () => {
  it('renders the error card with code and a retry action when the query failed with no data', () => {
    const refetch = vi.fn();
    hookState.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new AccountingFlowQueryError('boom', {
        status: 500,
        code: 'FLOW_AGGREGATION_FAILED',
      }),
      refetch,
    };

    render(<DashboardPage />);

    expect(screen.getByText('dashboard.flowLoadError')).toBeInTheDocument();
    expect(screen.getByText('FLOW_AGGREGATION_FAILED')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-kpis')).toBeNull();

    fireEvent.click(screen.getByText('common.retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps showing stale flow data when a background refetch failed (data over banner)', () => {
    hookState.current = {
      data: { summary: flowSummary(), byPeriod: [], byAccount: [], transactions: [] },
      isLoading: false,
      isError: true,
      error: new AccountingFlowQueryError('boom', {
        status: 500,
        code: 'FLOW_AGGREGATION_FAILED',
      }),
      refetch: vi.fn(),
    };

    render(<DashboardPage />);

    expect(screen.getByTestId('flow-kpis')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.flowLoadError')).toBeNull();
    expect(screen.queryByText('common.retry')).toBeNull();
  });

  it('renders the flow KPIs normally when the query succeeded', () => {
    hookState.current = {
      data: { summary: flowSummary(), byPeriod: [], byAccount: [], transactions: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };

    render(<DashboardPage />);

    expect(screen.getByTestId('flow-kpis')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.flowLoadError')).toBeNull();
  });
});
