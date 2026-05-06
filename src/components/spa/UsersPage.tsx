'use client';

import { useState, useEffect } from 'react';
import {
  Users,
  UserPlus,
  Shield,
  Mail,
  Calendar,
  Loader2,
  CheckCircle2,
  X,
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
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/* ─── Types ───────────────────────────────────────────────────── */

interface UserRecord {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  role: string;
  isActive: boolean;
  companyRole: string;
  joinedAt: string;
  createdAt: string;
}

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Users Page ──────────────────────────────────────────────── */

export function UsersPage() {
  const t = useLanguageStore((s) => s.t);
  const user = useAuthStore((s) => s.user);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);

  // Invite form state
  const [inviteForm, setInviteForm] = useState({
    email: '',
    firstName: '',
    lastName: '',
    password: '',
  });

  // Check admin access
  const companyId = activeCompany?.id;
  const isAdmin = user?.role === 'super_admin' || user?.role === 'company_admin';

  useEffect(() => {
    if (!isAdmin) {
      // Defer setState to avoid synchronous setState in effect
      const id = requestAnimationFrame(() => {
        setAccessDenied(true);
        setLoading(false);
      });
      return () => cancelAnimationFrame(id);
    }
    if (!companyId) {
      const id = requestAnimationFrame(() => setLoading(false));
      return () => cancelAnimationFrame(id);
    }
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/users?companyId=${companyId}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setUsers(data.users || []);
        } else if (res.status === 403 && !cancelled) {
          setAccessDenied(true);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId, isAdmin]);

  async function handleInvite() {
    if (!activeCompany?.id) return;
    setInviteError('');
    setInviting(true);
    setInviteSuccess(false);

    if (!inviteForm.email || !inviteForm.firstName || !inviteForm.lastName || !inviteForm.password) {
      setInviteError('All fields are required.');
      setInviting(false);
      return;
    }

    if (inviteForm.password.length < 8) {
      setInviteError(t('settings.passwordMinLength'));
      setInviting(false);
      return;
    }

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          ...inviteForm,
        }),
      });
      if (res.ok) {
        setInviteSuccess(true);
        setInviteForm({ email: '', firstName: '', lastName: '', password: '' });
        fetchUsers();
        setTimeout(() => {
          setInviteSuccess(false);
          setInviteOpen(false);
        }, 1500);
      } else {
        const data = await res.json();
        setInviteError(data.error || 'Failed to create user.');
      }
    } catch {
      setInviteError(t('common.error'));
    }
    setInviting(false);
  }

  if (accessDenied) {
    return (
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="space-y-6"
      >
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Shield className="size-12 text-muted-foreground/30 mb-3" />
          <h2 className="text-xl font-semibold">{t('users.accessDenied')}</h2>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('users.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {users.length} {t('settings.memberCount').toLowerCase()}
          </p>
        </div>
        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlus className="size-4 mr-1" />
              {t('users.inviteUser')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('users.inviteTitle')}</DialogTitle>
              <DialogDescription>{t('users.inviteDesc')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="inv-firstName">{t('users.firstName')}</Label>
                  <Input
                    id="inv-firstName"
                    value={inviteForm.firstName}
                    onChange={(e) => setInviteForm((prev) => ({ ...prev, firstName: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="inv-lastName">{t('users.lastName')}</Label>
                  <Input
                    id="inv-lastName"
                    value={inviteForm.lastName}
                    onChange={(e) => setInviteForm((prev) => ({ ...prev, lastName: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-email">{t('users.email')}</Label>
                <Input
                  id="inv-email"
                  type="email"
                  value={inviteForm.email}
                  onChange={(e) => setInviteForm((prev) => ({ ...prev, email: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="inv-password">{t('users.password')}</Label>
                <Input
                  id="inv-password"
                  type="password"
                  value={inviteForm.password}
                  onChange={(e) => setInviteForm((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="Min. 8 characters"
                />
              </div>
              {inviteError && (
                <p className="text-sm text-rose-600 dark:text-rose-400">{inviteError}</p>
              )}
              {inviteSuccess && (
                <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-4" />
                  {t('users.userCreated')}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInviteOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleInvite} disabled={inviting || inviteSuccess}>
                {inviting ? (
                  <><Loader2 className="size-4 mr-1 animate-spin" /> {t('settings.saving')}</>
                ) : (
                  <><UserPlus className="size-4 mr-1" /> {t('users.inviteUser')}</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </motion.div>

      {/* Users Table */}
      <motion.div variants={itemVariants}>
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-6 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : users.length > 0 ? (
              <div className="rounded-md overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('common.name')}</TableHead>
                      <TableHead>{t('users.email')}</TableHead>
                      <TableHead>{t('users.role')}</TableHead>
                      <TableHead className="hidden md:table-cell">{t('users.joinedAt')}</TableHead>
                      <TableHead>{t('users.status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="size-8">
                              <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                                {`${u.firstName?.[0] ?? ''}${u.lastName?.[0] ?? ''}`.toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <span className="font-medium">{u.fullName}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Mail className="size-3" />
                            {u.email}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className={
                            u.role === 'super_admin'
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                              : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                          }>
                            {u.role === 'super_admin' ? t('users.superAdmin') : t('users.companyAdmin')}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Calendar className="size-3" />
                            {formatDate(u.joinedAt)}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={u.isActive ? 'default' : 'secondary'} className={
                            u.isActive
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                              : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                          }>
                            {u.isActive ? t('users.active') : t('users.inactive')}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Users className="size-12 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground">{t('users.noUsers')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
