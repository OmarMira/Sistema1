'use client';

import { useEffect, useState } from 'react';
import { Building2, ChevronRight, LogOut, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type Company } from '@/store/auth-store';

export function SelectCompanyPage() {
  const t = useLanguageStore((s) => s.t);
  const { user, setActiveCompany, setCurrentView, logout } = useAuthStore();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [legalName, setLegalName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function handleCreateCompany(e: React.FormEvent) {
    e.preventDefault();
    if (!legalName.trim()) return;

    setCreating(true);
    setError('');

    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legalName, taxId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al crear la empresa');
        return;
      }

      const newCompany: Company = data.company;
      setActiveCompany(newCompany);
      setCurrentView('dashboard');
    } catch {
      setError('Error de conexión al servidor');
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    async function fetchCompanies() {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.companies) {
            setCompanies(data.companies);
          }
          if (data.user) {
            useAuthStore.setState({ user: data.user });
          }
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
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
            <span className="text-lg font-semibold tracking-tight">{t('common.appName')}</span>
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
              <CardDescription>{t('selectCompany.subtitle')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {user && (
                <div className="mb-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('selectCompany.welcome')},{' '}
                    <span className="font-medium text-foreground">{user.firstName}</span>
                  </p>
                </div>
              )}

              {loading ? (
                <div className="space-y-3">
                  {[1, 2].map((i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-lg border p-4 animate-pulse"
                    >
                      <div className="size-10 rounded-lg bg-muted shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 bg-muted rounded w-3/4" />
                        <div className="h-3 bg-muted rounded w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : companies.length === 0 ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-dashed border-amber-500/20 bg-amber-500/5 p-4 text-center">
                    <p className="text-sm text-amber-600 dark:text-amber-400 font-medium">
                      {t('selectCompany.noCompanies')}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('selectCompany.createFirstCompany')}
                    </p>
                  </div>

                  <form onSubmit={handleCreateCompany} className="space-y-4 pt-2">
                    {error && (
                      <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        {error}
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="create-legalName">{t('selectCompany.companyName')}</Label>
                      <Input
                        id="create-legalName"
                        value={legalName}
                        onChange={(e) => setLegalName(e.target.value)}
                        required
                        autoFocus
                        placeholder="Ej. Mi Negocio S.A."
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="create-taxId">
                        {t('auth.taxId')} ({t('common.optional') || 'Opcional'})
                      </Label>
                      <Input
                        id="create-taxId"
                        value={taxId}
                        onChange={(e) => setTaxId(e.target.value)}
                        placeholder={t('selectCompany.taxIdPlaceholder')}
                      />
                    </div>
                    <Button type="submit" className="w-full mt-2" disabled={creating}>
                      {creating && <Loader2 className="size-4 animate-spin mr-2" />}
                      {t('selectCompany.createCompanyBtn')}
                    </Button>
                  </form>
                </div>
              ) : (
                <div className="space-y-2">
                  {companies.map((company, i) => (
                    <motion.button
                      key={company.id}
                      autoFocus={i === 0}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.08, duration: 0.3 }}
                      onClick={() => handleSelectCompany(company)}
                      className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent hover:border-primary/50 group"
                    >
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/20 overflow-hidden">
                        {company.logo ? (
                          <img src={company.logo} alt="Logo" className="size-full object-cover" />
                        ) : (
                          <Building2 className="size-5 text-primary" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{company.legalName}</p>
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

              {user?.role === 'super_admin' && (
                <div className="mt-6 pt-4 border-t border-dashed border-border">
                  <button
                    onClick={() => setCurrentView('admin-dashboard')}
                    className="flex w-full items-center gap-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 hover:bg-indigo-500/10 dark:border-indigo-400/20 dark:bg-indigo-400/5 dark:hover:bg-indigo-400/10 p-4 text-left transition-all duration-300 group hover:shadow-lg hover:shadow-indigo-500/5 hover:border-indigo-500/40 cursor-pointer"
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 group-hover:scale-105 transition-transform duration-300">
                      <Building2 className="size-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm text-indigo-600 dark:text-indigo-400">
                        {t('selectCompany.adminConsole')}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('selectCompany.adminConsoleDesc')}
                      </p>
                    </div>
                    <ChevronRight className="size-4 text-indigo-500/60 group-hover:text-indigo-500 group-hover:translate-x-1 transition-all" />
                  </button>
                </div>
              )}

              <div className="pt-4 border-t">
                <Button variant="outline" size="sm" className="w-full gap-2" onClick={handleLogout}>
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
            &copy; {new Date().getFullYear()} {t('common.appName')}. {t('landing.copyright')}
          </p>
        </div>
      </footer>
    </div>
  );
}
