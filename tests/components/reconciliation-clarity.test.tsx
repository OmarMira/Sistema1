import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReconciliationPage } from '@/components/spa/ReconciliationPage';
import { useLanguageStore } from '@/store/language-store';

const state = vi.hoisted(() => ({ activeCompany: { id: 'company-test' }, setCurrentView: vi.fn(), startProcessing: vi.fn(), stopProcessing: vi.fn() }));
vi.mock('@/store/auth-store', () => ({ useAuthStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: ({ count }: { count: number }) => ({
  getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 53, end: (index + 1) * 53, size: 53 })),
  getTotalSize: () => count * 53, measureElement: vi.fn(),
}) }));
const fetchMock = vi.fn();
const gl = { id: 'gl-bank', code: '1011', name: 'Example Bank', normalBalance: 'debit', accountType: 'asset' };
const statement = (id: string, start: string, end: string, opening: number, closing: number) => ({ id, startDate: start + 'T00:00:00.000Z', endDate: end + 'T00:00:00.000Z', openingBalance: opening, closingBalance: closing, fileName: null, format: 'pdf' });
const statements = [statement('dec', '2025-12-01', '2025-12-31', 11538.28, 9652.70), statement('jan', '2025-01-01', '2025-01-31', 32615.55, 34461.61)];
const transaction = (id: string, amount: number, classified = false) => ({ id, date: '2025-12-15T00:00:00.000Z', createdAt: '2026-10-22T18:34:31.000Z', description: 'Example ' + id, reference: null, amount, glAccountId: classified ? 'gl-income' : null, glAccount: classified ? { id: 'gl-income', code: '4000', name: 'Income' } : null, journalEntryId: null, journalLineId: null, matchedRule: null, reconciledAt: null });
const data = () => ({
  bankAccount: { id: 'bank-test', accountName: 'Example Bank', bankName: 'Example Bank', balance: 9652.70, currency: 'USD', glAccount: gl },
  statements, latestStatement: { id: 'dec', endDate: statements[0].endDate, closingBalance: 9652.70 },
  summary: { statementBalance: 9652.70, bookBalance: 0, difference: 9652.70, totalTransactions: 3, reconciledCount: 0, unreconciledCount: 3, pendingReviewCount: 0, depositsTotal: 25, paymentsTotal: -5, filteredCount: 3 },
  deposits: [transaction('deposit', 20, true), transaction('other', 5)], payments: [transaction('payment', -5)], openPeriod: null, recentPeriods: [],
});
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); useLanguageStore.getState().setLanguage('es');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  fetchMock.mockImplementation(async (input: string) => {
    const path = new URL(input, 'http://test.local').pathname;
    if (path === '/api/dashboard') return { ok: true, json: async () => ({ bankAccounts: [data().bankAccount] }) };
    if (path === '/api/journal/accounts') return { ok: true, json: async () => ({ data: [gl, { id: 'gl-income', code: '4000', name: 'Income' }] }) };
    if (path === '/api/reconciliation/auto-preview') return { ok: true, json: async () => ({ success: true, matched: 0 }) };
    if (path === '/api/reconciliation') return { ok: true, json: async () => data() };
    throw new Error('Unexpected mocked request: ' + path);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function openPage() {
  const result = render(<ReconciliationPage />);
  await screen.findByRole('button', { name: /Exportar|Export/ });
  await waitFor(() => expect(result.container.querySelector('#createJE')).not.toBeNull());
  return result;
}
it('shows the statement period, opening and pending preparation independently of import date', async () => {
  await openPage();
  const context = screen.getByRole('region', { name: 'Información bancaria para revisión contable' });
  expect(context.textContent).toContain('01/01/2025');
  expect(context.textContent).toContain('31/12/2025');
  expect(context.textContent).not.toContain('2026');
  expect(context.textContent).toContain('$32,615.55');
  expect(context.textContent).toContain('2 resúmenes seleccionados');
  expect(context.textContent).toContain('3 movimientos importados en esta cuenta');
  expect(context.textContent).toContain('Sin clasificación guardada: 2');
  expect(context.textContent).toContain('Sin asiento vinculado: 3');
  expect(context.textContent).toContain('no es una presentación oficial');
  expect(context.textContent).toContain('La fecha de carga no cambia el período');
});
it('explains both cutoffs and the real difference without treating it as an import error', async () => {
  await openPage();
  expect(screen.getAllByText(/Fecha de corte: 31\/12\/2025/)).toHaveLength(2);
  expect(screen.getByText(/Los asientos posteriores al corte no se incluyen/)).toBeTruthy();
  expect(screen.getByText(/Una diferencia no implica por sí sola un error de importación/)).toBeTruthy();
  expect(screen.getByText('$0.00')).toBeTruthy();
  expect(screen.getAllByText('$9,652.70')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Hasta (movimientos)'), { target: { value: '2025-06-30' } });
  await waitFor(() => expect(screen.getByText(/Fecha de corte: 30\/06\/2025/)).toBeTruthy());
  expect(screen.getByText(/Los saldos tienen fechas de corte distintas/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('endDate=2025-06-30'));
});
it('labels internal review and counterpart accounts, preserves default posting, and does not post on toggle', async () => {
  await openPage();
  expect(screen.getByRole('tab', { name: /Revisión interna pendiente/ })).toBeTruthy();
  expect(screen.getAllByRole('columnheader', { name: 'Contrapartida del movimiento' })).toHaveLength(2);
  const toggle = screen.getByRole('switch', { name: 'Crear Asientos Contables' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText(/Al confirmar se solicitarán asientos publicados/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText(/No se solicitarán asientos nuevos/)).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && url !== '/api/reconciliation/auto-preview')).toHaveLength(0);
});
it('keeps selected-row confirmation and the existing local text export contract', async () => {
  await openPage();
  const row = screen.getByText('Example deposit').closest('tr')!;
  fireEvent.click(within(row).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Conciliar Seleccionados (1)' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/Crear automáticamente asientos contables publicados/)).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Conciliar Seleccionados (1)' })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  const createUrl = vi.fn((_blob: Blob) => 'blob:test');
  Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  let downloadedName = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadedName = this.download; });
  fireEvent.click(screen.getByRole('button', { name: /Exportar|Export/ }));
  expect(createUrl).toHaveBeenCalledOnce();
  expect(createUrl.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect((createUrl.mock.calls[0][0] as Blob).type).toBe('text/plain');
  expect(downloadedName).toBe('reconciliation-example-bank.txt');
});
it('uses UTC statement dates when selecting a single statement, independently of loaded-list counts', async () => {
  await openPage();
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Extractos para el control' }), { key: 'Enter' });
  const january = screen.getByRole('option', { name: '01/01/2025 a 31/01/2025' });
  fireEvent.click(january);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('statementId=jan')));
  const context = await screen.findByRole('region', { name: 'Información bancaria para revisión contable' });
  expect(context.textContent).toContain('1 resúmenes seleccionados');
  expect(context.textContent).toContain('01/01/2025 — 31/01/2025');
  expect(screen.getAllByText(/Fecha de corte: 31\/01\/2025/)).toHaveLength(2);
});
it('localizes the preparation context in English without raw translation keys', async () => {
  useLanguageStore.getState().setLanguage('en');
  const page = await openPage();
  expect(screen.getByRole('region', { name: 'Bank information for accounting review' })).toBeTruthy();
  expect(page.container.textContent).not.toContain('reconciliation.report.');
  expect(screen.getByRole('tab', { name: /Pending internal review/ })).toBeTruthy();
});
