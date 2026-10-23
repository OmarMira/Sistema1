import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { FinancialDashboardPage } from '@/components/spa/FinancialDashboardPage';
import { useLanguageStore } from '@/store/language-store';
const state = vi.hoisted(() => ({
  activeCompany: {
    id: 'company-test',
    legalName: 'Example LLC'
  },
  setCurrentView: vi.fn()
}));
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (select: (s: typeof state) => unknown) => select(state)
}));
const fetchMock = vi.fn();
function fixture(classified = false) {
  const transactions = Array.from({
    length: 302
  }, (_, i) => {
    const credit = i < 128;
    const month = String(i % 12 + 1).padStart(2, '0');
    return {
      id: `tx-${i}`,
      statementId: `s-${month}`,
      fecha: `2025-${month}-02`,
      descripcion: `Movement ${i}`,
      monto: credit ? i === 127 ? 3140.23 : 800 : i === 301 ? 6603.08 : 700,
      tipo: credit ? 'credito' : 'debito',
      cuenta_contable: classified ? '4000 Example' : '',
      categoria: classified ? 'Example' : '',
      glAccountName: classified ? 'Example' : null,
      conciliado: false,
      ignored: false
    };
  });
  let balance = 3261555;
  const statements = Array.from({
    length: 12
  }, (_, i) => {
    const month = String(i + 1).padStart(2, '0');
    const openingBalance = balance / 100;
    for (const tx of transactions.filter(t => t.statementId === `s-${month}`)) balance += Math.round(tx.monto * 100) * (tx.tipo === 'credito' ? 1 : -1);
    return {
      id: `s-${month}`,
      startDate: `2025-${month}-01`,
      endDate: `2025-${month}-${new Date(Date.UTC(2025, i + 1, 0)).getUTCDate()}`,
      openingBalance,
      closingBalance: balance / 100
    };
  });
  const account = {
    id: 'bank-test',
    accountName: 'Example Bank',
    bankName: 'Example Bank',
    currency: 'USD'
  };
  return {
    account,
    accounts: [account],
    years: [2025],
    year: 2025,
    statements,
    transactions,
    total: transactions.length,
    hasMore: false,
    nextCursor: null,
    initialBalance: 32615.55,
    currentBalance: 9652.70,
    bankAccountInfo: account
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useLanguageStore.getState().setLanguage('es');
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: (entries: {
      contentRect: {
        width: number;
        height: number;
      };
    }[]) => void) {}
    observe() {
      this.callback([{
        contentRect: {
          width: 600,
          height: 250
        }
      }]);
    }
    unobserve() {}
    disconnect() {}
  });
  fetchMock.mockImplementation(async () => ({
    ok: true,
    json: async () => fixture()
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function open() {
  render(<FinancialDashboardPage />);
  return screen.findByRole('region', {
    name: 'Actividad bancaria del período'
  });
}
it('includes all 302 unclassified and unreconciled movements in actual bank inflows and outflows', async () => {
  const activity = await open();
  expect(activity.textContent).toContain('$104,740.23');
  expect(activity.textContent).toContain('$127,703.08');
  expect(activity.textContent).toContain('-$22,962.85');
  expect(screen.getByText(/302 de 302 movimientos/)).toBeTruthy();
  expect(screen.getByText(/Sin clasificación guardada: 302/)).toBeTruthy();
  expect(screen.getByText(/Pendientes de conciliación: 302/)).toBeTruthy();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
it('uses the same theme cards as the Panel instead of a separate bank-page palette', async () => {
  await open();
  for (const name of ['Cuenta y período', 'Saldos de los extractos', 'Actividad bancaria del período']) {
    const surface = screen.getByRole('region', {
      name
    });
    expect(surface.getAttribute('data-slot')).toBe('card');
    expect(surface.classList.contains('bg-card')).toBe(true);
    expect(surface.className).not.toMatch(/bg-white|bg-slate-|border-slate-/);
  }
  const charts = screen.getByRole('region', {
    name: 'Gráficos de la actividad bancaria'
  });
  for (const figure of within(charts).getAllByRole('figure')) {
    expect(figure.closest('[data-slot="card"]')?.classList.contains('bg-card')).toBe(true);
  }
});
it('sizes the bank-account selector to its selected name and preserves account selection', async () => {
  const primary = fixture().account;
  const secondary = { ...primary, id: 'bank-other', bankName: 'Second Bank', accountName: 'Reserve account' };
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({ ...fixture(), accounts: [primary, secondary], account: url.includes('accountId=bank-other') ? secondary : primary })
  }));
  await open();
  const account = screen.getByLabelText('Cuenta bancaria') as HTMLSelectElement;
  expect(account.classList.contains('w-full')).toBe(false);
  expect(account.classList.contains('[field-sizing:content]')).toBe(true);
  expect(account.classList.contains('max-w-full')).toBe(true);
  expect(account.classList.contains('min-w-0')).toBe(true);
  expect(account.closest('label')!.classList.contains('flex')).toBe(true);
  expect(screen.getByRole('region', { name: 'Cuenta y período' }).classList.contains('grid-cols-1')).toBe(true);
  fireEvent.change(account, { target: { value: 'bank-other' } });
  await screen.findByRole('heading', { name: 'Second Bank — Reserve account' });
  const selected = screen.getByLabelText('Cuenta bancaria') as HTMLSelectElement;
  expect(selected.value).toBe('bank-other');
  expect(selected.selectedOptions[0].textContent).toBe('Second Bank — Reserve account (USD)');
  expect(fetchMock.mock.calls.some(([url]) => url.includes('accountId=bank-other'))).toBe(true);
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
it('sizes the movement-year selector to its label and preserves year selection', async () => {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({
      ...fixture(),
      years: [2025, 2024],
      ...(url.includes('year=2024') ? {
        year: 2024,
        transactions: [],
        statements: [],
        total: 0
      } : {})
    })
  }));
  await open();
  const year = screen.getByLabelText('Año de los movimientos');
  expect(year.classList.contains('w-full')).toBe(true);
  const label = year.closest('label')!;
  expect(label.classList.contains('grid')).toBe(true);
  expect(label.classList.contains('w-max')).toBe(true);
  expect(within(label).getByText('Año de los movimientos').tagName).toBe('SPAN');
  fireEvent.change(year, {
    target: {
      value: '2024'
    }
  });
  await screen.findByText('No hay movimientos importados para esta cuenta y este año.');
  expect(fetchMock.mock.calls.some(([url]) => url.includes('year=2024'))).toBe(true);
  expect((screen.getByLabelText('Año de los movimientos') as HTMLSelectElement).value).toBe('2024');
});
it('uses statement opening and closing, retains all twelve months, and does not invent fees or recommendations', async () => {
  await open();
  const balances = screen.getByRole('region', {
    name: 'Saldos de los extractos'
  });
  expect(balances.textContent).toContain('$32,615.55');
  expect(balances.textContent).toContain('$9,652.70');
  expect(balances.textContent).toContain('01/01/2025');
  expect(balances.textContent).toContain('31/12/2025');
  expect(screen.getByText(/Comisiones: no identificadas por separado/)).toBeTruthy();
  expect(screen.getByRole('table', {
    name: 'Resumen mensual de movimientos'
  }).querySelectorAll('tbody tr')).toHaveLength(12);
  expect(document.body.textContent).not.toMatch(/Colocaciones Estratégicas|Urge renegociar|15,000|Legal & Tributaria/);
  expect(screen.getByRole('heading', {
    name: 'Example Bank'
  })).toBeTruthy();
});
it('retains informative bank charts and review KPIs without inventing business profit or minimum-balance targets', async () => {
  await open();
  const charts = screen.getByRole('region', {
    name: 'Gráficos de la actividad bancaria'
  });
  expect(within(charts).getAllByRole('figure')).toHaveLength(10);
  for (const title of ['Entradas y salidas por mes', 'Saldo de los extractos por mes', 'Salidas por clasificación', 'Entradas por clasificación', 'Diferencia entre entradas y salidas', 'Principal clasificación de salidas', 'Principales clasificaciones de salidas', 'Principales clasificaciones de entradas', 'Saldo promedio diario por mes', 'Conciliados y pendientes por mes']) {
    expect(within(charts).getByRole('figure', {
      name: title
    })).toBeTruthy();
  }
  expect(charts.textContent).toContain('Sin asignar');
  expect(within(charts).getByRole('figure', {
    name: 'Salidas por clasificación'
  }).textContent).toContain('$127,703.08 · 100.0%');
  expect(within(charts).getByRole('figure', {
    name: 'Entradas por clasificación'
  }).textContent).toContain('$104,740.23 · 100.0%');
  await waitFor(() => expect(charts.querySelectorAll('.recharts-wrapper > svg.recharts-surface')).toHaveLength(10));
  expect(within(charts).getByRole('figure', {
    name: 'Entradas y salidas por mes'
  }).querySelector('.recharts-xAxis')).toBeTruthy();
  const indicators = screen.getByRole('region', {
    name: 'Indicadores de la consulta'
  });
  expect(indicators.textContent).toContain('302');
  expect(indicators.textContent).toContain('0.0%');
  expect(indicators.textContent).toContain('128');
  expect(indicators.textContent).toContain('174');
  expect(indicators.textContent).not.toMatch(/15,000|rentabilidad|ganancia neta/i);
  fireEvent.change(screen.getByLabelText('Estado de conciliación'), {
    target: {
      value: 'reconciled'
    }
  });
  expect(screen.queryByRole('region', {
    name: 'Gráficos de la actividad bancaria'
  })).toBeNull();
  fireEvent.click(screen.getByRole('button', {
    name: 'Restablecer filtros'
  }));
  expect(within(screen.getByRole('region', {
    name: 'Gráficos de la actividad bancaria'
  })).getAllByRole('figure')).toHaveLength(10);
});
it('keeps source balances separate from filtered subtotals, supports dates/status/month/categories and resets', async () => {
  const activity = await open();
  fireEvent.change(screen.getByLabelText('Estado de conciliación'), {
    target: {
      value: 'reconciled'
    }
  });
  expect(screen.getByRole('status').textContent).toContain('Ningún movimiento coincide');
  expect(within(activity).queryByText('$0.00')).toBeNull();
  expect(screen.getByRole('region', {
    name: 'Saldos de los extractos'
  }).textContent).toContain('$9,652.70');
  fireEvent.click(screen.getByRole('button', {
    name: 'Restablecer filtros'
  }));
  fireEvent.change(screen.getByLabelText('Desde'), {
    target: {
      value: '2025-12-01'
    }
  });
  expect(screen.getByText(/25 de 302 movimientos/)).toBeTruthy();
  expect(screen.getByText(/Los filtros cambian las entradas y salidas/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {
    name: 'Restablecer filtros'
  }));
  fireEvent.click(screen.getByLabelText('Ene'));
  expect(screen.getByText(/276 de 302 movimientos/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {
    name: 'Restablecer filtros'
  }));
  fireEvent.click(screen.getByLabelText('Entradas: Sin asignar'));
  expect(screen.getByText(/174 de 302 movimientos/)).toBeTruthy();
});
it('reports loading failures and invalid dates instead of presenting zero activity', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 503
  });
  render(<FinancialDashboardPage />);
  expect((await screen.findByRole('alert')).textContent).toContain('No pudimos cargar');
  fireEvent.click(screen.getByRole('button', {
    name: 'Reintentar'
  }));
  await screen.findByRole('region', {
    name: 'Actividad bancaria del período'
  });
  fireEvent.change(screen.getByLabelText('Desde'), {
    target: {
      value: '2026-01-01'
    }
  });
  expect(screen.getByRole('alert').textContent).toContain('La fecha inicial no puede ser posterior');
});
it('loads beyond the old 500-row cap before publishing totals and exposes account and year selection', async () => {
  const data = fixture();
  data.transactions = Array.from({
    length: 650
  }, (_, i) => ({
    ...data.transactions[i % 302],
    id: `paged-${i}`
  }));
  data.total = 650;
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => url.includes('cursor=') ? {
      ...data,
      transactions: data.transactions.slice(500)
    } : {
      ...data,
      transactions: data.transactions.slice(0, 500),
      hasMore: true,
      nextCursor: 'paged-499'
    }
  }));
  await open();
  expect(screen.getByText(/650 de 650 movimientos/)).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url]) => url.includes('cursor=paged-499'))).toBe(true);
  expect(screen.getByLabelText('Cuenta bancaria')).toBeTruthy();
  expect(screen.getByLabelText('Año de los movimientos')).toBeTruthy();
});
it('shows classified and unclassified categories separately and exports the visible bank movements', async () => {
  const data = fixture();
  data.transactions[0].glAccountName = 'Saved account';
  data.transactions[0].cuenta_contable = '4000 Saved account';
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => data
  });
  await open();
  const activity = screen.getByRole('region', {
    name: 'Actividad bancaria del período'
  });
  expect(activity.textContent).toContain('$104,740.23');
  const create = vi.fn(() => 'blob:test');
  Object.defineProperty(URL, 'createObjectURL', {
    value: create,
    configurable: true
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true
  });
  let filename = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    filename = this.download;
  });
  fireEvent.click(screen.getByRole('button', {
    name: 'Exportar movimientos CSV'
  }));
  expect(filename).toBe('transacciones_clasificadas.csv');
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect((create.mock.calls[0][0] as Blob).type).toBe('text/csv;charset=utf-8;');
  const csv = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(create.mock.calls[0][0] as Blob);
  });
  expect(csv.replace(/^\uFEFF/, '').split('\n')[0]).toBe('fecha,descripcion,monto,tipo,cuenta_contable,conciliado,categoria,mes');
  expect(csv).toContain('2025-01-02,"Movement 0",800,credito,"4000 Saved account",no,"Saved account",2025-01\n');
  expect(csv.split('\n').filter(Boolean)).toHaveLength(303);
  await waitFor(() => expect(screen.getByLabelText('Entradas: Saved account')).toBeTruthy());
});
it('renders English explanations without untranslated keys', async () => {
  useLanguageStore.getState().setLanguage('en');
  render(<FinancialDashboardPage />);
  expect(await screen.findByRole('region', {
    name: 'Bank activity for the period'
  })).toBeTruthy();
  expect(screen.getByText(/Unclassified: 302/)).toBeTruthy();
  expect(screen.getByRole('button', {
    name: 'Export movements CSV'
  })).toBeTruthy();
});
