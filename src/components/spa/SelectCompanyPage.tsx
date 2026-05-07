'use client';

import { useEffect, useState } from 'react';
import { Building2, ChevronRight, LogOut } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type Company } from '@/store/auth-store';

export function SelectCompanyPage() {
  const t = useLanguageStore((s) => s.t);
  const { user, setActiveCompany, setCurrentView, logout } = useAuthStore();
  const [companies, setCompanies] = useState<Company[]>([]);

  useEffect(() => {
    async function fetchCompanies() {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.companies) {
            setCompanies(data.companies);
          }
        }
      } catch {
        // ignore
      }
    }
    fetchCompanies();
  }, []);

  function handleSelectCompany(company: Company) {
    setActiveCompany(company);
    setCurrentView('dashboard');
  }

  function handleLogout() {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    logout();
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
              AE
            </div>
            <span className="text-lg font-semibold tracking-tight">
              {t('common.appName')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <LanguageSelector />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Company selection */}
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-2xl">{t('auth.selectCompany')}</CardTitle>
              <CardDescription>
                {t('selectCompany.subtitle')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {user && (
                <div className="mb-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('selectCompany.welcome')}, <span className="font-medium text-foreground">{user.firstName}</span>
                  </p>
                </div>
              )}

              {companies.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t('auth.noCompanies')}
                </p>
              ) : (
                <div className="space-y-2">
                  {companies.map((company, i) => (
                    <motion.button
                      key={company.id}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.08, duration: 0.3 }}
                      onClick={() => handleSelectCompany(company)}
                      className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent hover:border-primary/50 group"
                    >
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <Building2 className="size-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">
                          {company.legalName}
                        </p>
                        {company.taxId && (
                          <p className="text-xs text-muted-foreground">
                            {t('auth.taxId')}: {company.taxId}
                          </p>
                        )}
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </motion.button>
                  ))}
                </div>
              )}

              <div className="pt-4 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-2"
                  onClick={handleLogout}
                >
                  <LogOut className="size-4" />
                  {t('auth.logout')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 text-center">
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} {t('common.appName')}.{' '}
            {t('landing.copyright')}
          </p>
        </div>
      </footer>
    </div>
  );
}
