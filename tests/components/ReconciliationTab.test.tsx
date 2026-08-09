// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReconciliationTab } from '@/components/reports/ReconciliationTab';

afterEach(() => cleanup());

const tFn = (key: string) => key;
const mockLangState = { t: tFn, language: 'en' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (s: any) => any) => selector(mockLangState),
}));

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

vi.mock('@/lib/format', () => ({
  formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  formatDate: (d: string) => new Date(d).toISOString().split('T')[0] ?? '',
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: any) => (
    <select data-testid="bank-select" value={value ?? ''} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
  SelectTrigger: ({ children }: any) => <>{children}</>,
  SelectValue: () => null,
}));

describe('P10 — ReconciliationTab URL', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('construye el fetch de reconciliación con companyId y bankAccountId', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/dashboard')) {
        return {
          ok: true,
          json: async () => ({
            bankAccounts: [{ id: 'bank-a', accountName: 'Checking', bankName: 'BankA', balance: 100, currency: 'USD' }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          bankAccount: { id: 'bank-a', accountName: 'Checking', bankName: 'BankA', balance: 100, currency: 'USD' },
          summary: { totalTransactions: 0, reconciledCount: 0, unreconciledCount: 0, reconciledTotal: 0, unreconciledTotal: 0, reconciledPercentage: 0 },
          reconciledTransactions: [],
          unreconciledTransactions: [],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ReconciliationTab companyId="company-a" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/dashboard?companyId=company-a'));
    });

    await userEvent.selectOptions(screen.getByTestId('bank-select'), 'bank-a');

    await waitFor(() => {
      const call = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/api/reports/reconciliation'));
      expect(call).toBeTruthy();
      expect(call).toContain('companyId=company-a');
      expect(call).toContain('bankAccountId=bank-a');
    });
  });
});