// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RegisterPage } from '../../src/components/spa/RegisterPage';
import { LoginPage } from '../../src/components/spa/LoginPage';
import { useLanguageStore } from '../../src/store/language-store';

const actions = vi.hoisted(() => ({ login: vi.fn(), setCurrentView: vi.fn(), setActiveCompany: vi.fn() }));
vi.mock('@/store/auth-store', () => ({ useAuthStore: Object.assign(() => actions, { getState: () => actions }) }));
vi.mock('@/components/spa/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/spa/LanguageSelector', () => ({ LanguageSelector: () => null }));
const fetchMock = vi.fn();
const reply = (body: object, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); useLanguageStore.getState().setLanguage('es'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function register(body = { requiresVerification: true, email: 'test@example.invalid', deliveryFailed: false }) {
  fetchMock.mockResolvedValueOnce(reply(body));
  const view = render(<RegisterPage />);
  expect(screen.getByText('(Opcional)')).toBeTruthy();
  for (const [id, value] of Object.entries({ firstName: 'Test', lastName: 'User', 'reg-email': 'test@example.invalid', 'reg-password': 'TestPassword1!', confirmPassword: 'TestPassword1!', companyName: 'Test Company' })) {
    fireEvent.change(view.container.querySelector('#' + id)!, { target: { value } });
  }
  fireEvent.submit(view.container.querySelector('form')!);
  await screen.findByText('Verifica tu correo');
  return view;
}
it('renders Spanish labels and translates the reported Unauthorized response', async () => {
  const view = await register();
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

const draftKey = 'registration-verification:v1';
it('resumes confirmation after reload, resends expired codes and never stores the password', async () => {
  const first = await register();
  const stored = localStorage.getItem(draftKey);
  expect(stored).not.toBeNull();
  expect(JSON.parse(stored!)).toEqual({
    kind: 'new', email: 'test@example.invalid', firstName: 'Test', lastName: 'User',
    companyName: 'Test Company', entityType: 'BUSINESS', taxId: null, deliveryFailed: false,
  });
  expect(stored).not.toMatch(/password|TestPassword|code|token/i);
  first.unmount();
  const resumed = render(<RegisterPage />);
  await screen.findByText('Verifica tu correo');
  expect(screen.getByText('Para continuar, vuelve a ingresar tu contraseña. No la guardamos en este navegador.')).toBeTruthy();
  expect((screen.getByLabelText('Contraseña') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Confirmar Contraseña') as HTMLInputElement).value).toBe('');
  fetchMock.mockResolvedValueOnce(reply({ message: 'neutral' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar código' }));
  await screen.findByText('Si hay una cuenta pendiente con ese correo, recibirás un nuevo código.');
  expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/resend-verification', expect.objectContaining({ body: JSON.stringify({ email: 'test@example.invalid' }) }));
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'TestPassword1!' } });
  fireEvent.change(screen.getByLabelText('Confirmar Contraseña'), { target: { value: 'TestPassword1!' } });
  fireEvent.change(screen.getByLabelText('Código de verificación'), { target: { value: '654321' } });
  fetchMock.mockResolvedValueOnce(reply({ user: { id: 'resumed' }, companies: [{ id: 'company-resumed' }] }));
  fireEvent.click(screen.getByRole('button', { name: 'Verificar', exact: true }));
  await waitFor(() => expect(actions.login).toHaveBeenCalledWith({ id: 'resumed' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/verify', expect.objectContaining({ body: JSON.stringify({
    email: 'test@example.invalid', code: '654321', firstName: 'Test', lastName: 'User',
    companyName: 'Test Company', entityType: 'BUSINESS', taxId: null,
    password: 'TestPassword1!', confirmPassword: 'TestPassword1!',
  }) }));
  expect(fetchMock.mock.calls.filter(call => call[0] === '/api/auth/register')).toHaveLength(1);
  expect(localStorage.getItem(draftKey)).toBeNull();
  expect(actions.setActiveCompany).toHaveBeenCalledWith({ id: 'company-resumed' });
});
it('routes a correctly authenticated pending account to owner-code confirmation, without a session or new registration', async () => {
  fetchMock.mockResolvedValueOnce(reply({ code: 'EMAIL_VERIFICATION_REQUIRED', details: { email: 'pending@example.invalid' } }, 403));
  const form = render(<LoginPage />);
  fireEvent.change(screen.getByLabelText('Correo electrónico'), { target: { value: 'pending@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'ExistingPassword1!' } });
  fireEvent.submit(form.container.querySelector('form')!);
  await waitFor(() => expect(actions.setCurrentView).toHaveBeenCalledWith('register'));
  expect(actions.login).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(draftKey)!)).toEqual({ kind: 'existing', email: 'pending@example.invalid' });
  form.unmount();
  render(<RegisterPage />);
  await screen.findByText('Verifica tu correo');
  expect(screen.queryByLabelText('Contraseña')).toBeNull();
  fetchMock.mockResolvedValueOnce(reply({ message: 'neutral' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar código' }));
  await screen.findByText('Si hay una cuenta pendiente con ese correo, recibirás un nuevo código.');
  fetchMock.mockResolvedValueOnce(reply({ user: { id: 'existing' }, companies: [{ id: 'old-company' }] }));
  fireEvent.change(screen.getByLabelText('Código de verificación'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verificar', exact: true }));
  await waitFor(() => expect(actions.login).toHaveBeenCalledWith({ id: 'existing' }));
  expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/verify', expect.objectContaining({ body: JSON.stringify({ email: 'pending@example.invalid', code: '123456' }) }));
  expect(fetchMock.mock.calls.some(call => call[0] === '/api/auth/register')).toBe(false);
  expect(localStorage.getItem(draftKey)).toBeNull();
});
it('preserves normal login success and generic invalid-password handling', async () => {
  const form = render(<LoginPage />);
  fireEvent.change(screen.getByLabelText('Correo electrónico'), { target: { value: 'verified@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'WrongPassword1!' } });
  fetchMock.mockResolvedValueOnce(reply({ error: 'Correo electrónico o contraseña inválidos', code: 'UNAUTHORIZED' }, 401));
  fireEvent.submit(form.container.querySelector('form')!);
  await screen.findByText('Correo electrónico o contraseña inválidos');
  expect(localStorage.getItem(draftKey)).toBeNull();
  expect(actions.login).not.toHaveBeenCalled();
  expect(actions.setCurrentView).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(reply({ user: { id: 'verified' }, companies: [{ id: 'old' }] }));
  fireEvent.submit(form.container.querySelector('form')!);
  await waitFor(() => expect(actions.login).toHaveBeenCalledWith({ id: 'verified' }));
  expect(actions.setActiveCompany).toHaveBeenCalledWith(null);
  expect(actions.setCurrentView).toHaveBeenCalledWith('select-company');
});
