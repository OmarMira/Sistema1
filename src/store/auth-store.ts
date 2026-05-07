import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'company_admin';
}

export interface Company {
  id: string;
  legalName: string;
  taxId: string | null;
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
  | 'backup';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  activeCompany: Company | null;
  currentView: ViewName;
  sidebarOpen: boolean;
  aiAssistantOpen: boolean;
  login: (user: User) => void;
  logout: () => void;
  setActiveCompany: (company: Company) => void;
  setCurrentView: (view: ViewName) => void;
  setSidebarOpen: (open: boolean) => void;
  setAiAssistantOpen: (open: boolean) => void;
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

      login: (user: User) =>
        set({
          user,
          isAuthenticated: true,
          currentView: 'dashboard',
        }),

      logout: () =>
        set({
          user: null,
          isAuthenticated: false,
          activeCompany: null,
          currentView: 'landing',
          sidebarOpen: true,
          aiAssistantOpen: false,
        }),

      setActiveCompany: (company: Company) =>
        set({ activeCompany: company }),

      setCurrentView: (view: ViewName) => set({ currentView: view }),

      setSidebarOpen: (open: boolean) => set({ sidebarOpen: open }),

      setAiAssistantOpen: (open: boolean) => set({ aiAssistantOpen: open }),

      hydrate: async () => {
        try {
          const res = await fetch('/api/auth/me', {
            credentials: 'include',
          });
          if (res.ok) {
            const data = await res.json();
            if (data.user) {
              set({
                user: data.user,
                isAuthenticated: true,
                currentView: 'dashboard',
              });
              if (data.companies && data.companies.length > 0) {
                set({ activeCompany: data.companies[0] });
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
        currentView: state.currentView,
        sidebarOpen: state.sidebarOpen,
      }),
    }
  )
);
