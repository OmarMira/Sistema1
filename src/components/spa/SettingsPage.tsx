'use client';

import { useState, useEffect } from 'react';
import {
  Save,
  Key,
  User,
  Building2,
  Shield,
  AlertTriangle,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { formatDate } from '@/lib/format';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Settings Page ───────────────────────────────────────────── */

export function SettingsPage() {
  const t = useLanguageStore((s) => s.t);
  const user = useAuthStore((s) => s.user);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);

  const initials = user
    ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()
    : '??';

  // Company settings state
  const [companyData, setCompanyData] = useState({
    legalName: '',
    taxId: '',
    address: '',
    phone: '',
    email: '',
  });
  const [editingCompany, setEditingCompany] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);
  const [companySaved, setCompanySaved] = useState(false);

  // Password state
  const [passwords, setPasswords] = useState({
    current: '',
    new: '',
    confirm: '',
  });
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);

  // Stats
  const [stats, setStats] = useState<{ memberCount: number; accountCount: number; periodCount: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const companyId = activeCompany?.id;

  // Fetch settings
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/settings?companyId=${companyId}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (data.company) {
            setCompanyData({
              legalName: data.company.legalName || '',
              taxId: data.company.taxId || '',
              address: data.company.address || '',
              phone: data.company.phone || '',
              email: data.company.email || '',
            });
          }
          if (data.stats) {
            setStats(data.stats);
          }
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  async function handleSaveCompany() {
    if (!activeCompany?.id) return;
    setSavingCompany(true);
    setCompanySaved(false);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: activeCompany.id, ...companyData }),
      });
      if (res.ok) {
        setCompanySaved(true);
        setEditingCompany(false);
        // Update active company name in store if it changed
        const data = await res.json();
        if (data.company?.legalName) {
          useAuthStore.getState().setActiveCompany({
            ...activeCompany,
            legalName: data.company.legalName,
          });
        }
        setTimeout(() => setCompanySaved(false), 3000);
      }
    } catch { /* ignore */ }
    setSavingCompany(false);
  }

  async function handleChangePassword() {
    setPasswordError('');
    setPasswordSaved(false);

    if (passwords.new.length < 8) {
      setPasswordError(t('settings.passwordMinLength'));
      return;
    }
    if (passwords.new !== passwords.confirm) {
      setPasswordError(t('settings.passwordMismatch'));
      return;
    }

    setSavingPassword(true);
    try {
      const res = await fetch('/api/settings/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.new,
        }),
      });
      if (res.ok) {
        setPasswordSaved(true);
        setPasswords({ current: '', new: '', confirm: '' });
        setTimeout(() => setPasswordSaved(false), 3000);
      } else {
        const data = await res.json();
        setPasswordError(data.error || t('settings.wrongPassword'));
      }
    } catch {
      setPasswordError(t('common.error'));
    }
    setSavingPassword(false);
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column: User Profile */}
        <motion.div variants={itemVariants} className="lg:col-span-1 space-y-6">
          {/* User Profile Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <User className="size-4" />
                {t('settings.userProfile')}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center text-center space-y-4">
              <Avatar className="size-20">
                <AvatarFallback className="bg-primary/10 text-primary text-2xl font-bold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-lg font-semibold">{user?.firstName} {user?.lastName}</p>
                <p className="text-sm text-muted-foreground">{user?.email}</p>
                <Badge variant="secondary" className="mt-2">
                  {user?.role === 'super_admin' ? t('users.superAdmin') : t('users.companyAdmin')}
                </Badge>
              </div>
              {stats && (
                <div className="grid grid-cols-3 gap-3 w-full pt-2 border-t">
                  <div className="text-center">
                    <p className="text-lg font-bold text-teal-600 dark:text-teal-400">{stats.memberCount}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.memberCount')}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-teal-600 dark:text-teal-400">{stats.accountCount}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.accountCount')}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-teal-600 dark:text-teal-400">{stats.periodCount}</p>
                    <p className="text-xs text-muted-foreground">{t('settings.periodCount')}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Right Column: Settings */}
        <motion.div variants={itemVariants} className="lg:col-span-2 space-y-6">
          {/* Company Information */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="size-4" />
                    {t('settings.companyInfo')}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    {activeCompany?.legalName}
                  </CardDescription>
                </div>
                {!editingCompany && (
                  <Button variant="outline" size="sm" onClick={() => setEditingCompany(true)}>
                    {t('common.edit')}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : editingCompany ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="legalName">{t('settings.legalName')}</Label>
                    <Input
                      id="legalName"
                      value={companyData.legalName}
                      onChange={(e) => setCompanyData((prev) => ({ ...prev, legalName: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="taxId">{t('settings.taxId')}</Label>
                    <Input
                      id="taxId"
                      value={companyData.taxId}
                      onChange={(e) => setCompanyData((prev) => ({ ...prev, taxId: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="companyEmail">{t('settings.email')}</Label>
                    <Input
                      id="companyEmail"
                      type="email"
                      value={companyData.email}
                      onChange={(e) => setCompanyData((prev) => ({ ...prev, email: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="phone">{t('settings.phone')}</Label>
                    <Input
                      id="phone"
                      value={companyData.phone}
                      onChange={(e) => setCompanyData((prev) => ({ ...prev, phone: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="address">{t('settings.address')}</Label>
                    <Input
                      id="address"
                      value={companyData.address}
                      onChange={(e) => setCompanyData((prev) => ({ ...prev, address: e.target.value }))}
                    />
                  </div>
                  <div className="flex gap-2 sm:col-span-2">
                    <Button onClick={handleSaveCompany} disabled={savingCompany}>
                      {savingCompany ? (
                        <><Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}</>
                      ) : (
                        <><Save className="size-4 mr-1" /> {t('common.save')}</>
                      )}
                    </Button>
                    <Button variant="outline" onClick={() => { setEditingCompany(false); fetchSettings(); }}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <InfoRow label={t('settings.legalName')} value={companyData.legalName} />
                  <InfoRow label={t('settings.taxId')} value={companyData.taxId || '—'} />
                  <InfoRow label={t('settings.email')} value={companyData.email || '—'} />
                  <InfoRow label={t('settings.phone')} value={companyData.phone || '—'} />
                  <InfoRow label={t('settings.address')} value={companyData.address || '—'} fullWidth />
                  {companySaved && (
                    <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 sm:col-span-2">
                      <CheckCircle2 className="size-4" />
                      {t('settings.companyUpdated')}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Account Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Key className="size-4" />
                {t('settings.changePassword')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="currentPassword">{t('settings.currentPassword')}</Label>
                  <Input
                    id="currentPassword"
                    type="password"
                    value={passwords.current}
                    onChange={(e) => setPasswords((prev) => ({ ...prev, current: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="newPassword">{t('settings.newPassword')}</Label>
                  <Input
                    id="newPassword"
                    type="password"
                    value={passwords.new}
                    onChange={(e) => setPasswords((prev) => ({ ...prev, new: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="confirmPassword">{t('settings.confirmPassword')}</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={passwords.confirm}
                    onChange={(e) => setPasswords((prev) => ({ ...prev, confirm: e.target.value }))}
                  />
                </div>
                {passwordError && (
                  <p className="text-sm text-rose-600 dark:text-rose-400">{passwordError}</p>
                )}
                {passwordSaved && (
                  <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-4" />
                    {t('settings.passwordChanged')}
                  </p>
                )}
                <div>
                  <Button onClick={handleChangePassword} disabled={savingPassword || !passwords.current || !passwords.new || !passwords.confirm}>
                    {savingPassword ? (
                      <><Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}</>
                    ) : (
                      <><Key className="size-4 mr-1" /> {t('settings.changePassword')}</>
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Preferences */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('settings.general')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t('settings.language')}</Label>
                  <Select value={language} onValueChange={(v) => setLanguage(v as 'en' | 'es')}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="es">Español</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t('settings.theme')}</Label>
                  <Select defaultValue="system">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">{t('settings.light')}</SelectItem>
                      <SelectItem value="dark">{t('settings.dark')}</SelectItem>
                      <SelectItem value="system">{t('settings.system')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Danger Zone */}
          <Card className="border-rose-200 dark:border-rose-900">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2 text-rose-600 dark:text-rose-400">
                <AlertTriangle className="size-4" />
                {t('settings.dangerZone')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-3">{t('settings.deactivateWarning')}</p>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <Shield className="size-4 mr-1" />
                    {t('settings.deactivateAccount')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('settings.deactivateConfirm')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('settings.deactivateWarning')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                      {t('settings.deactivateAccount')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </motion.div>
  );
}

/* ─── Helper Component ────────────────────────────────────────── */

function InfoRow({ label, value, fullWidth = false }: { label: string; value: string; fullWidth?: boolean }) {
  return (
    <div className={fullWidth ? 'sm:col-span-2' : ''}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
