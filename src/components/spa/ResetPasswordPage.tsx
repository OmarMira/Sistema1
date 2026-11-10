'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguageStore } from '@/store/language-store';

/**
 * Reset form reached from the email link. The token is read from the URL and
 * checked once so the user sees "this link expired" before typing a password,
 * instead of failing afterwards.
 */
export function ResetPasswordPage() {
  const t = useLanguageStore((s) => s.t);
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState(false);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('token') ?? '';
    setToken(value);
    if (!value) {
      setChecking(false);
      return;
    }
    fetch(`/api/auth/reset-password/validate?token=${encodeURIComponent(value)}`, {
      credentials: 'include',
    })
      .then((res) => res.json())
      .then((data) => setValid(Boolean(data?.valid)))
      .catch(() => setValid(false))
      .finally(() => setChecking(false));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setMessage('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('auth.resetInvalid'));
        return;
      }
      setMessage(data.message || t('auth.resetDone'));
      setPassword('');
      setValid(false);
    } catch {
      setError(t('common.error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('auth.resetTitle')}</CardTitle>
          <CardDescription>{t('auth.resetSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {checking ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('auth.resetChecking')}
            </p>
          ) : message ? (
            <p className="text-sm text-muted-foreground">{message}</p>
          ) : !valid ? (
            <p className="text-sm text-destructive">{t('auth.resetInvalid')}</p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new-password">{t('auth.resetNewPassword')}</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                  autoComplete="new-password"
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {t('auth.resetSubmit')}
              </Button>
            </form>
          )}
          {error && !valid && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
