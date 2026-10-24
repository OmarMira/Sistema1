import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminUsersPage from '@/components/spa/admin/AdminUsersPage';
import { useLanguageStore } from '@/store/language-store';
const mocks = vi.hoisted(() => ({ logout: vi.fn(), toast: vi.fn() }));
vi.mock('@/store/auth-store', () => ({ useAuthStore: { getState: () => ({ logout: mocks.logout }) } }));
vi.mock('@/components/ui/address-autocomplete', () => ({ AddressAutocomplete: () => null }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }));
const fetchMock = vi.fn();
const target = { id: 'test-user', email: 'test@example.test', firstName: 'Test', lastName: 'Admin', role: 'super_admin', isActive: true, createdAt: '2025-01-01Z' };
function reply(status: number, data: unknown) { return { ok: status < 400, status, json: async () => data }; }
beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useLanguageStore.getState().setLanguage('es');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
        ? reply(409, { code: 'LAST_COMPANY_SUPERADMIN', error: 'Deleting this user would leave companies without an active superadmin.' })
        : reply(200, { users: [target] }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function confirm() {
    render(<AdminUsersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Eliminar' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, Eliminar Usuario' }));
    return dialog;
}
it('replaces a blocked confirmation with a reason and one acknowledge button, never another destructive confirmation', async () => {
    const dialog = await confirm();
    await within(dialog).findByRole('heading', { name: 'No se puede eliminar este usuario' });
    expect(dialog.textContent).toContain('último superusuario');
    expect(dialog.textContent).toContain('No se realizó ningún cambio.');
    expect(within(dialog).queryByRole('button', { name: 'Sí, Eliminar Usuario' })).toBeNull();
    expect(dialog.textContent).not.toContain('Deleting this user');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Entendido' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(mocks.logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sí, Eliminar Usuario' })).toBeTruthy();
});
it.each(['response', 'network'])('shows a separate localized failure rather than mislabeling %s errors as orphan protection', async (kind) => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'DELETE')
            return reply(200, { users: [target] });
        if (kind === 'network')
            throw new Error('offline');
        return reply(403, { error: 'Forbidden', code: 'FORBIDDEN' });
    });
    const dialog = await confirm();
    await within(dialog).findByRole('heading', { name: 'No se pudo eliminar el usuario' });
    expect(dialog.textContent).not.toContain('último superusuario');
    expect(dialog.textContent).not.toContain('No se realizó ningún cambio.');
    expect(within(dialog).queryByRole('button', { name: 'Sí, Eliminar Usuario' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Entendido' })).toBeTruthy();
});
it('keeps a pending request single and cannot dismiss it into another confirmation', async () => {
    let finish!: (response: ReturnType<typeof reply>) => void;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
        ? new Promise<ReturnType<typeof reply>>(resolve => { finish = resolve; })
        : reply(200, { users: [target] }));
    const dialog = await confirm();
    const pending = within(dialog).getByRole('button', { name: 'Eliminando...' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    finish(reply(409, { code: 'LAST_COMPANY_SUPERADMIN' }));
    await within(dialog).findByRole('heading', { name: 'No se puede eliminar este usuario' });
});
it('localizes the blocking state in English without exposing raw backend text', async () => {
    useLanguageStore.getState().setLanguage('en');
    render(<AdminUsersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Eliminar' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, Delete User' }));
    await within(dialog).findByRole('heading', { name: 'This user cannot be deleted' });
    expect(dialog.textContent).toContain('No changes were made.');
    expect(within(dialog).getByRole('button', { name: 'Understood' })).toBeTruthy();
});
it('preserves successful deletion and list refresh without an error dialog', async () => {
    let deleted = false;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
            deleted = true;
            return reply(200, { message: 'User deleted successfully', selfDeleted: false });
        }
        return reply(200, { users: deleted ? [] : [target] });
    });
    await confirm();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByText('test@example.test')).toBeNull());
    expect(mocks.logout).not.toHaveBeenCalled();
});
