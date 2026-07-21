import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'company_admin';
  avatar?: string | null;
}

export interface Company {
  id: string;
  legalName: string;
  taxId: string | null;
  isOnboardingComplete: boolean;
  logo?: string | null;
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

      hydrate: async () => {
        try {
          const res = await fetch('/api/auth/me', {
            credentials: 'include',
          });
          if (res.ok) {
            const data = await res.json();
            if (data.user) {
              const currentStore = get();

              set({
                user: data.user,
                isAuthenticated: true,
              });

              if (!currentStore.activeCompany || currentStore.currentView === 'select-company') {
                // If no company is active or explicitly on select-company, go to select-company with activeCompany as null
                set({
                  activeCompany: null,
                  currentView: 'select-company',
                });
              } else if (currentStore.activeCompany) {
                // Verify the active company is still valid and refresh its data
                const freshCompany = data.companies?.find(
                  (c: Company) => c.id === currentStore.activeCompany?.id,
                );
                if (freshCompany) {
                  set({
                    activeCompany: freshCompany,
                    currentView: 'dashboard',
                  });
                } else {
                  set({
                    activeCompany: data.companies?.[0] || null,
                    currentView: data.companies?.[0] ? 'dashboard' : 'select-company',
                  });
                }
              }
            }
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
