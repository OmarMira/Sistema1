'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type User } from '@/store/auth-store';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

export function RegisterPage() {
  const t = useLanguageStore((s) => s.t);
  const { login, setCurrentView } = useAuthStore();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [entityType, setEntityType] = useState<'BUSINESS' | 'INDIVIDUAL'>('BUSINESS');
  const [taxId, setTaxId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }

    if (password.length < 8) {
      setError(t('register.passwordMin'));
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          password,
          companyName,
          entityType,
          taxId: taxId || null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t('common.error'));
        return;
      }

      // Auto-login on success
      const user: User = data.user;
      const companies = data.companies || [];

      login(user);

      if (companies.length > 0) {
        useAuthStore.getState().setActiveCompany(companies[0]);
      }
      setCurrentView('dashboard');
    } catch {
      setError(t('common.error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <button
            onClick={() => setCurrentView('landing')}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
              AE
            </div>
            <span className="text-lg font-semibold tracking-tight">{t('common.appName')}</span>
          </button>
          <div className="flex items-center gap-1">
            <LanguageSelector />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Register form */}
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <Card className="w-full max-w-lg">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">{t('auth.createAccount')}</CardTitle>
            <CardDescription>{t('register.subtitle')}</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              {error && (
                <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              {/* Name row */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="firstName">{t('auth.firstName')}</Label>
                  <Input
                    id="firstName"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                    autoComplete="given-name"
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">{t('auth.lastName')}</Label>
                  <Input
                    id="lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                    autoComplete="family-name"
                  />
                </div>
              </div>

              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="reg-email">{t('auth.email')}</Label>
                <Input
                  id="reg-email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>

              {/* Passwords */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="reg-password">{t('auth.password')}</Label>
                  <Input
                    id="reg-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    minLength={8}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">{t('auth.confirmPassword')}</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    minLength={8}
                  />
                </div>
              </div>

              {/* Company info */}
              <div className="space-y-2">
                <Label htmlFor="companyName">{t('auth.companyName')}</Label>
                <Input
                  id="companyName"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                  placeholder="Acme Corp"
                />
              </div>

              <div className="space-y-2">
                <Label>{t('auth.entityType')}</Label>
                <RadioGroup
                  value={entityType}
                  onValueChange={(v) => setEntityType(v as 'BUSINESS' | 'INDIVIDUAL')}
                  className="flex gap-4"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="BUSINESS" id="entity-business" />
                    <Label htmlFor="entity-business" className="font-normal cursor-pointer">
                      {t('auth.business')}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="INDIVIDUAL" id="entity-individual" />
                    <Label htmlFor="entity-individual" className="font-normal cursor-pointer">
                      {t('auth.individual')}
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              <div className="space-y-2">
                <Label htmlFor="taxId">
                  {t('auth.taxId')}{' '}
                  <span className="text-muted-foreground font-normal">
                    ({t('register.optional')})
                  </span>
                </Label>
                <Input
                  id="taxId"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                  placeholder="12-3456789"
                  autoComplete="off"
                />
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-4">
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="size-4 animate-spin" />}
                {t('auth.register')}
              </Button>
              <p className="text-sm text-muted-foreground">
                {t('auth.hasAccount')}{' '}
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => setCurrentView('login')}
                >
                  {t('auth.login')}
                </button>
              </p>
            </CardFooter>
          </form>
        </Card>
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
