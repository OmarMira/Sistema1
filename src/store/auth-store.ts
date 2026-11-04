import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TenantRole = 'company_admin' | 'employee' | 'viewer';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'user';
  avatar?: string | null;
}

export interface Company {
  id: string;
  legalName: string;
  taxId: string | null;
  isOnboardingComplete: boolean;
  logo?: string | null;
  role?: TenantRole | null;
}

export type ViewName =
  | 'landing'
  | 'login'
  | 'register'
  | 'select-company'
  | 'dashboard'
  | 'accounts'
  | 'journal'
  | 'banks'
  | 'bank-rules'
  | 'import'
  | 'reconciliation'
  | 'reports'
  | 'export'
  | 'settings'
  | 'users'
  | 'onboarding'
  | 'movement-summary'
  | 'financial-dashboard'
  | 'backup'
  | 'admin-companies'
  | 'admin-company-detail'
  | 'admin-users'
  | 'admin-audit-logs'
  | 'admin-readiness'
  | 'admin-dashboard'
  | 'workflow'
  | 'entity-management'
  | 'company-structure';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  activeCompany: Company | null;
  currentView: ViewName;
  sidebarOpen: boolean;
  aiAssistantOpen: boolean;
  adminSelectedCompanyId: string | null;
  isProcessing: boolean;
  processingMessage: string;
  settingsActiveTab: string;
  login: (user: User) => void;
  setUser: (user: User | null) => void;
  logout: () => void;
  setActiveCompany: (company: Company | null) => void;
  setCurrentView: (view: ViewName) => void;
  setSidebarOpen: (open: boolean) => void;
  setAiAssistantOpen: (open: boolean) => void;
  setAdminSelectedCompanyId: (id: string | null) => void;
  setSettingsActiveTab: (tab: string) => void;
  startProcessing: (message?: string) => void;
  stopProcessing: () => void;
  hydrate: () => Promise<void>;
  activeCompanyRole: () => TenantRole | null;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      activeCompany: null,
      currentView: 'landing' as ViewName,
      sidebarOpen: true,
      aiAssistantOpen: false,
      adminSelectedCompanyId: null,
      isProcessing: false,
      processingMessage: 'Procesando...',
      settingsActiveTab: 'user-profile',

      login: (user: User) =>
        set({
          user,
          isAuthenticated: true,
          currentView: 'dashboard',
        }),

      setUser: (user: User | null) => set({ user }),

      logout: () =>
        set({
          user: null,
          isAuthenticated: false,
          activeCompany: null,
          currentView: 'landing',
          sidebarOpen: true,
          aiAssistantOpen: false,
          adminSelectedCompanyId: null,
          isProcessing: false,
          settingsActiveTab: 'user-profile',
        }),

      setActiveCompany: (company: Company | null) => set({ activeCompany: company }),

      setCurrentView: (view: ViewName) => set({ currentView: view }),

      setSidebarOpen: (open: boolean) => set({ sidebarOpen: open }),

      setAiAssistantOpen: (open: boolean) => set({ aiAssistantOpen: open }),

      setAdminSelectedCompanyId: (id: string | null) => set({ adminSelectedCompanyId: id }),

      setSettingsActiveTab: (tab: string) => set({ settingsActiveTab: tab }),

      startProcessing: (message) =>
        set({ isProcessing: true, processingMessage: message || 'Procesando...' }),

      stopProcessing: () => set({ isProcessing: false }),

      activeCompanyRole: () => get().activeCompany?.role ?? null,

      hydrate: async () => {
        try {
          const res = await fetch('/api/auth/me', {
            credentials: 'include',
          });
          if (!res.ok) return;

          const data = await res.json();
          if (!data.user) return;

          const currentStore = get();
          // The server owns the company list. Anything persisted locally that it no
          // longer grants (deleted company, revoked membership) is revalidated here
          // and dropped instead of trusted.
          const companies: Company[] = Array.isArray(data.companies) ? data.companies : [];
          const ownedCompanies = new Map<string, Company>(
            companies.map((company) => [company.id, company]),
          );
          const persistedCompany = currentStore.activeCompany;
          const ownedCompany = persistedCompany
            ? ownedCompanies.get(persistedCompany.id)
            : undefined;

          set({
            user: data.user,
            isAuthenticated: true,
          });

          if (!persistedCompany || currentStore.currentView === 'select-company') {
            // No company chosen yet (or explicitly choosing): always ask the user.
            set({
              activeCompany: null,
              currentView: 'select-company',
            });
          } else if (ownedCompany) {
            // Still owned: refresh from the server, keeping the current view.
            set({
              activeCompany: ownedCompany,
              currentView: 'dashboard',
            });
          } else {
            // No longer owned: clear it rather than falling back silently.
            set({
              activeCompany: null,
              currentView: 'select-company',
            });
          }

          if (
            currentStore.adminSelectedCompanyId &&
            !ownedCompanies.has(currentStore.adminSelectedCompanyId)
          ) {
            set({ adminSelectedCompanyId: null });
          }
        } catch {
          // Not authenticated – leave defaults
        }
      },
    }),
    {
      name: 'accountexpress-auth',
      partialize: (state) => ({
        activeCompany: state.activeCompany,
        sidebarOpen: state.sidebarOpen,
        adminSelectedCompanyId: state.adminSelectedCompanyId,
      }),
    },
  ),
);
