// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RegisterPage } from '../../src/components/spa/RegisterPage';
import { useLanguageStore } from '../../src/store/language-store';

const actions = vi.hoisted(() => ({ login: vi.fn(), setCurrentView: vi.fn(), setActiveCompany: vi.fn() }));
vi.mock('@/store/auth-store', () => ({ useAuthStore: Object.assign(() => actions, { getState: () => actions }) }));
vi.mock('@/components/spa/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/spa/LanguageSelector', () => ({ LanguageSelector: () => null }));
const fetchMock = vi.fn();
const reply = (body: object, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); useLanguageStore.getState().setLanguage('es'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function register(body = { requiresVerification: true, email: 'test@example.invalid', deliveryFailed: false }) {
  fetchMock.mockResolvedValueOnce(reply(body));
  const view = render(<RegisterPage />);
  for (const [id, value] of Object.entries({ firstName: 'Test', lastName: 'User', 'reg-email': 'test@example.invalid', 'reg-password': 'TestPassword1!', confirmPassword: 'TestPassword1!', companyName: 'Test Company' })) {
    fireEvent.change(view.container.querySelector('#' + id)!, { target: { value } });
  }
  fireEvent.submit(view.container.querySelector('form')!);
  await screen.findByText('Verifica tu correo');
  return view;
}
it('renders Spanish labels and translates the reported Unauthorized response', async () => {
  const view = await register();
  expect(screen.getByText('(Opcional)')).toBeTruthy();
  expect(view.container.textContent).not.toContain('register.');
  fetchMock.mockResolvedValueOnce(reply({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401));
  fireEvent.change(view.container.querySelector('#verifyCode')!, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verificar', exact: true }));
  await screen.findByText('No se pudo autorizar la verificación. Intenta nuevamente.');
  expect(screen.queryByText('Unauthorized')).toBeNull();
  expect(actions.login).not.toHaveBeenCalled();
});
it('reports failed delivery truthfully and allows requesting another code', async () => {
  await register({ requiresVerification: true, email: 'test@example.invalid', deliveryFailed: true });
  expect(screen.getByText('No se pudo enviar el código. Intenta reenviarlo.')).toBeTruthy();
  expect(screen.queryByText(/Se envió un código/)).toBeNull();
  fetchMock.mockResolvedValueOnce(reply({ message: 'If pending, code sent' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar código' }));
  await screen.findByText('Si hay una cuenta pendiente con ese correo, recibirás un nuevo código.');
  expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/resend-verification', expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ email: 'test@example.invalid' }) }));
});
it('keeps successful verification login and company selection', async () => {
  const view = await register();
  const user = { id: 'user-1', email: 'test@example.invalid', role: 'user' };
  const company = { id: 'company-1' };
  fetchMock.mockResolvedValueOnce(reply({ user, companies: [company] }));
  fireEvent.change(view.container.querySelector('#verifyCode')!, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verificar', exact: true }));
  await waitFor(() => expect(actions.login).toHaveBeenCalledWith(user));
  expect(actions.setActiveCompany).toHaveBeenCalledWith(company);
  expect(actions.setCurrentView).toHaveBeenCalledWith('dashboard');
});
