// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InstallationWizard } from '@/components/onboarding/InstallationWizard';
const auth = vi.hoisted(() => ({ hydrate: vi.fn(async () => {}), login: vi.fn(), setActiveCompany: vi.fn() }));
vi.mock('@/store/auth-store', () => ({ useAuthStore: { getState: () => auth } }));
vi.mock('@/store/language-store', () => ({ useLanguageStore: (select: (value: {language: string}) => unknown) => select({language: 'es'}) }));
vi.mock('@/components/spa/ThemeToggle', () => ({ ThemeToggle: () => <button>Tema</button> }));
vi.mock('@/components/spa/LanguageSelector', () => ({ LanguageSelector: () => <span>Español</span> }));
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });
async function review() {
  fireEvent.click(screen.getByRole('button', {name: 'Comenzar'}));
  fireEvent.change(screen.getByLabelText('Nombre legal de tu empresa'), {target: {value: 'Example Company'}});
  fireEvent.click(screen.getByRole('button', {name: 'Continuar'}));
  fireEvent.click(screen.getByRole('button', {name: 'Continuar'}));
  for (const [label, value] of [['Nombre', 'Ana'], ['Apellido', 'Perez'], ['Correo electrónico', 'ana@example.com'], ['Contraseña', 'SecretPass123!'], ['Confirmar contraseña', 'SecretPass123!']]) fireEvent.change(screen.getByLabelText(label, {exact:true}), {target:{value}});
  fireEvent.click(screen.getByRole('button', {name:'Revisar'}));
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('operational installation wizard', () => {
  it('independently reveals and conceals both passwords without submitting or losing values', async () => {
    render(<InstallationWizard onBack={() => {}} />); await review();
    fireEvent.click(screen.getByRole('button', {name:'Volver'}));
    const password = screen.getByLabelText('Contraseña', {exact:true});
    const confirmation = screen.getByLabelText('Confirmar contraseña', {exact:true});
    expect(password.getAttribute('type')).toBe('password');
    expect(confirmation.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', {name:'Mostrar contraseña', exact:true}));
    expect(password.getAttribute('type')).toBe('text');
    expect(confirmation.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', {name:'Ocultar contraseña', exact:true}));
    expect(password.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', {name:'Mostrar confirmación de contraseña', exact:true}));
    expect(confirmation.getAttribute('type')).toBe('text');
    expect(password.getAttribute('type')).toBe('password');
    fireEvent.click(screen.getByRole('button', {name:'Ocultar confirmación de contraseña', exact:true}));
    expect(confirmation.getAttribute('type')).toBe('password');
    expect((password as HTMLInputElement).value).toBe('SecretPass123!');
    expect((confirmation as HTMLInputElement).value).toBe('SecretPass123!');
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem('password')).toBeNull();
  });
  it('calls real register, verify, complete, authoritative me and hydrate without a global opening balance', async () => {
    const company = {id:'c1', legalName:'Example Company', isOnboardingComplete:true};
    vi.mocked(fetch).mockResolvedValueOnce(response({requiresVerification:true,deliveryFailed:false}) as Response)
      .mockResolvedValueOnce(response({user:{id:'u1'},companies:[{...company,isOnboardingComplete:false}]}) as Response)
      .mockResolvedValueOnce(response({success:true}) as Response)
      .mockResolvedValueOnce(response({user:{id:'u1'},companies:[company]}) as Response);
    render(<InstallationWizard onBack={() => {}} />); await review();
    fireEvent.click(screen.getByRole('button',{name:'Enviar código'}));
    await screen.findByLabelText('Código de verificación');
    fireEvent.change(screen.getByLabelText('Código de verificación'), {target:{value:'492817'}});
    fireEvent.click(screen.getByRole('button',{name:'Verificar y completar'}));
    await waitFor(() => expect(auth.hydrate).toHaveBeenCalledOnce());
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(c=>c[0])).toEqual(['/api/auth/register','/api/auth/verify','/api/onboarding/complete','/api/auth/me']);
    const body = JSON.parse(String(calls[2][1]?.body));
    expect(body.companyId).toBe('c1'); expect(body.legalName).toBe('Example Company');
    expect(body).not.toHaveProperty('initialCashBalance');
    expect(auth.setActiveCompany).toHaveBeenCalledWith(company);
    expect(localStorage.getItem('password')).toBeNull();
  });
  it('completion failure retries completion only, not registration or verification', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({requiresVerification:true}) as Response)
      .mockResolvedValueOnce(response({user:{id:'u1'},companies:[{id:'c1'}]}) as Response)
      .mockResolvedValueOnce(response({error:'Temporal failure'},false) as Response)
      .mockResolvedValueOnce(response({success:true}) as Response)
      .mockResolvedValueOnce(response({user:{id:'u1'},companies:[{id:'c1',isOnboardingComplete:true}]}) as Response);
    render(<InstallationWizard onBack={() => {}} />); await review();
    fireEvent.click(screen.getByRole('button',{name:'Enviar código'})); await screen.findByLabelText('Código de verificación');
    fireEvent.change(screen.getByLabelText('Código de verificación'),{target:{value:'492817'}});
    fireEvent.click(screen.getByRole('button',{name:'Verificar y completar'}));
    await screen.findByText('Temporal failure');
    fireEvent.click(screen.getByRole('button',{name:'Reintentar configuración'}));
    await waitFor(()=>expect(auth.hydrate).toHaveBeenCalledOnce());
    expect(vi.mocked(fetch).mock.calls.map(c=>c[0])).toEqual(['/api/auth/register','/api/auth/verify','/api/onboarding/complete','/api/onboarding/complete','/api/auth/me']);
  });
  it('unavailable mail is shown as a failure and never completes setup', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({requiresVerification:true,deliveryFailed:true}) as Response);
    render(<InstallationWizard onBack={()=>{}} />); await review();
    fireEvent.click(screen.getByRole('button',{name:'Enviar código'}));
    await screen.findByText('No se pudo enviar el correo. Revisá la configuración de correo antes de reintentar.');
    expect(auth.login).not.toHaveBeenCalled(); expect(auth.hydrate).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });
});
